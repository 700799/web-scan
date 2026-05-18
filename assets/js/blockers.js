/* ===========================================================
 * SERPSCOPE — Detailed Blocker Enumeration
 *
 * Takes parsed Lighthouse output (mobile + desktop) plus the
 * client-side signal pack from analyzer.js and produces a
 * single deduplicated list of every blocker — with severity,
 * savings (bytes/ms), affected elements, and remediation steps.
 *
 * Each blocker:
 *   {
 *     id, category, severity (P0-P3), title, description,
 *     fix, steps[], savings: { ms, bytes, scoreLoss },
 *     elements: [{ selector, snippet, url, size }],
 *     device: 'mobile' | 'desktop' | 'both',
 *     source: 'lighthouse' | 'heuristic'
 *   }
 * =========================================================== */

(function (global) {
  'use strict';

  // Severity rules for Lighthouse opportunity audits.
  // P0 if huge savings, P3 if marginal. Adjusted by category.
  function severityFromSavings(ms, bytes, score) {
    if (ms >= 1500 || bytes >= 500_000) return 'P0';
    if (ms >= 500 || bytes >= 150_000 || score < 0.3) return 'P1';
    if (ms >= 150 || bytes >= 50_000 || score < 0.6) return 'P2';
    return 'P3';
  }

  // Map opportunity/diagnostic IDs to a category for the UI
  function categoryFor(id) {
    if (/^(uses-|render-|unused-|modern-image|legacy-javascript|duplicated|preload|preconnect|font-display|server-response|http2|long-cache|efficient-animated|total-byte|dom-size|mainthread|bootup|long-tasks|third-party|critical-request|network-rtt|network-server-latency|redirects)/.test(id)) return 'Performance';
    if (/^(viewport|tap-targets|font-size|responsive-images|unsized-images|image-aspect|image-size)/.test(id)) return 'Mobile';
    if (/^(color-contrast|aria-|button-name|label|link-name|frame-title|heading-order|html-has-lang|html-lang|object-alt|duplicate-id)/.test(id)) return 'Accessibility';
    if (/^(meta-description|document-title|crawlable|robots-txt|hreflang|canonical|link-text|plugins|image-alt|structured-data|http-status|is-crawlable)/.test(id)) return 'SEO';
    if (/^(is-on-https|passive-event|vulnerable|deprecat|errors-in-console|inspector|charset|notification)/.test(id)) return 'Best Practices';
    return 'Performance';
  }

  // Build a human-readable fix recommendation for a known audit ID.
  const FIX_BOOK = {
    'render-blocking-resources': {
      fix: 'Eliminate render-blocking CSS/JS. Inline critical CSS, defer non-critical CSS via media swap, and add defer/async to non-critical scripts.',
      steps: [
        'Identify above-the-fold critical CSS (e.g. Critters, Critical, PurgeCSS)',
        'Inline that CSS in <head>, lazy-load the rest with rel="preload" media swap',
        'Add defer or async to non-critical <script> tags',
        'Remove or self-host blocking 3rd-party scripts',
      ],
    },
    'unused-css-rules': {
      fix: 'Strip unused CSS rules — they\'re downloaded, parsed, and never used. Tree-shake at build time and split per-route.',
      steps: [
        'Run PurgeCSS / UnCSS / Tailwind JIT against production HTML',
        'Code-split CSS per route or component',
        'Move below-the-fold component styles to lazy-loaded chunks',
      ],
    },
    'unused-javascript': {
      fix: 'Reduce JavaScript payload. Tree-shake, code-split per route, and remove unused dependencies.',
      steps: [
        'Audit bundle with Webpack Bundle Analyzer / source-map-explorer',
        'Replace heavy libraries with lighter alternatives (moment → date-fns/dayjs, lodash → individual fns)',
        'Code-split per route with dynamic import()',
        'Defer or remove analytics/tag-manager scripts below the fold',
      ],
    },
    'uses-optimized-images': {
      fix: 'Compress raster images — most JPEGs/PNGs are sent at 2–5× optimal weight.',
      steps: [
        'Run a build-time image optimizer (sharp, imagemin, squoosh)',
        'Target ~85 quality for JPEG, palette PNG where suitable',
        'Generate WebP/AVIF variants and serve via <picture> or Cloudinary/Imgix',
      ],
    },
    'modern-image-formats': {
      fix: 'Serve images in WebP or AVIF — typically 25–50% smaller than JPEG/PNG at equal visual quality.',
      steps: [
        'Generate WebP/AVIF variants at build time',
        'Use <picture> with type fallbacks, or a CDN that auto-negotiates',
        'Update <img> srcset to include modern formats first',
      ],
    },
    'uses-webp-images': {
      fix: 'Convert eligible images to WebP. Browser support is now >97%.',
      steps: ['Batch-convert with cwebp or sharp', 'Serve via <picture> with .jpg/.png fallback'],
    },
    'uses-text-compression': {
      fix: 'Enable Brotli or gzip on text responses (HTML/CSS/JS/SVG/JSON). Typical savings: 70–90% on text payloads.',
      steps: [
        'Enable Brotli at the CDN edge (Cloudflare/Fastly/CloudFront)',
        'Verify Content-Encoding: br in response headers',
        'Pre-compress static assets at build time for max compression',
      ],
    },
    'uses-responsive-images': {
      fix: 'Serve images sized for the viewport. Mobile users are downloading desktop-sized images.',
      steps: [
        'Add srcset + sizes to every <img>',
        'Generate multiple width variants at build time (e.g. 400w/800w/1200w)',
        'Use <picture> + media queries for art-direction',
      ],
    },
    'preload-lcp-image': {
      fix: 'Preload the LCP image so it starts downloading before HTML parsing completes.',
      steps: [
        'Identify the LCP element',
        'Add <link rel="preload" as="image" href="..." imagesrcset="..." imagesizes="..."> in <head>',
        'Verify LCP element is NOT lazy-loaded',
      ],
    },
    'lcp-lazy-loaded': {
      fix: 'Remove loading="lazy" from the LCP image — it delays the largest paint substantially.',
      steps: [
        'Locate the LCP element in DOM',
        'Remove loading="lazy" (and fetchpriority="low" if set)',
        'Optionally add fetchpriority="high"',
      ],
    },
    'efficient-animated-content': {
      fix: 'Replace animated GIFs with MP4 or WebM video — typically 80–95% smaller.',
      steps: [
        'Convert GIFs with ffmpeg to MP4 (h264) or WebM (vp9)',
        'Embed with <video autoplay muted loop playsinline>',
      ],
    },
    'duplicated-javascript': {
      fix: 'Deduplicate libraries shipped multiple times across bundles.',
      steps: [
        'Audit with bundle analyzer',
        'Hoist common deps to a shared chunk (Webpack splitChunks)',
        'Pin versions across packages to enable hoisting',
      ],
    },
    'legacy-javascript': {
      fix: 'Stop shipping ES5/transpiled polyfills to modern browsers. Use module/nomodule pattern or differential serving.',
      steps: [
        'Set browserslist to modern targets',
        'Output both ESM (modern) and legacy bundles',
        'Use <script type="module"> + nomodule fallback',
      ],
    },
    'uses-rel-preconnect': {
      fix: 'Preconnect to critical third-party origins so DNS + TLS handshake happens earlier.',
      steps: [
        'Identify 3rd-party origins used above the fold (fonts, analytics, CDN)',
        'Add <link rel="preconnect" href="https://..."> in <head>',
        'Limit to 3–4 origins — preconnect is expensive',
      ],
    },
    'uses-rel-preload': {
      fix: 'Preload key resources (fonts, hero images, critical JS) discovered late in the document.',
      steps: [
        'Identify critical resources blocked behind CSS/JS parsing',
        'Add <link rel="preload" as="font|image|style|script">',
        'For fonts, add crossorigin attribute',
      ],
    },
    'font-display': {
      fix: 'Set font-display: swap (or optional) so text renders immediately with fallback while web fonts load.',
      steps: [
        'Add font-display: swap to all @font-face declarations',
        'For critical fonts, preload them and use optional for less-critical',
      ],
    },
    'redirects': {
      fix: 'Eliminate redirect chains. Every hop costs a full round-trip.',
      steps: [
        'Use server-side rewrites instead of redirects where possible',
        'Update internal links to the final URL',
        'Collapse www↔apex chains to a single 301',
      ],
    },
    'uses-http2': {
      fix: 'Serve over HTTP/2 or HTTP/3 — multiplexing dramatically reduces head-of-line blocking.',
      steps: [
        'Enable HTTP/2 at the load balancer / CDN',
        'Prefer HTTP/3 (QUIC) on Cloudflare/Fastly for further gains',
      ],
    },
    'uses-long-cache-ttl': {
      fix: 'Set far-future cache headers on hashed static assets so returning visitors avoid revalidation.',
      steps: [
        'Add Cache-Control: public, max-age=31536000, immutable to hashed assets',
        'Use content-hashed filenames in build output',
      ],
    },
    'server-response-time': {
      fix: 'Reduce TTFB. Most of LCP is gated by how fast your origin responds.',
      steps: [
        'Cache HTML at the edge (CDN or service worker)',
        'Move dynamic work behind streaming SSR',
        'Profile slow DB queries; add indexes / caching',
      ],
    },
    'total-byte-weight': {
      fix: 'Reduce total page weight. Each KB on mobile = ~15ms on slow networks.',
      steps: [
        'Compress images & text assets',
        'Code-split JS/CSS per route',
        'Defer non-critical third parties',
      ],
    },
    'dom-size': {
      fix: 'Trim DOM size — large DOMs slow style/layout and memory.',
      steps: [
        'Virtualize long lists (react-window, lit-virtualizer, intersection observer)',
        'Render below-the-fold sections on demand',
        'Remove deeply nested wrappers',
      ],
    },
    'mainthread-work-breakdown': {
      fix: 'Reduce main-thread JavaScript work. Move expensive computation to Web Workers and break long tasks.',
      steps: [
        'Identify hot scripts via the breakdown',
        'Move parsing/encoding/crypto to Workers',
        'Break tasks >50ms using requestIdleCallback / scheduler.yield',
      ],
    },
    'bootup-time': {
      fix: 'Reduce JavaScript bootup time. Most of TBT comes from parsing+executing JS during initial load.',
      steps: [
        'Defer or remove non-critical scripts',
        'Code-split per route; lazy-load components below the fold',
        'Tree-shake; replace heavy libraries',
      ],
    },
    'third-party-summary': {
      fix: 'Audit third-party scripts. They typically contribute 30–50% of mobile TBT.',
      steps: [
        'List every 3rd-party tag and challenge its business value',
        'Defer or lazy-load (Partytown for some)',
        'Self-host fonts and analytics where possible',
      ],
    },
    'long-tasks': {
      fix: 'Break long main-thread tasks (>50ms). They block input responsiveness and inflate TBT/INP.',
      steps: [
        'Use the breakdown to find offending scripts',
        'Split work using setTimeout/requestIdleCallback boundaries',
        'Move CPU work to Web Workers',
      ],
    },
    'tap-targets': {
      fix: 'Make touch targets at least 48×48 CSS px with 8 px spacing — current ones are too small or too close together.',
      steps: [
        'Audit listed tap targets',
        'Increase padding / hit-area to ≥ 48 × 48 px',
        'Add min 8 px gap between adjacent targets',
      ],
    },
    'font-size': {
      fix: 'Use ≥ 12 px (preferably 16 px) for body text on mobile to avoid forcing users to zoom.',
      steps: [
        'Set body font-size to at least 16px (use rem-based scaling)',
        'Audit any text below 12px and bump up',
      ],
    },
    'viewport': {
      fix: 'Add a responsive viewport meta tag so mobile browsers use the device width.',
      steps: ['Add <meta name="viewport" content="width=device-width, initial-scale=1"> in <head>'],
    },
    'unsized-images': {
      fix: 'Add explicit width + height (or aspect-ratio CSS) to images so the browser can reserve space — reduces CLS.',
      steps: [
        'Add width="..." height="..." attributes to every <img>',
        'Or set aspect-ratio in CSS (modern browsers handle this beautifully)',
      ],
    },
    'image-aspect-ratio': {
      fix: 'Display image at its natural aspect ratio. Stretched images degrade visual quality and ranking.',
      steps: ['Match displayed aspect-ratio to source', 'Use object-fit:cover when art-direction differs'],
    },
    'color-contrast': {
      fix: 'Increase color contrast to at least WCAG AA (4.5:1 for body text, 3:1 for large text).',
      steps: ['Use a contrast checker on flagged pairs', 'Darken text / lighten backgrounds until ratio passes'],
    },
    'meta-description': {
      fix: 'Add a unique 140–160 character meta description with the primary keyword + CTA.',
      steps: ['Add <meta name="description" content="..."> in <head>'],
    },
    'document-title': {
      fix: 'Add a 50–60 character <title> with the primary keyword leading.',
      steps: ['Add or rewrite <title>'],
    },
    'link-text': {
      fix: 'Replace generic anchor text ("click here", "read more") with descriptive text that conveys destination.',
      steps: ['Audit anchors flagged', 'Rewrite to describe target content'],
    },
    'crawlable-anchors': {
      fix: 'Make all clickable elements actual <a href> anchors. JS-only onclick handlers are invisible to crawlers.',
      steps: ['Replace clickable <div> / <span> with <a href="...">'],
    },
    'is-on-https': {
      fix: 'Migrate to HTTPS. Browsers warn, and HTTPS is a ranking signal.',
      steps: ['Provision TLS certificate (Let\'s Encrypt is free)', '301 redirect HTTP→HTTPS', 'Update internal links + sitemaps'],
    },
    'errors-in-console': {
      fix: 'Resolve console errors. They often indicate broken functionality and undermine trust signals.',
      steps: ['Open DevTools and reproduce', 'Fix or suppress legitimate exceptions'],
    },
    'image-alt': {
      fix: 'Add descriptive alt text to all content images. Use alt="" for purely decorative ones.',
      steps: ['List flagged images', 'Write 5–12 word descriptions or empty alt for decoration'],
    },
    'canonical': {
      fix: 'Add a self-referential rel="canonical" pointing to the preferred URL form.',
      steps: ['Add <link rel="canonical" href="..."> in <head>'],
    },
    'robots-txt': {
      fix: 'Publish a valid robots.txt with sitemap reference.',
      steps: ['Create robots.txt at the domain root', 'Add Sitemap: directive', 'Disallow staging/admin paths'],
    },
    'hreflang': {
      fix: 'Add hreflang annotations if you serve multiple locales — prevents duplicate-content issues.',
      steps: ['Add <link rel="alternate" hreflang="..." href="..."> for each locale', 'Include x-default'],
    },
    'http-status-code': {
      fix: 'Return 200 OK for successful pages. Non-200 codes block indexing.',
      steps: ['Check server logs', 'Fix routing / origin status'],
    },
    'structured-data': {
      fix: 'Add JSON-LD structured data for rich result eligibility.',
      steps: ['Pick schema.org types (Organization, WebSite, BreadcrumbList, …)', 'Validate via Rich Results Test'],
    },
  };

  function fmtBytes(n) {
    if (!n) return '0 B';
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1024 / 1024).toFixed(2) + ' MB';
  }
  function fmtMs(n) {
    if (n == null) return '';
    if (n < 1000) return Math.round(n) + ' ms';
    return (n / 1000).toFixed(2) + ' s';
  }

  // Convert a Lighthouse audit item to a normalized element record.
  function normalizeItem(item) {
    const out = { selector: '', snippet: '', url: '', size: 0, label: '' };
    if (item.node) {
      out.selector = item.node.selector || item.node.path || '';
      out.snippet = item.node.snippet || '';
      out.label = item.node.nodeLabel || '';
    }
    if (item.url) out.url = item.url;
    if (item.source) out.source = item.source;
    if (typeof item.wastedBytes === 'number') out.size = item.wastedBytes;
    if (typeof item.totalBytes === 'number') out.totalBytes = item.totalBytes;
    if (typeof item.wastedMs === 'number') out.wastedMs = item.wastedMs;
    if (typeof item.duration === 'number') out.duration = item.duration;
    if (typeof item.transferSize === 'number') out.size = item.transferSize;
    return out;
  }

  // Take parsed strategy (mobile or desktop) and return blockers.
  function fromLighthouseStrategy(strategy, deviceLabel) {
    if (!strategy) return [];
    const out = [];

    strategy.opportunities.forEach((o) => {
      const sev = severityFromSavings(o.savingsMs, o.savingsBytes, o.score);
      const fb = FIX_BOOK[o.id] || {};
      out.push({
        id: o.id,
        category: categoryFor(o.id),
        severity: sev,
        title: o.title,
        description: o.description,
        fix: fb.fix || o.title,
        steps: fb.steps || [],
        savings: { ms: o.savingsMs || 0, bytes: o.savingsBytes || 0, scoreLoss: Math.max(0, 1 - (o.score || 0)) },
        elements: (o.items || []).slice(0, 12).map(normalizeItem),
        device: deviceLabel,
        source: 'lighthouse',
        displayValue: o.displayValue,
      });
    });

    strategy.diagnostics.forEach((d) => {
      // Lower severity baseline since these don't carry direct savings.
      let sev = 'P3';
      if (/render|block|critical|lcp|cls|inp|tbt|console-errors|crawl|http-status|noindex|viewport/i.test(d.id)) sev = 'P2';
      if (d.score === 0) sev = 'P1';
      const fb = FIX_BOOK[d.id] || {};
      out.push({
        id: d.id,
        category: categoryFor(d.id),
        severity: sev,
        title: d.title,
        description: d.description,
        fix: fb.fix || d.title,
        steps: fb.steps || [],
        savings: { ms: 0, bytes: 0, scoreLoss: Math.max(0, 1 - (d.score || 0)) },
        elements: (d.items || []).slice(0, 12).map(normalizeItem),
        device: deviceLabel,
        source: 'lighthouse',
        displayValue: d.displayValue,
      });
    });

    return out;
  }

  // Dedupe blockers: same id appearing on mobile + desktop becomes one
  // with device: 'both' and worst-of merged.
  function mergeAcrossDevices(mobileBlockers, desktopBlockers) {
    const map = new Map();
    function add(b) {
      const existing = map.get(b.id);
      if (!existing) { map.set(b.id, { ...b }); return; }
      // Merge — take worst severity, sum savings, union elements
      const sevOrder = { P0: 0, P1: 1, P2: 2, P3: 3 };
      if (sevOrder[b.severity] < sevOrder[existing.severity]) existing.severity = b.severity;
      existing.savings.ms = Math.max(existing.savings.ms, b.savings.ms);
      existing.savings.bytes = Math.max(existing.savings.bytes, b.savings.bytes);
      const seen = new Set(existing.elements.map((e) => e.selector + '|' + e.url));
      b.elements.forEach((e) => { const k = e.selector + '|' + e.url; if (!seen.has(k)) existing.elements.push(e); });
      existing.device = 'both';
    }
    mobileBlockers.forEach(add);
    desktopBlockers.forEach(add);
    return Array.from(map.values());
  }

  // Heuristic blockers derived from client-side signals (analyzer.js).
  function fromClientHeuristics(signals) {
    const out = [];
    if (signals.isHttps && signals.mixedContent > 0) {
      out.push({
        id: 'heuristic-mixed-content',
        category: 'Best Practices',
        severity: 'P0',
        title: `${signals.mixedContent} mixed-content resources on HTTPS page`,
        description: 'Insecure http:// resources loaded on an HTTPS page — browsers block them and HTTPS guarantees are voided.',
        fix: 'Update all http:// asset URLs to https:// or protocol-relative; self-host any that don\'t support HTTPS.',
        steps: ['grep for http:// in templates and CSS', 'Update to https:// where supported', 'Self-host stragglers'],
        savings: { ms: 0, bytes: 0, scoreLoss: 0.1 },
        elements: [],
        device: 'both',
        source: 'heuristic',
      });
    }
    if (!signals.title || signals.titleLen < 30 || signals.titleLen > 65) {
      // Already covered by Lighthouse SEO, but emit if PSI missing
    }
    return out;
  }

  // Sort blockers by (severity asc, savings.ms desc, savings.bytes desc).
  function sortBlockers(list) {
    const order = { P0: 0, P1: 1, P2: 2, P3: 3 };
    return list.slice().sort((a, b) =>
      order[a.severity] - order[b.severity] ||
      (b.savings.ms || 0) - (a.savings.ms || 0) ||
      (b.savings.bytes || 0) - (a.savings.bytes || 0));
  }

  function enumerate(lhBundle, signals) {
    const mob = lhBundle?.mobile ? fromLighthouseStrategy(lhBundle.mobile, 'mobile') : [];
    const des = lhBundle?.desktop ? fromLighthouseStrategy(lhBundle.desktop, 'desktop') : [];
    const merged = mergeAcrossDevices(mob, des);
    const heur = signals ? fromClientHeuristics(signals) : [];
    return sortBlockers(merged.concat(heur));
  }

  global.SERPSCOPE = global.SERPSCOPE || {};
  global.SERPSCOPE.blockers = { enumerate, sortBlockers, fmtBytes, fmtMs, categoryFor, FIX_BOOK };
})(window);
