/* ===========================================================
 * SERPSCOPE — Lighthouse / PageSpeed Insights deep integration.
 *
 * PSI runs headless Chrome on Google's edge servers — so this
 * module gives us real Lighthouse output without us needing a
 * browser of our own. We fetch BOTH mobile + desktop strategies
 * in parallel across all 5 Lighthouse categories, then extract
 * every audit including details payloads (network requests,
 * critical chains, unused CSS/JS, LCP element, layout shift
 * elements, tap targets, screenshots, filmstrip, etc.).
 *
 * We also pull CrUX (Chrome User Experience Report) field data —
 * real-world Core Web Vitals from actual Chrome users over the
 * trailing 28 days — when available.
 * =========================================================== */

(function (global) {
  'use strict';

  const PSI_ENDPOINT = 'https://www.googleapis.com/pagespeedonline/v5/runPagespeed';
  const ALL_CATS = ['performance', 'accessibility', 'best-practices', 'seo', 'pwa'];

  // Lighthouse audit IDs we always want to extract from `audits`
  // even if they aren't directly grouped by Lighthouse's display.
  const KEY_AUDITS = [
    // Perf — metrics
    'first-contentful-paint', 'largest-contentful-paint', 'speed-index',
    'total-blocking-time', 'cumulative-layout-shift', 'interactive',
    'server-response-time', 'max-potential-fid', 'experimental-interaction-to-next-paint',
    // Perf — opportunities
    'render-blocking-resources', 'unused-css-rules', 'unused-javascript',
    'uses-optimized-images', 'modern-image-formats', 'uses-webp-images',
    'uses-text-compression', 'uses-responsive-images', 'efficient-animated-content',
    'duplicated-javascript', 'legacy-javascript', 'preload-lcp-image',
    'uses-rel-preconnect', 'uses-rel-preload', 'font-display',
    'redirects', 'uses-http2', 'uses-long-cache-ttl',
    // Perf — diagnostics
    'mainthread-work-breakdown', 'bootup-time', 'dom-size', 'critical-request-chains',
    'network-rtt', 'network-server-latency', 'total-byte-weight',
    'third-party-summary', 'third-party-facades', 'lcp-lazy-loaded',
    'layout-shift-elements', 'largest-contentful-paint-element',
    'long-tasks', 'no-document-write', 'non-composited-animations',
    'unsized-images', 'viewport',
    // SEO
    'meta-description', 'document-title', 'http-status-code', 'link-text',
    'crawlable-anchors', 'is-crawlable', 'robots-txt', 'hreflang',
    'canonical', 'font-size', 'plugins', 'tap-targets', 'image-alt',
    'structured-data',
    // Best practices
    'is-on-https', 'uses-passive-event-listeners', 'no-vulnerable-libraries',
    'notification-on-start', 'deprecations', 'errors-in-console',
    'image-aspect-ratio', 'image-size-responsive', 'preload-fonts',
    'inspector-issues', 'charset',
    // Accessibility
    'color-contrast', 'aria-allowed-attr', 'aria-required-attr', 'aria-valid-attr',
    'button-name', 'label', 'link-name', 'form-field-multiple-labels',
    'frame-title', 'heading-order', 'html-has-lang', 'html-lang-valid',
    'meta-viewport', 'object-alt', 'duplicate-id-active',
    // Screenshots / filmstrip
    'final-screenshot', 'screenshot-thumbnails', 'full-page-screenshot',
    // Network
    'network-requests', 'resource-summary',
  ];

  async function fetchPSIStrategy(url, strategy, apiKey) {
    const params = new URLSearchParams();
    params.set('url', url);
    params.set('strategy', strategy);
    ALL_CATS.forEach((c) => params.append('category', c));
    if (apiKey) params.set('key', apiKey);
    // CrUX field data is included by default; we don't need to opt-in.

    const r = await fetch(`${PSI_ENDPOINT}?${params}`);
    if (!r.ok) {
      let msg = `PSI HTTP ${r.status}`;
      try { const j = await r.json(); if (j.error?.message) msg += ': ' + j.error.message; } catch {}
      throw new Error(msg);
    }
    return r.json();
  }

  async function fetchBoth(url, apiKey) {
    const [mobile, desktop] = await Promise.allSettled([
      fetchPSIStrategy(url, 'mobile', apiKey),
      fetchPSIStrategy(url, 'desktop', apiKey),
    ]);
    return {
      mobile: mobile.status === 'fulfilled' ? mobile.value : null,
      desktop: desktop.status === 'fulfilled' ? desktop.value : null,
      mobileError: mobile.status === 'rejected' ? mobile.reason.message : null,
      desktopError: desktop.status === 'rejected' ? desktop.reason.message : null,
    };
  }

  // ── Parse a single strategy's PSI payload ──────────────────
  function parseStrategy(psi, strategy) {
    if (!psi) return null;
    const lh = psi.lighthouseResult;
    if (!lh) return null;

    const audits = lh.audits || {};
    const cats = lh.categories || {};

    const scores = {
      performance: cats.performance ? Math.round((cats.performance.score || 0) * 100) : null,
      accessibility: cats.accessibility ? Math.round((cats.accessibility.score || 0) * 100) : null,
      bestPractices: cats['best-practices'] ? Math.round((cats['best-practices'].score || 0) * 100) : null,
      seo: cats.seo ? Math.round((cats.seo.score || 0) * 100) : null,
      pwa: cats.pwa?.score != null ? Math.round((cats.pwa.score || 0) * 100) : null,
    };

    // Lab metrics
    const metrics = {
      fcp: a(audits['first-contentful-paint']),
      lcp: a(audits['largest-contentful-paint']),
      cls: a(audits['cumulative-layout-shift']),
      tbt: a(audits['total-blocking-time']),
      si: a(audits['speed-index']),
      tti: a(audits['interactive']),
      ttfb: a(audits['server-response-time']),
      inp: a(audits['experimental-interaction-to-next-paint']),
    };

    // Field metrics (CrUX) — origin + loading experience
    const loadingExperience = psi.loadingExperience;
    const originLoadingExperience = psi.originLoadingExperience;
    const field = parseCrux(loadingExperience);
    const originField = parseCrux(originLoadingExperience);

    // Opportunities (savings)
    const opportunities = [];
    Object.values(audits).forEach((au) => {
      if (au.details?.type === 'opportunity' && au.score != null && au.score < 0.9) {
        const ms = au.details?.overallSavingsMs || 0;
        const bytes = au.details?.overallSavingsBytes || 0;
        opportunities.push({
          id: au.id,
          title: au.title,
          description: au.description,
          score: au.score,
          savingsMs: ms,
          savingsBytes: bytes,
          displayValue: au.displayValue,
          items: (au.details.items || []).slice(0, 25),
          headings: au.details.headings || [],
        });
      }
    });
    opportunities.sort((a, b) => (b.savingsMs - a.savingsMs) || (b.savingsBytes - a.savingsBytes));

    // Diagnostics (non-opportunity audits that failed or have details)
    const diagnostics = [];
    Object.values(audits).forEach((au) => {
      if (au.details?.type !== 'opportunity' && au.score != null && au.score < 1 &&
          au.scoreDisplayMode !== 'notApplicable' && au.scoreDisplayMode !== 'informative') {
        diagnostics.push({
          id: au.id,
          title: au.title,
          description: au.description,
          score: au.score,
          displayValue: au.displayValue,
          items: (au.details?.items || []).slice(0, 25),
          headings: au.details?.headings || [],
        });
      }
    });

    // Specific deep extractions
    const lcpElement = audits['largest-contentful-paint-element']?.details?.items?.[0]?.items?.[0] ||
                       audits['largest-contentful-paint-element']?.details?.items?.[0];
    const shiftElements = (audits['layout-shift-elements']?.details?.items || []).slice(0, 10);
    const longTasks = (audits['long-tasks']?.details?.items || []).slice(0, 15);
    const thirdParties = (audits['third-party-summary']?.details?.items || []).slice(0, 12);
    const mainThread = audits['mainthread-work-breakdown']?.details?.items || [];
    const bootup = audits['bootup-time']?.details?.items || [];
    const networkReq = (audits['network-requests']?.details?.items || []);
    const resourceSummary = (audits['resource-summary']?.details?.items || []);
    const criticalChains = audits['critical-request-chains']?.details?.chains || null;

    // Mobile-specific
    const tapTargets = (audits['tap-targets']?.details?.items || []).slice(0, 20);
    const fontSize = audits['font-size']?.details?.items || [];
    const viewport = audits['viewport'];
    const responsiveImages = (audits['uses-responsive-images']?.details?.items || []).slice(0, 20);
    const unsizedImages = (audits['unsized-images']?.details?.items || []).slice(0, 20);

    // Accessibility highlights
    const colorContrast = (audits['color-contrast']?.details?.items || []).slice(0, 20);
    const ariaIssues = ['aria-allowed-attr', 'aria-required-attr', 'aria-valid-attr']
      .map((id) => audits[id])
      .filter((au) => au && au.score != null && au.score < 1)
      .map((au) => ({ id: au.id, title: au.title, items: (au.details?.items || []).slice(0, 10) }));

    // Console errors / inspector
    const consoleErrors = (audits['errors-in-console']?.details?.items || []).slice(0, 10);
    const inspectorIssues = (audits['inspector-issues']?.details?.items || []).slice(0, 10);

    // Screenshots
    const finalScreenshot = audits['final-screenshot']?.details?.data;
    const fullScreenshot = lh.fullPageScreenshot?.screenshot?.data;
    const filmstrip = (audits['screenshot-thumbnails']?.details?.items || []);

    // Network totals
    const totalBytes = audits['total-byte-weight']?.numericValue || 0;
    const domSize = audits['dom-size']?.numericValue || 0;
    const requestCount = networkReq.length;

    return {
      strategy,
      scores,
      metrics,
      field,
      originField,
      opportunities,
      diagnostics,
      lcpElement,
      shiftElements,
      longTasks,
      thirdParties,
      mainThread,
      bootup,
      networkRequests: networkReq.slice(0, 200),
      resourceSummary,
      criticalChains,
      mobile: {
        tapTargets,
        fontSize: fontSize.slice(0, 10),
        viewportPass: viewport?.score === 1,
        responsiveImages,
        unsizedImages,
      },
      a11y: {
        colorContrast,
        ariaIssues,
      },
      bestPractices: {
        consoleErrors,
        inspectorIssues,
      },
      screenshots: {
        final: finalScreenshot,
        full: fullScreenshot,
        filmstrip,
      },
      totals: { totalBytes, domSize, requestCount },
      fetchTime: lh.fetchTime,
      finalUrl: lh.finalUrl || lh.requestedUrl,
      userAgent: lh.userAgent,
    };
  }

  function a(audit) {
    if (!audit) return null;
    return {
      id: audit.id,
      score: audit.score,
      numericValue: audit.numericValue,
      displayValue: audit.displayValue,
      // Buckets — Lighthouse uses scoreDisplayMode + score for color
      bucket: audit.score >= 0.9 ? 'good' : (audit.score >= 0.5 ? 'needs-improvement' : 'poor'),
    };
  }

  function parseCrux(le) {
    if (!le) return null;
    const m = le.metrics || {};
    const pull = (k) => m[k] ? {
      percentile: m[k].percentile,
      distributions: m[k].distributions,
      category: m[k].category,
    } : null;
    return {
      overall: le.overall_category,
      lcp: pull('LARGEST_CONTENTFUL_PAINT_MS'),
      fcp: pull('FIRST_CONTENTFUL_PAINT_MS'),
      cls: pull('CUMULATIVE_LAYOUT_SHIFT_SCORE'),
      inp: pull('INTERACTION_TO_NEXT_PAINT'),
      ttfb: pull('EXPERIMENTAL_TIME_TO_FIRST_BYTE'),
      fid: pull('FIRST_INPUT_DELAY_MS'),
    };
  }

  // ── Master entry ───────────────────────────────────────────
  async function runLighthouse(url, opts = {}) {
    const { apiKey, onProgress } = opts;
    onProgress?.({ msg: 'Lighthouse (mobile) — booting headless Chrome on PSI edge…' });
    const raw = await fetchBoth(url, apiKey);
    onProgress?.({ msg: 'Parsing Lighthouse audits' });
    const mobile = parseStrategy(raw.mobile, 'mobile');
    const desktop = parseStrategy(raw.desktop, 'desktop');
    return {
      url,
      mobile, desktop,
      mobileError: raw.mobileError,
      desktopError: raw.desktopError,
      ok: !!(mobile || desktop),
    };
  }

  global.SERPSCOPE = global.SERPSCOPE || {};
  global.SERPSCOPE.lighthouse = { runLighthouse, parseStrategy };
})(window);
