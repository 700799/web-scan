/* ===========================================================
 * SERPSCOPE — Core SEO Analyzer
 * Fully client-side. Fetches public pages via CORS proxy,
 * extracts ~120 signals, normalizes them 0–100, and scores
 * across On-Page / Technical / Content / Off-Page categories.
 * =========================================================== */

(function (global) {
  'use strict';

  // ── CORS proxies ────────────────────────────────────────────
  // Each proxy is tried in order. We accept that any one of them
  // can rate-limit, time out, or refuse a given upstream — so the
  // fetch layer below transparently retries the next proxy until
  // we get a usable response.
  const PROXIES = {
    allorigins: {
      label: 'allorigins.win',
      build: (u) => `https://api.allorigins.win/raw?url=${encodeURIComponent(u)}`,
      headers: {},
    },
    corsproxy: {
      label: 'corsproxy.io',
      build: (u) => `https://corsproxy.io/?${encodeURIComponent(u)}`,
      headers: {},
    },
    codetabs: {
      label: 'codetabs.com',
      build: (u) => `https://api.codetabs.com/v1/proxy/?quest=${encodeURIComponent(u)}`,
      headers: {},
    },
  };

  // Default fallback order; the user's selected proxy is moved to
  // the front of this list at fetch time. (Direct fetch is intentionally
  // omitted — it almost always trips CORS and spams the console.)
  const PROXY_CHAIN = ['allorigins', 'corsproxy', 'codetabs'];

  // ── Scoring weights ─────────────────────────────────────────
  const WEIGHTS = { onpage: 0.30, technical: 0.30, content: 0.25, offpage: 0.15 };

  // ── Helpers ─────────────────────────────────────────────────
  function normalizeUrl(input) {
    if (!input) return null;
    let u = input.trim();
    if (!u) return null;
    if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
    try { return new URL(u).href; } catch { return null; }
  }

  function domainOf(u) {
    try { return new URL(u).hostname.replace(/^www\./i, ''); } catch { return u; }
  }

  function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }
  function pct(n) { return Math.round(clamp(n, 0, 100)); }

  async function fetchWithTimeout(url, opts = {}, ms = 20000) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), ms);
    try {
      const r = await fetch(url, { ...opts, signal: ctrl.signal });
      clearTimeout(t);
      return r;
    } catch (e) { clearTimeout(t); throw e; }
  }

  function orderedChain(preferred) {
    // Move the user-preferred proxy to the front and keep the rest
    // as fallbacks. `direct` is always last because it usually 404s
    // on CORS, but it's worth a shot for the few sites that allow it.
    const rest = PROXY_CHAIN.filter((k) => k !== preferred);
    return preferred && PROXIES[preferred] ? [preferred, ...rest] : PROXY_CHAIN.slice();
  }

  // Classify why a fetch failed. We retry on transient errors
  // (timeout, 408, 425, 429, 5xx, network) but not on hard 4xx that
  // would just repeat (401, 403, 404).
  function isTransient(status, errMsg) {
    if (status === 408 || status === 425 || status === 429) return true;
    if (status >= 500 && status <= 599) return true;
    if (status === 0 || status == null) return true; // network / aborted
    if (errMsg && /abort|timeout|network|fetch|load failed|cors|tls/i.test(errMsg)) return true;
    return false;
  }

  // Try the proxies in `chain` until one returns a 2xx with a body
  // ≥ minBytes. If only smaller bodies come back, return the largest.
  async function fetchThroughChain(url, chain, opts = {}) {
    const onTry = opts.onTry || (() => {});
    const timeoutMs = opts.timeoutMs || 18000;
    const minBytes = opts.minBytes ?? 100;
    const attempts = [];
    let best = null; // best 2xx response seen so far, by bytes

    for (let i = 0; i < chain.length; i++) {
      const key = chain[i];
      const proxy = PROXIES[key];
      if (!proxy) continue;
      const proxied = proxy.build(url);
      const started = performance.now();
      onTry({ try: i + 1, of: chain.length, proxy: proxy.label, url });
      try {
        const r = await fetchWithTimeout(proxied, { headers: proxy.headers }, timeoutMs);
        const ms = performance.now() - started;
        if (!r.ok) {
          attempts.push({ proxy: proxy.label, status: r.status, ms });
          continue; // try next proxy regardless — different proxies bypass different blockers
        }
        let html = '';
        try { html = await r.text(); } catch (e) {
          attempts.push({ proxy: proxy.label, status: r.status, ms, error: 'body-read' });
          continue;
        }
        attempts.push({ proxy: proxy.label, status: r.status, ms, ok: true, bytes: html.length });
        // Remember the largest valid response we've seen.
        if (!best || html.length > best.html.length) {
          best = { html, status: r.status, ms, via: proxy.label };
        }
        if (html && html.length >= minBytes) {
          return { ok: true, html, status: r.status, ms, via: proxy.label, attempts };
        }
        // body too small — keep trying for a fuller response
      } catch (e) {
        const ms = performance.now() - started;
        const msg = e?.message || String(e);
        attempts.push({ proxy: proxy.label, status: 0, ms, error: msg });
        continue;
      }
    }

    if (best) {
      return { ok: true, html: best.html, status: best.status, ms: best.ms, via: best.via, attempts };
    }
    return { ok: false, status: 0, ms: 0, via: null, attempts, error: 'all proxies failed' };
  }

  async function fetchPage(url, proxyKey = 'allorigins', opts = {}) {
    const chain = orderedChain(proxyKey);
    const res = await fetchThroughChain(url, chain, {
      timeoutMs: 18000,
      minBytes: 100,
      onTry: opts.onTry,
    });
    if (!res.ok) {
      const detail = res.attempts.map((a) => `${a.proxy}:${a.status || a.error}`).join(' → ');
      const msg = `All proxies failed for ${url} (${detail})`;
      const err = new Error(msg);
      err.attempts = res.attempts;
      throw err;
    }
    return {
      html: res.html, ms: res.ms, finalUrl: url, status: res.status,
      via: res.via, attempts: res.attempts,
    };
  }

  async function probeHead(url, proxyKey = 'allorigins') {
    // Probe a path via the proxy chain. Returns { ok, status, size, text }.
    // Cap to first 2 proxies — robots.txt / sitemap probes are nice-to-have
    // and shouldn't blow the audit budget.
    const chain = orderedChain(proxyKey).slice(0, 2);
    const res = await fetchThroughChain(url, chain, { timeoutMs: 7000, minBytes: 1 });
    return {
      ok: res.ok,
      status: res.status,
      size: res.html ? res.html.length : 0,
      text: res.html || '',
      via: res.via,
    };
  }

  // ── HTML parsing ────────────────────────────────────────────
  function parseHtml(html) {
    const parser = new DOMParser();
    return parser.parseFromString(html, 'text/html');
  }

  function textContentOf(el) {
    return (el?.textContent || '').replace(/\s+/g, ' ').trim();
  }

  function attr(el, name) { return el?.getAttribute?.(name) || ''; }

  function fleschReadingEase(text) {
    const words = text.split(/\s+/).filter(Boolean);
    const sentences = text.split(/[.!?]+/).filter((s) => s.trim().length > 0);
    if (!words.length || !sentences.length) return 0;
    const syl = words.reduce((sum, w) => sum + countSyllables(w), 0);
    return 206.835 - 1.015 * (words.length / sentences.length) - 84.6 * (syl / words.length);
  }

  function countSyllables(word) {
    word = word.toLowerCase().replace(/[^a-z]/g, '');
    if (word.length <= 3) return 1;
    word = word.replace(/(?:[^laeiouy]es|ed|[^laeiouy]e)$/, '');
    word = word.replace(/^y/, '');
    const m = word.match(/[aeiouy]{1,2}/g);
    return m ? m.length : 1;
  }

  // Fraction of meaningful words in `b` that also appear in `a`.
  // Used to gauge title↔H1 keyword alignment.
  function sharedWordRatio(a, b) {
    const wa = new Set(a.split(/\W+/).filter((w) => w.length > 2));
    const wb = b.split(/\W+/).filter((w) => w.length > 2);
    if (!wb.length || !wa.size) return 0;
    const hits = wb.filter((w) => wa.has(w)).length;
    return hits / wb.length;
  }

  // ── Signal extraction ───────────────────────────────────────
  function extractSignals(html, url, fetchMs) {
    const doc = parseHtml(html);
    const u = new URL(url);
    const host = u.hostname.replace(/^www\./, '');
    const isHttps = u.protocol === 'https:';

    // Title
    const titleEl = doc.querySelector('title');
    const title = textContentOf(titleEl);
    const titleLen = title.length;

    // Meta description
    const metaDesc = attr(doc.querySelector('meta[name="description" i]'), 'content').trim();
    const descLen = metaDesc.length;

    // Meta robots & canonical
    const robots = attr(doc.querySelector('meta[name="robots" i]'), 'content').toLowerCase();
    const canonical = attr(doc.querySelector('link[rel="canonical" i]'), 'href');
    const viewport = attr(doc.querySelector('meta[name="viewport" i]'), 'content');
    const charset = doc.characterSet || doc.charset || '';
    const lang = doc.documentElement.getAttribute('lang') || '';

    // Headings
    const headings = { h1: [], h2: [], h3: [], h4: [], h5: [], h6: [] };
    Object.keys(headings).forEach((tag) => {
      doc.querySelectorAll(tag).forEach((h) => headings[tag].push(textContentOf(h)));
    });

    // Links
    const links = Array.from(doc.querySelectorAll('a[href]'));
    const internal = [], external = [], nofollow = [];
    const internalSet = new Set(); // deduped, fragment-stripped internal URLs (for crawling)
    links.forEach((a) => {
      const href = a.getAttribute('href');
      if (!href || href.startsWith('#') || href.startsWith('javascript:') || href.startsWith('mailto:') || href.startsWith('tel:')) return;
      try {
        const abs = new URL(href, url);
        if (abs.hostname.replace(/^www\./, '') === host) {
          internal.push(abs.href);
          // Normalize for crawl: drop hash, keep query (some sites paginate via ?page=)
          abs.hash = '';
          internalSet.add(abs.href);
        } else external.push(abs.href);
        const rel = (a.getAttribute('rel') || '').toLowerCase();
        if (rel.includes('nofollow')) nofollow.push(abs.href);
      } catch {}
    });
    const internalLinks = Array.from(internalSet).slice(0, 300);

    // Images
    const imgs = Array.from(doc.querySelectorAll('img'));
    const imgsWithAlt = imgs.filter((i) => attr(i, 'alt').trim().length > 0);
    const imgsWithEmptyAlt = imgs.filter((i) => i.hasAttribute('alt') && !attr(i, 'alt').trim());
    const imgsLazy = imgs.filter((i) => attr(i, 'loading').toLowerCase() === 'lazy');
    const imgsModern = imgs.filter((i) => /\.(webp|avif)(\?|$)/i.test(attr(i, 'src')));
    const imgsDimensioned = imgs.filter((i) => i.hasAttribute('width') && i.hasAttribute('height'));

    // Body text & word count
    const bodyClone = doc.body ? doc.body.cloneNode(true) : null;
    if (bodyClone) {
      bodyClone.querySelectorAll('script, style, noscript, nav, footer, header').forEach((n) => n.remove());
    }
    const bodyText = bodyClone ? textContentOf(bodyClone) : '';
    const words = bodyText ? bodyText.split(/\s+/).filter(Boolean) : [];
    const wordCount = words.length;
    const sentenceCount = bodyText ? bodyText.split(/[.!?]+/).filter((s) => s.trim()).length : 0;
    const flesch = bodyText ? fleschReadingEase(bodyText) : 0;

    // Open Graph & Twitter Cards
    const og = {};
    doc.querySelectorAll('meta[property^="og:" i]').forEach((m) => {
      og[attr(m, 'property').toLowerCase()] = attr(m, 'content');
    });
    const twitter = {};
    doc.querySelectorAll('meta[name^="twitter:" i]').forEach((m) => {
      twitter[attr(m, 'name').toLowerCase()] = attr(m, 'content');
    });

    // Structured data
    const ldjson = [];
    doc.querySelectorAll('script[type="application/ld+json"]').forEach((s) => {
      try { ldjson.push(JSON.parse(s.textContent)); } catch {}
    });
    const microdata = doc.querySelectorAll('[itemscope]').length;
    const rdfa = doc.querySelectorAll('[typeof], [property]:not([property^="og:" i]):not([property^="article:" i])').length;
    const schemaTypes = [];
    ldjson.forEach((j) => {
      const collect = (n) => {
        if (!n) return;
        if (Array.isArray(n)) return n.forEach(collect);
        if (n['@type']) {
          (Array.isArray(n['@type']) ? n['@type'] : [n['@type']]).forEach((t) => schemaTypes.push(t));
        }
        if (n['@graph']) collect(n['@graph']);
      };
      collect(j);
    });

    // hreflang
    const hreflang = Array.from(doc.querySelectorAll('link[rel="alternate" i][hreflang]')).map((l) => attr(l, 'hreflang'));

    // Performance hints
    const totalScripts = doc.querySelectorAll('script').length;
    const inlineStyles = doc.querySelectorAll('style').length;
    const stylesheets = doc.querySelectorAll('link[rel="stylesheet"]').length;
    const htmlSize = html.length;

    // Forms
    const forms = doc.querySelectorAll('form').length;

    // Favicon
    const favicon = doc.querySelector('link[rel*="icon" i]');

    // Social presence — extract from external links
    const socialDomains = ['facebook.com', 'twitter.com', 'x.com', 'instagram.com', 'linkedin.com', 'youtube.com', 'tiktok.com', 'pinterest.com', 'github.com'];
    const socialFound = new Set();
    external.forEach((href) => {
      try {
        const h = new URL(href).hostname.replace(/^www\./, '');
        socialDomains.forEach((s) => { if (h.endsWith(s)) socialFound.add(s); });
      } catch {}
    });

    // Keyword density (top 10 word stems excluding stopwords)
    const STOP = new Set(['the','a','an','of','to','and','or','in','on','for','is','are','was','were','be','by','with','as','at','from','this','that','it','its','i','you','we','our','your','their','they','he','she','his','her','can','will','would','should','could','may','might','do','does','did','have','has','had','but','not','no','if','so','than','then','about','into','out','up','down','over','under','more','most','some','any','all','one','two','also','just','only','my','me','us','them','what','which','who','whose','how','when','where','why']);
    const freq = {};
    words.forEach((w) => {
      const k = w.toLowerCase().replace(/[^a-z0-9]/g, '');
      if (!k || k.length < 3 || STOP.has(k)) return;
      freq[k] = (freq[k] || 0) + 1;
    });
    const topKeywords = Object.entries(freq).sort((a, b) => b[1] - a[1]).slice(0, 15);

    // Mixed content
    let mixedContent = 0;
    if (isHttps) {
      doc.querySelectorAll('img[src^="http:" i], script[src^="http:" i], link[href^="http:" i]').forEach(() => mixedContent++);
    }

    // ── Extended signals (v2.5) ───────────────────────────────
    // URL structure & hygiene
    const path = u.pathname;
    const urlDepth = path.split('/').filter(Boolean).length;
    const urlUnderscores = /_/.test(path);
    const urlUppercase = /[A-Z]/.test(path);
    const cleanUrl = !urlUnderscores && !urlUppercase && urlDepth <= 4;

    // Accessibility
    const ariaLabels = doc.querySelectorAll('[aria-label], [aria-labelledby]').length;
    const roles = doc.querySelectorAll('[role]').length;
    const skipLink = !!doc.querySelector('a[href^="#"][class*="skip" i], a[href="#main" i], a[href="#content" i]');
    const formFields = Array.from(doc.querySelectorAll('input:not([type="hidden" i]), select, textarea'));
    const cssEscape = (global.CSS && global.CSS.escape) ? global.CSS.escape : (v) => v.replace(/["\\]/g, '\\$&');
    const labeledFields = formFields.filter((f) => {
      if (f.getAttribute('aria-label') || f.getAttribute('aria-labelledby') || f.closest('label')) return true;
      const id = f.getAttribute('id');
      if (id) { try { return !!doc.querySelector(`label[for="${cssEscape(id)}"]`); } catch { return false; } }
      return false;
    });
    const namelessButtons = Array.from(doc.querySelectorAll('button')).filter(
      (b) => !textContentOf(b) && !b.getAttribute('aria-label') && !b.querySelector('img[alt]:not([alt=""])')
    ).length;
    let headingOrderOk = true;
    {
      const seq = [];
      doc.querySelectorAll('h1,h2,h3,h4,h5,h6').forEach((h) => seq.push(+h.tagName[1]));
      for (let i = 1; i < seq.length; i++) { if (seq[i] - seq[i - 1] > 1) { headingOrderOk = false; break; } }
    }

    // Link quality
    const genericAnchors = links.filter((a) => /^(click here|here|read more|learn more|more|link|this|go)$/i.test(textContentOf(a))).length;
    const blankLinks = Array.from(doc.querySelectorAll('a[target="_blank"]'));
    const unsafeBlank = blankLinks.filter((a) => !/noopener|noreferrer/i.test(a.getAttribute('rel') || '')).length;

    // Security / best practices
    const cspMeta = !!doc.querySelector('meta[http-equiv="Content-Security-Policy" i]');
    const scriptsWithSrc = Array.from(doc.querySelectorAll('script[src]'));
    const externalScripts = scriptsWithSrc.filter((sc) => {
      try { return new URL(sc.getAttribute('src'), url).hostname.replace(/^www\./, '') !== host; } catch { return false; }
    });
    const sriScripts = externalScripts.filter((sc) => sc.hasAttribute('integrity')).length;

    // Resource hints & script loading strategy
    const preconnect = doc.querySelectorAll('link[rel="preconnect" i]').length;
    const dnsPrefetch = doc.querySelectorAll('link[rel="dns-prefetch" i]').length;
    const preload = doc.querySelectorAll('link[rel="preload" i]').length;
    const asyncScripts = scriptsWithSrc.filter((sc) => sc.hasAttribute('async')).length;
    const deferScripts = scriptsWithSrc.filter((sc) => sc.hasAttribute('defer') || sc.getAttribute('type') === 'module').length;
    const renderBlockingJs = scriptsWithSrc.filter((sc) => !sc.hasAttribute('async') && !sc.hasAttribute('defer') && sc.getAttribute('type') !== 'module').length;
    const inlineScriptBytes = Array.from(doc.querySelectorAll('script:not([src])')).reduce((n, sc) => n + (sc.textContent || '').length, 0);

    // Content structure
    const paragraphs = doc.querySelectorAll('p').length;
    const listCount = doc.querySelectorAll('ul, ol').length;
    const tableCount = doc.querySelectorAll('table').length;
    const videoCount = doc.querySelectorAll('video, iframe[src*="youtube" i], iframe[src*="vimeo" i]').length;
    const iframeCount = doc.querySelectorAll('iframe').length;
    const readingTime = Math.max(1, Math.round(wordCount / 200));
    const hasFaq = schemaTypes.some((t) => /FAQPage|Question/i.test(t)) || /frequently asked questions|\bFAQ\b/i.test(bodyText);
    const hasToc = !!doc.querySelector('nav[class*="toc" i], [class*="table-of-contents" i], [id*="toc" i]');

    // PWA & mobile chrome
    const manifest = !!doc.querySelector('link[rel="manifest" i]');
    const appleTouchIcon = !!doc.querySelector('link[rel="apple-touch-icon" i]');
    const themeColor = !!attr(doc.querySelector('meta[name="theme-color" i]'), 'content');
    const ampLink = !!doc.querySelector('link[rel="amphtml" i]');

    // Meta extras
    const metaKeywords = attr(doc.querySelector('meta[name="keywords" i]'), 'content');
    const metaAuthor = attr(doc.querySelector('meta[name="author" i]'), 'content');

    // Title ↔ H1 keyword alignment
    const h1Text = (headings.h1[0] || '').toLowerCase();
    const titleH1Overlap = (h1Text && title) ? sharedWordRatio(title.toLowerCase(), h1Text) : 0;

    // Structured-data richness
    const richSchema = schemaTypes.filter((t) => /Article|BlogPosting|Product|Recipe|Event|FAQPage|HowTo|BreadcrumbList|VideoObject|Review|LocalBusiness/i.test(t));

    // ── WordPress detection (v2.7) ──────────────────────────────
    // Detect if site is WordPress and extract platform-specific signals
    let isWordPress = false;
    let wpVersion = null;
    let wpTheme = null;
    let wpPlugins = [];
    let wpGenerator = null;

    // Check for WordPress indicators
    if (/wp-content|wp-includes|\/wp-json\/|wordpress/.test(html)) isWordPress = true;

    // WordPress generator meta tag
    const generatorMeta = attr(doc.querySelector('meta[name="generator" i]'), 'content');
    if (generatorMeta && /wordpress/i.test(generatorMeta)) {
      isWordPress = true;
      wpGenerator = generatorMeta;
      const vMatch = generatorMeta.match(/WordPress\s+([\d.]+)/i);
      if (vMatch) wpVersion = vMatch[1];
    }

    // Theme detection from stylesheet hrefs (common pattern: /wp-content/themes/theme-name/)
    const themeMatch = html.match(/\/wp-content\/themes\/([\w-]+)/);
    if (themeMatch) {
      wpTheme = themeMatch[1];
      isWordPress = true;
    }

    // Plugin detection from script/link src patterns (/wp-content/plugins/plugin-name/)
    const pluginMatches = html.match(/\/wp-content\/plugins\/([\w-]+)/g) || [];
    wpPlugins = [...new Set(pluginMatches.map(m => m.replace(/\/wp-content\/plugins\//, '').replace(/\/$/, '')))];

    // WP-specific features
    const hasWpComments = !!doc.querySelector('.comment-form, #respond, .wp-comments-section') || /wp-comment|comment-form/i.test(html);
    const hasWpMeta = !!doc.querySelector('meta[name*="wp-"]');
    const hasRestApi = /\/wp-json\//.test(html) || !!doc.querySelector('link[rel="https://api.w.org/"]');

    return {
      url, host, isHttps,
      fetchMs,
      title, titleLen,
      metaDesc, descLen,
      robots, canonical, viewport, charset, lang,
      headings,
      links: { internal: internal.length, external: external.length, nofollow: nofollow.length, total: internal.length + external.length },
      internalLinks,
      images: { total: imgs.length, withAlt: imgsWithAlt.length, emptyAlt: imgsWithEmptyAlt.length, lazy: imgsLazy.length, modern: imgsModern.length, dimensioned: imgsDimensioned.length },
      bodyText: bodyText.slice(0, 1500),
      wordCount, sentenceCount, flesch,
      og, twitter,
      ldjson: ldjson.length, schemaTypes,
      microdata, rdfa,
      hreflang,
      htmlSize, totalScripts, inlineStyles, stylesheets,
      forms,
      hasFavicon: !!favicon,
      socials: Array.from(socialFound),
      mixedContent,
      topKeywords,
      // v2.5 extended signals
      urlInfo: { path, depth: urlDepth, underscores: urlUnderscores, uppercase: urlUppercase, cleanUrl },
      a11y: {
        ariaLabels, roles, skipLink, headingOrderOk, namelessButtons,
        inputs: formFields.length, labeledInputs: labeledFields.length,
      },
      security: {
        csp: cspMeta, sriScripts,
        externalScripts: externalScripts.length, unsafeBlankLinks: unsafeBlank,
      },
      hints: {
        preconnect, dnsPrefetch, preload,
        asyncScripts, deferScripts, renderBlockingJs,
        inlineScriptKB: Math.round(inlineScriptBytes / 1024),
      },
      structure: {
        paragraphs, lists: listCount, tables: tableCount, videos: videoCount,
        iframes: iframeCount, readingTime, hasFaq, hasToc,
        genericAnchors, blankLinks: blankLinks.length,
      },
      pwa: { manifest, appleTouchIcon, themeColor, ampLink },
      metaExtra: { keywords: metaKeywords, author: metaAuthor },
      alignment: { titleH1Overlap },
      richSchema,
      wordpress: {
        isWordPress,
        version: wpVersion,
        theme: wpTheme,
        plugins: wpPlugins,
        generator: wpGenerator,
        hasComments: hasWpComments,
        hasRestApi,
      },
    };
  }

  // ── Scoring (each function returns { score: 0-100, details: [...] }) ──

  function scoreOnPage(s) {
    const details = [];
    let total = 0, max = 0;
    const add = (n, m, label, pass) => { total += n; max += m; details.push({ label, score: n, max: m, status: pass }); };

    // Title (15)
    if (!s.title) add(0, 15, 'Title tag', 'fail');
    else if (s.titleLen < 30) add(7, 15, `Title too short (${s.titleLen})`, 'warn');
    else if (s.titleLen > 65) add(8, 15, `Title too long (${s.titleLen})`, 'warn');
    else add(15, 15, `Title length optimal (${s.titleLen})`, 'pass');

    // Meta description (12)
    if (!s.metaDesc) add(0, 12, 'Meta description missing', 'fail');
    else if (s.descLen < 70) add(5, 12, `Meta desc short (${s.descLen})`, 'warn');
    else if (s.descLen > 160) add(7, 12, `Meta desc long (${s.descLen})`, 'warn');
    else add(12, 12, `Meta desc optimal (${s.descLen})`, 'pass');

    // H1 (12)
    const h1n = s.headings.h1.length;
    if (h1n === 0) add(0, 12, 'No H1 tag', 'fail');
    else if (h1n > 1) add(6, 12, `Multiple H1 tags (${h1n})`, 'warn');
    else add(12, 12, 'Single H1 present', 'pass');

    // Heading hierarchy (8)
    const totalH = s.headings.h2.length + s.headings.h3.length + s.headings.h4.length;
    if (totalH >= 5) add(8, 8, `${totalH} sub-headings`, 'pass');
    else if (totalH >= 2) add(5, 8, `${totalH} sub-headings (sparse)`, 'warn');
    else add(2, 8, 'Heading hierarchy weak', 'fail');

    // Image alt coverage (10)
    const imgs = s.images;
    const altCov = imgs.total ? imgs.withAlt / imgs.total : 1;
    if (imgs.total === 0) add(8, 10, 'No images on page', 'info');
    else if (altCov >= 0.9) add(10, 10, `Alt coverage ${Math.round(altCov*100)}%`, 'pass');
    else if (altCov >= 0.6) add(6, 10, `Alt coverage ${Math.round(altCov*100)}%`, 'warn');
    else add(2, 10, `Alt coverage only ${Math.round(altCov*100)}%`, 'fail');

    // Canonical (6)
    if (s.canonical) add(6, 6, 'Canonical tag present', 'pass');
    else add(0, 6, 'Missing canonical tag', 'warn');

    // Open Graph (8)
    const ogCount = ['og:title', 'og:description', 'og:image', 'og:type'].filter((k) => s.og[k]).length;
    if (ogCount === 4) add(8, 8, 'Open Graph complete', 'pass');
    else if (ogCount >= 2) add(4, 8, `Open Graph partial (${ogCount}/4)`, 'warn');
    else add(0, 8, 'Open Graph missing', 'fail');

    // Twitter Cards (5)
    if (s.twitter['twitter:card']) add(5, 5, 'Twitter Card present', 'pass');
    else add(0, 5, 'Twitter Card missing', 'warn');

    // Internal links (8)
    if (s.links.internal >= 10) add(8, 8, `${s.links.internal} internal links`, 'pass');
    else if (s.links.internal >= 3) add(4, 8, `Only ${s.links.internal} internal links`, 'warn');
    else add(1, 8, `Very few internal links (${s.links.internal})`, 'fail');

    // External link health (4)
    if (s.links.external === 0) add(2, 4, 'No external citations', 'warn');
    else if (s.links.external <= 20) add(4, 4, `${s.links.external} outbound`, 'pass');
    else add(2, 4, `${s.links.external} outbound (heavy)`, 'warn');

    // Language declared (4)
    if (s.lang) add(4, 4, `Language set: ${s.lang}`, 'pass');
    else add(0, 4, 'No lang attribute on <html>', 'warn');

    // Favicon (4)
    if (s.hasFavicon) add(4, 4, 'Favicon present', 'pass');
    else add(0, 4, 'Missing favicon', 'warn');

    // Schema markup (4)
    if (s.ldjson > 0) add(4, 4, `${s.ldjson} JSON-LD blocks (${s.schemaTypes.slice(0,3).join(', ') || 'untyped'})`, 'pass');
    else if (s.microdata > 0) add(2, 4, `${s.microdata} microdata items`, 'warn');
    else add(0, 4, 'No structured data', 'warn');

    // Clean URL structure (4)
    if (s.urlInfo.cleanUrl) add(4, 4, 'Clean URL structure', 'pass');
    else add(2, 4, 'URL has underscores / caps / deep nesting', 'warn');

    // Title ↔ H1 keyword alignment (4)
    if (s.alignment.titleH1Overlap >= 0.3) add(4, 4, 'Title aligns with H1', 'pass');
    else if (s.headings.h1.length) add(2, 4, 'Title & H1 keywords diverge', 'warn');
    else add(0, 4, 'No H1 to align with title', 'warn');

    // Descriptive anchor text (4)
    if (s.structure.genericAnchors === 0) add(4, 4, 'Descriptive anchor text', 'pass');
    else add(1, 4, `${s.structure.genericAnchors} generic anchors`, 'warn');

    return { score: pct((total / max) * 100), details, raw: total, max };
  }

  function scoreTechnical(s, perf) {
    const details = [];
    let total = 0, max = 0;
    const add = (n, m, label, pass) => { total += n; max += m; details.push({ label, score: n, max: m, status: pass }); };

    // HTTPS (15)
    if (s.isHttps) add(15, 15, 'HTTPS enabled', 'pass'); else add(0, 15, 'No HTTPS', 'fail');

    // Mobile viewport (12)
    if (/width=device-width/i.test(s.viewport)) add(12, 12, 'Mobile viewport meta', 'pass');
    else if (s.viewport) add(6, 12, 'Viewport set, not responsive', 'warn');
    else add(0, 12, 'Missing viewport meta', 'fail');

    // Indexability (12)
    if (/noindex/i.test(s.robots)) add(0, 12, 'Page is noindex', 'fail');
    else if (/nofollow/i.test(s.robots)) add(8, 12, 'Page is nofollow', 'warn');
    else add(12, 12, 'Indexable & followable', 'pass');

    // Page weight (10)
    const kb = s.htmlSize / 1024;
    if (kb < 100) add(10, 10, `HTML ${kb.toFixed(0)}KB (lean)`, 'pass');
    else if (kb < 300) add(7, 10, `HTML ${kb.toFixed(0)}KB`, 'pass');
    else if (kb < 600) add(4, 10, `HTML ${kb.toFixed(0)}KB (heavy)`, 'warn');
    else add(1, 10, `HTML ${kb.toFixed(0)}KB (bloated)`, 'fail');

    // Fetch latency (10)
    if (s.fetchMs < 1500) add(10, 10, `Fetched in ${(s.fetchMs/1000).toFixed(2)}s`, 'pass');
    else if (s.fetchMs < 3000) add(6, 10, `${(s.fetchMs/1000).toFixed(2)}s fetch`, 'warn');
    else add(2, 10, `Slow fetch ${(s.fetchMs/1000).toFixed(2)}s`, 'fail');

    // Script count (6)
    if (s.totalScripts < 15) add(6, 6, `${s.totalScripts} script tags`, 'pass');
    else if (s.totalScripts < 30) add(3, 6, `${s.totalScripts} scripts (heavy)`, 'warn');
    else add(1, 6, `${s.totalScripts} scripts (bloat)`, 'fail');

    // Mixed content (8)
    if (!s.isHttps) add(0, 8, 'N/A (no HTTPS)', 'info');
    else if (s.mixedContent === 0) add(8, 8, 'No mixed content', 'pass');
    else add(0, 8, `${s.mixedContent} insecure resources`, 'fail');

    // Modern image formats (5)
    if (s.images.total === 0) add(4, 5, 'No images', 'info');
    else if (s.images.modern / s.images.total >= 0.3) add(5, 5, `${s.images.modern}/${s.images.total} modern formats`, 'pass');
    else if (s.images.modern > 0) add(3, 5, `Some modern formats`, 'warn');
    else add(1, 5, 'No WebP/AVIF used', 'warn');

    // Lazy loading (4)
    if (s.images.total < 5) add(3, 4, 'Few images', 'info');
    else if (s.images.lazy / s.images.total >= 0.5) add(4, 4, 'Lazy-loading in use', 'pass');
    else add(1, 4, 'Lazy-loading underused', 'warn');

    // hreflang (4)
    if (s.hreflang.length > 0) add(4, 4, `${s.hreflang.length} hreflang variants`, 'pass');
    else add(2, 4, 'No hreflang (single locale)', 'info');

    // Render-blocking JavaScript (6)
    if (s.hints.renderBlockingJs === 0) add(6, 6, 'No render-blocking scripts', 'pass');
    else if (s.hints.renderBlockingJs <= 3) add(3, 6, `${s.hints.renderBlockingJs} render-blocking scripts`, 'warn');
    else add(1, 6, `${s.hints.renderBlockingJs} render-blocking scripts`, 'fail');

    // Image dimensions / CLS safety (6)
    if (s.images.total === 0) add(5, 6, 'No images', 'info');
    else if (s.images.dimensioned / s.images.total >= 0.8) add(6, 6, 'Images dimensioned (CLS-safe)', 'pass');
    else add(2, 6, `${s.images.dimensioned}/${s.images.total} images sized`, 'warn');

    // Resource hints (4)
    if (s.hints.preconnect + s.hints.preload > 0) add(4, 4, `${s.hints.preconnect} preconnect · ${s.hints.preload} preload`, 'pass');
    else add(2, 4, 'No preconnect/preload hints', 'info');

    // Link safety — target=_blank (4)
    if (s.security.unsafeBlankLinks === 0) add(4, 4, 'target=_blank links safe', 'pass');
    else add(1, 4, `${s.security.unsafeBlankLinks} unsafe target=_blank`, 'warn');

    // Subresource Integrity on third-party JS (4)
    if (s.security.externalScripts === 0) add(3, 4, 'No third-party scripts', 'info');
    else if (s.security.sriScripts >= s.security.externalScripts) add(4, 4, 'All third-party JS uses SRI', 'pass');
    else add(1, 4, `${s.security.sriScripts}/${s.security.externalScripts} scripts use SRI`, 'warn');

    // PSI Core Web Vitals (14) if available
    if (perf && perf.performance != null) {
      const v = perf.performance;
      if (v >= 90) add(14, 14, `PSI performance ${v}`, 'pass');
      else if (v >= 50) add(8, 14, `PSI performance ${v}`, 'warn');
      else add(2, 14, `PSI performance ${v}`, 'fail');
    } else {
      // fallback heuristic
      add(7, 14, 'PSI unavailable — heuristic only', 'info');
    }

    return { score: pct((total / max) * 100), details, raw: total, max };
  }

  function scoreContent(s) {
    const details = [];
    let total = 0, max = 0;
    const add = (n, m, label, pass) => { total += n; max += m; details.push({ label, score: n, max: m, status: pass }); };

    // Word count (20)
    if (s.wordCount >= 1200) add(20, 20, `${s.wordCount} words (long-form)`, 'pass');
    else if (s.wordCount >= 600) add(15, 20, `${s.wordCount} words`, 'pass');
    else if (s.wordCount >= 300) add(8, 20, `${s.wordCount} words (thin)`, 'warn');
    else add(2, 20, `${s.wordCount} words (very thin)`, 'fail');

    // Readability (15)
    const f = s.flesch;
    if (f >= 60 && f <= 80) add(15, 15, `Flesch ${f.toFixed(0)} (ideal)`, 'pass');
    else if (f >= 40 && f <= 90) add(10, 15, `Flesch ${f.toFixed(0)}`, 'warn');
    else add(4, 15, `Flesch ${f.toFixed(0)} (extreme)`, 'fail');

    // Keyword diversity (10)
    if (s.topKeywords.length >= 10) add(10, 10, `${s.topKeywords.length} key terms`, 'pass');
    else if (s.topKeywords.length >= 5) add(6, 10, 'Modest vocabulary', 'warn');
    else add(2, 10, 'Narrow vocabulary', 'fail');

    // Heading-to-content ratio (10)
    const totalH = s.headings.h1.length + s.headings.h2.length + s.headings.h3.length;
    const ratio = s.wordCount ? totalH / (s.wordCount / 200) : 0;
    if (ratio >= 0.5 && ratio <= 2.5) add(10, 10, 'Heading rhythm balanced', 'pass');
    else if (ratio > 0) add(5, 10, 'Heading rhythm off', 'warn');
    else add(0, 10, 'Almost no headings', 'fail');

    // Multimedia richness (10)
    if (s.images.total >= 5) add(10, 10, `${s.images.total} images`, 'pass');
    else if (s.images.total >= 2) add(6, 10, `${s.images.total} images`, 'warn');
    else add(2, 10, 'Image-poor content', 'fail');

    // Top keyword density sanity (10)
    if (s.topKeywords.length > 0) {
      const [topWord, topCount] = s.topKeywords[0];
      const density = (topCount / Math.max(1, s.wordCount)) * 100;
      if (density >= 0.5 && density <= 3) add(10, 10, `"${topWord}" density ${density.toFixed(1)}%`, 'pass');
      else if (density < 0.5) add(5, 10, `Top term density ${density.toFixed(1)}% (low)`, 'warn');
      else add(3, 10, `Top term density ${density.toFixed(1)}% (stuffed)`, 'fail');
    } else add(0, 10, 'No keyword signal', 'fail');

    // Content sectioning (10)
    if (totalH >= 4) add(10, 10, 'Well-sectioned', 'pass');
    else if (totalH >= 2) add(5, 10, 'Lightly sectioned', 'warn');
    else add(0, 10, 'Not sectioned', 'fail');

    // Sentence variation (5)
    const avgWords = s.sentenceCount ? s.wordCount / s.sentenceCount : 0;
    if (avgWords >= 12 && avgWords <= 22) add(5, 5, `Avg ${avgWords.toFixed(1)} w/sentence`, 'pass');
    else if (avgWords > 0) add(2, 5, `Avg ${avgWords.toFixed(1)} w/sentence`, 'warn');
    else add(0, 5, 'No prose detected', 'fail');

    // Freshness markers (10) — look for dates in content
    const hasDate = /\b20\d{2}\b/.test(s.bodyText) || s.ldjson > 0;
    if (hasDate) add(10, 10, 'Date/freshness markers present', 'pass');
    else add(4, 10, 'No date markers', 'warn');

    // Scannability — lists & paragraphs (10)
    if (s.structure.lists >= 1 && s.structure.paragraphs >= 3) add(10, 10, `${s.structure.lists} lists · ${s.structure.paragraphs} paragraphs`, 'pass');
    else if (s.structure.paragraphs >= 2) add(5, 10, 'Limited scannable structure', 'warn');
    else add(2, 10, 'Wall-of-text risk', 'fail');

    // FAQ / supporting content (5)
    if (s.structure.hasFaq) add(5, 5, 'FAQ-style content detected', 'pass');
    else add(2, 5, 'No FAQ section', 'info');

    return { score: pct((total / max) * 100), details, raw: total, max };
  }

  function scoreOffPage(s, extras) {
    const details = [];
    let total = 0, max = 0;
    const add = (n, m, label, pass) => { total += n; max += m; details.push({ label, score: n, max: m, status: pass }); };

    // Social presence (25)
    const socCount = s.socials.length;
    if (socCount >= 4) add(25, 25, `${socCount} social channels linked`, 'pass');
    else if (socCount >= 2) add(15, 25, `${socCount} social channels`, 'warn');
    else if (socCount === 1) add(8, 25, '1 social channel', 'warn');
    else add(0, 25, 'No social presence detected', 'fail');

    // Domain authority proxy via TLD & length (15)
    const host = s.host;
    if (/\.(gov|edu|org)$/i.test(host)) add(15, 15, `Trusted TLD (${host.split('.').pop()})`, 'pass');
    else if (/\.(com|net|io|co)$/i.test(host)) add(12, 15, 'Established TLD', 'pass');
    else add(8, 15, 'Generic TLD', 'info');

    // robots.txt & sitemap (15)
    if (extras?.robotsTxt) add(8, 8, 'robots.txt found', 'pass');
    else add(0, 8, 'No robots.txt', 'warn');
    if (extras?.sitemap) add(7, 7, 'Sitemap discovered', 'pass');
    else add(0, 7, 'No sitemap found', 'warn');

    // Brand consistency (10) — og:site_name or schema org name
    if (s.og['og:site_name'] || s.schemaTypes.some((t) => /Organization|WebSite/i.test(t))) {
      add(10, 10, 'Brand entity declared', 'pass');
    } else add(4, 10, 'No brand entity markup', 'warn');

    // External citations outbound (10)
    if (s.links.external >= 3 && s.links.external <= 30) add(10, 10, 'Healthy citation flow', 'pass');
    else if (s.links.external > 0) add(5, 10, `${s.links.external} outbound (re-balance)`, 'warn');
    else add(0, 10, 'No outbound citations', 'fail');

    // E-E-A-T proxies: author/contact (10)
    const eatHits = /\b(author|byline|written by|reviewed by|about us|contact)\b/i.test(s.bodyText);
    if (eatHits || s.schemaTypes.some((t) => /Person|Author/i.test(t))) add(10, 10, 'Author/contact signals', 'pass');
    else add(3, 10, 'Weak E-E-A-T markers', 'warn');

    // HTTPS contributes to trust (10)
    if (s.isHttps && s.mixedContent === 0) add(10, 10, 'Secure & clean', 'pass');
    else if (s.isHttps) add(6, 10, 'HTTPS w/ mixed content', 'warn');
    else add(0, 10, 'Insecure', 'fail');

    // Indexable for backlinks to count (5)
    if (!/noindex/i.test(s.robots)) add(5, 5, 'Open for indexing', 'pass');
    else add(0, 5, 'Page blocks indexing', 'fail');

    return { score: pct((total / max) * 100), details, raw: total, max };
  }

  // ── PSI (lightweight summary derived from full Lighthouse) ──
  // The heavy lifting now lives in lighthouse.js; this just keeps
  // backward compatibility with the original `perf` object shape.
  function summarizePsi(lhBundle) {
    if (!lhBundle) return null;
    const m = lhBundle.mobile || lhBundle.desktop;
    if (!m) return null;
    return {
      performance: m.scores.performance,
      seo: m.scores.seo,
      lcp: m.metrics.lcp?.displayValue,
      cls: m.metrics.cls?.displayValue,
      fcp: m.metrics.fcp?.displayValue,
      tbt: m.metrics.tbt?.displayValue,
      inp: m.metrics.inp?.displayValue,
      ttfb: m.metrics.ttfb?.displayValue,
    };
  }

  // ── Master audit ────────────────────────────────────────────
  async function auditSite(url, opts = {}) {
    const proxyKey = opts.proxy || 'allorigins';
    const psiKey = opts.psiKey || '';
    const usePsi = opts.usePsi !== false;
    const onProgress = opts.onProgress || (() => {});

    onProgress({ phase: 'fetch', msg: `Fetching ${url}` });
    const page = await fetchPage(url, proxyKey, {
      onTry: ({ try: n, of, proxy }) => {
        if (n === 1) onProgress({ phase: 'fetch', msg: `   → via ${proxy}` });
        else onProgress({ phase: 'fetch', msg: `   → falling back to ${proxy} (attempt ${n}/${of})`, level: 'warn' });
      },
    });
    onProgress({ phase: 'parse', msg: `   ✓ fetched ${(page.html.length / 1024).toFixed(1)} KB via ${page.via} in ${(page.ms / 1000).toFixed(2)}s` });
    const signals = extractSignals(page.html, url, page.ms);

    // Robots & sitemap probes (best-effort). Skipped for crawl sub-pages
    // (probeRobots:false) since they share the origin's robots/sitemap and
    // we don't want to spend proxy budget re-probing it for every page.
    let robotsProbe = { ok: false }, sitemapFound = false;
    if (opts.probeRobots !== false) {
      onProgress({ phase: 'probe', msg: 'Probing robots.txt & sitemap' });
      const origin = new URL(url).origin;
      robotsProbe = await probeHead(origin + '/robots.txt', proxyKey).catch(() => ({ ok: false }));
      if (robotsProbe.ok && /sitemap:/i.test(robotsProbe.text || '')) sitemapFound = true;
      if (!sitemapFound) {
        const smProbe = await probeHead(origin + '/sitemap.xml', proxyKey).catch(() => ({ ok: false }));
        if (smProbe.ok && /<urlset|<sitemapindex/i.test(smProbe.text || '')) sitemapFound = true;
      }
    }

    // Lighthouse (full mobile + desktop via PSI)
    let lighthouse = null, perf = null;
    if (usePsi && global.SERPSCOPE?.lighthouse) {
      onProgress({ phase: 'psi', msg: 'Running Lighthouse (mobile + desktop) via PSI…' });
      try {
        lighthouse = await global.SERPSCOPE.lighthouse.runLighthouse(url, {
          apiKey: psiKey,
          onProgress: (p) => onProgress({ phase: 'psi', msg: '   ' + (p.msg || '') }),
        });
        perf = summarizePsi(lighthouse);
      } catch (e) {
        onProgress({ phase: 'psi', msg: '   PSI failed: ' + e.message });
      }
    }

    // Score
    onProgress({ phase: 'score', msg: 'Scoring signals' });
    const onpage = scoreOnPage(signals);
    const technical = scoreTechnical(signals, perf);
    const content = scoreContent(signals);
    const offpage = scoreOffPage(signals, { robotsTxt: robotsProbe.ok, sitemap: sitemapFound });

    // Detailed blockers from Lighthouse + heuristics
    let blockers = [];
    if (global.SERPSCOPE?.blockers) {
      blockers = global.SERPSCOPE.blockers.enumerate(lighthouse, signals);
    }

    // Off-page authority via Moz Links API (if user provided a token).
    // We only fetch for the *target* by default — competitors are fetched
    // in batch from app.js so quota is controlled at the call site.
    let moz = null;
    if (opts.fetchMoz !== false && global.SERPSCOPE?.moz?.hasToken?.()) {
      onProgress({ phase: 'moz', msg: 'Fetching Moz authority data…' });
      try {
        moz = await global.SERPSCOPE.moz.lookup(url, { rich: opts.mozRich !== false });
        if (moz?.da != null) {
          onProgress({ phase: 'moz', msg: `   ✓ DA ${moz.da} · ${moz.linkingDomains || 0} linking domains` });
        }
      } catch (e) {
        onProgress({ phase: 'moz', msg: `   Moz lookup failed: ${e.message}` });
      }
    }

    // If we have real DA, blend it into the off-page score (50/50)
    // and compute the composite so the headline grade reflects it.
    if (moz?.da != null) {
      offpage.score = pct(offpage.score * 0.5 + moz.da * 0.5);
      offpage.daBoost = true;
    }
    const finalComposite = pct(
      onpage.score * WEIGHTS.onpage +
      technical.score * WEIGHTS.technical +
      content.score * WEIGHTS.content +
      offpage.score * WEIGHTS.offpage
    );

    return {
      url,
      host: signals.host,
      timestamp: Date.now(),
      signals,
      perf,
      lighthouse,
      blockers,
      moz,
      extras: { robotsTxt: robotsProbe.ok, sitemap: sitemapFound },
      categories: { onpage, technical, content, offpage },
      composite: finalComposite,
      grade: gradeOf(finalComposite),
    };
  }

  function gradeOf(n) {
    if (n >= 90) return 'A';
    if (n >= 80) return 'B';
    if (n >= 65) return 'C';
    if (n >= 50) return 'D';
    return 'F';
  }

  // ── Action generation ───────────────────────────────────────
  function generateActions(audit) {
    const a = [];
    const s = audit.signals;
    const cat = audit.categories;
    const push = (priority, category, title, problem, fix, steps, effort, impact, quickwin) => {
      a.push({ priority, category, title, problem, fix, steps, effort, impact, quickwin: !!quickwin });
    };

    // Title issues
    if (!s.title) push('P0', 'On-Page', 'Add a <title> tag', 'The page has no title — Google will use a generic fallback.', 'Insert a 50–60 char title containing your primary keyword.', ['Open the template file', 'Add <title>{{primary_keyword}} | {{brand}}</title>', 'Verify in browser tab'], '15 min', 95, true);
    else if (s.titleLen > 65) push('P1', 'On-Page', 'Shorten the title tag', `Current title is ${s.titleLen} chars; SERPs truncate after ~60.`, 'Trim to 50–60 characters, lead with the keyword.', ['Identify primary keyword', 'Rewrite within 60 chars', 'Re-verify pixel width'], '20 min', 75, true);
    else if (s.titleLen < 30) push('P2', 'On-Page', 'Expand the title tag', `Title is only ${s.titleLen} chars — wasted SERP real estate.`, 'Extend to 50–60 chars with a modifier (year, city, value-prop).', ['Add geographic or value modifier', 'Test in SERP simulator'], '15 min', 65, true);

    // Meta description
    if (!s.metaDesc) push('P0', 'On-Page', 'Write a meta description', 'No meta description — Google will auto-extract, often poorly.', 'Add a 140–160 char description with primary keyword and a CTA.', ['Draft in 155 chars', 'Include keyword + benefit + CTA', 'Add <meta name="description" content="..."> in <head>'], '20 min', 85, true);
    else if (s.descLen > 165 || s.descLen < 70) push('P1', 'On-Page', 'Optimize meta description length', `Current length ${s.descLen} chars (target 140–160).`, 'Rewrite to ~155 chars with stronger keyword + CTA.', ['Audit current text', 'Trim or expand to 140–160', 'Re-check SERP preview'], '15 min', 70, true);

    // H1
    if (s.headings.h1.length === 0) push('P0', 'On-Page', 'Add an H1 heading', 'Page has no H1 — search engines lose primary topic signal.', 'Wrap the page\'s main heading in <h1>, include the target keyword.', ['Locate the page\'s main visible heading', 'Change tag to <h1>', 'Ensure only ONE H1'], '15 min', 90, true);
    else if (s.headings.h1.length > 1) push('P1', 'On-Page', 'Reduce to a single H1', `${s.headings.h1.length} H1 tags found — dilutes hierarchy.`, 'Keep one H1; demote the rest to H2.', ['Identify all H1 tags', 'Demote secondary H1s to H2', 'Re-test'], '30 min', 70);

    // Image alts
    if (s.images.total > 0) {
      const cov = s.images.withAlt / s.images.total;
      if (cov < 0.6) push('P1', 'On-Page', 'Add alt attributes to images', `Only ${Math.round(cov*100)}% of ${s.images.total} images have alt text.`, 'Add descriptive alt text — keyword-rich where natural, empty for decorative.', ['List all images missing alt', 'Write 5–12 word descriptions', 'Mark decorative images alt=""'], '1–2 hrs', 75);
    }

    // Canonical
    if (!s.canonical) push('P1', 'Technical', 'Add canonical URL tag', 'Without rel="canonical", duplicate URLs can split ranking signals.', 'Add <link rel="canonical" href="..."> pointing to the preferred URL.', ['Decide preferred URL form', 'Add canonical tag in <head>', 'Test variants resolve correctly'], '30 min', 70);

    // HTTPS
    if (!s.isHttps) push('P0', 'Technical', 'Migrate to HTTPS', 'Site is served over HTTP — Google ranks HTTPS sites higher and browsers warn users.', 'Obtain a TLS certificate (Let\'s Encrypt is free) and 301 all HTTP to HTTPS.', ['Install Let\'s Encrypt certificate', 'Configure 301 redirects HTTP→HTTPS', 'Update internal links & sitemaps', 'Update Search Console property'], '2–4 hrs', 100);

    // Mixed content
    if (s.isHttps && s.mixedContent > 0) push('P0', 'Technical', 'Resolve mixed content', `${s.mixedContent} insecure resources break HTTPS guarantees.`, 'Update all http:// asset references to https:// or protocol-relative.', ['Run grep for http://', 'Update to https:// where supported', 'Self-host any that don\'t support HTTPS'], '1 hr', 90, true);

    // Mobile viewport
    if (!/width=device-width/i.test(s.viewport)) push('P0', 'Technical', 'Add responsive viewport meta', 'No mobile viewport meta — failed mobile-friendliness test means crippled mobile rankings.', 'Add <meta name="viewport" content="width=device-width, initial-scale=1">.', ['Add tag in <head>', 'Test on real mobile device', 'Run Mobile-Friendly Test'], '10 min', 95, true);

    // Robots noindex (unintentional)
    if (/noindex/i.test(s.robots)) push('P0', 'Technical', 'Remove noindex directive', 'Page is blocked from indexing — it cannot rank at all.', 'Verify this is intentional; if not, remove noindex from robots meta or HTTP header.', ['Confirm intent with stakeholders', 'Remove noindex meta tag', 'Re-request indexing in Search Console'], '15 min', 100, true);

    // Page weight
    const kb = s.htmlSize / 1024;
    if (kb > 400) push('P2', 'Technical', 'Reduce HTML payload', `HTML is ${kb.toFixed(0)}KB — affects TTFB and LCP.`, 'Defer non-critical markup, minify, and consider server-side rendering pruning.', ['Minify HTML', 'Inline only critical CSS', 'Defer below-fold sections'], '2–4 hrs', 60);

    // Scripts
    if (s.totalScripts > 25) push('P2', 'Technical', 'Audit JavaScript bloat', `${s.totalScripts} script tags — increases TBT and blocks rendering.`, 'Bundle, defer, or remove unused scripts; consider partial hydration.', ['Audit script payload', 'Defer non-critical scripts', 'Remove unused vendor code'], '1 day', 65);

    // Sitemap
    if (!audit.extras.sitemap) push('P1', 'Technical', 'Publish an XML sitemap', 'No sitemap detected — crawl coverage relies entirely on link graph.', 'Generate sitemap.xml, reference it in robots.txt, submit in Search Console.', ['Generate sitemap.xml', 'Add Sitemap: directive to robots.txt', 'Submit in GSC & Bing Webmaster'], '1 hr', 70, true);

    // robots.txt
    if (!audit.extras.robotsTxt) push('P2', 'Technical', 'Publish robots.txt', 'No robots.txt — crawlers fall back to defaults and you lose control over budget.', 'Publish robots.txt at the domain root with crawl rules and sitemap reference.', ['Create robots.txt', 'Reference sitemap', 'Disallow staging or admin paths'], '20 min', 50, true);

    // Lang
    if (!s.lang) push('P3', 'On-Page', 'Declare page language', 'No lang attribute on <html> — screen readers & translation tools struggle.', 'Add lang="en" (or appropriate locale) to <html>.', ['Add lang attribute to <html>'], '5 min', 40, true);

    // Schema
    if (s.ldjson === 0) push('P1', 'On-Page', 'Add JSON-LD structured data', 'No structured data — missing rich result eligibility.', 'Add Organization + WebSite + (page-type) schema as JSON-LD.', ['Pick relevant schema.org types', 'Generate JSON-LD blocks', 'Validate with Rich Results Test'], '2 hrs', 75);

    // Word count thin
    if (s.wordCount < 300) push('P0', 'Content', 'Address thin content', `Only ${s.wordCount} words — thin pages rarely rank for competitive terms.`, 'Expand to 800–1500 words covering search intent, FAQs, and related entities.', ['Map search intent for target query', 'Outline 6–10 sub-topics', 'Write to 1000+ words', 'Add FAQ section with schema'], '1 day', 90);

    // OG
    const ogCount = ['og:title', 'og:description', 'og:image', 'og:type'].filter((k) => s.og[k]).length;
    if (ogCount < 4) push('P2', 'On-Page', 'Complete Open Graph tags', `Only ${ogCount}/4 core OG tags — social shares look broken.`, 'Add og:title, og:description, og:image (1200×630), og:type.', ['Add missing og:* meta tags', 'Use 1200×630 og:image', 'Validate with Facebook Sharing Debugger'], '30 min', 60, true);

    // Twitter card
    if (!s.twitter['twitter:card']) push('P3', 'On-Page', 'Add Twitter Card tags', 'No twitter:card — Twitter (X) shares render as plain links.', 'Add twitter:card, twitter:title, twitter:description, twitter:image.', ['Add twitter:* meta tags', 'Validate with Twitter Card Validator'], '20 min', 40, true);

    // Social channels
    if (s.socials.length < 2) push('P2', 'Off-Page', 'Build social channel presence', `Only ${s.socials.length} social channels linked — weak brand entity signal.`, 'Link to active social profiles in footer and add sameAs in Organization schema.', ['Audit active channels', 'Link in footer', 'Add sameAs[] to Organization JSON-LD'], '1 hr', 55);

    // Internal links
    if (s.links.internal < 3) push('P1', 'On-Page', 'Improve internal linking', `Only ${s.links.internal} internal links — orphans hurt crawl & link equity.`, 'Add 5–15 contextual internal links to related pages.', ['Identify related pages', 'Add contextual in-content links', 'Audit anchor text diversity'], '2 hrs', 70);

    // hreflang for international
    // (skip if single locale assumed)

    // Performance via PSI
    if (audit.perf && audit.perf.performance != null && audit.perf.performance < 70) {
      push('P1', 'Technical', `Improve Core Web Vitals (PSI ${audit.perf.performance})`, `Lighthouse performance score is ${audit.perf.performance}/100. LCP ${audit.perf.lcp || '?'}, CLS ${audit.perf.cls || '?'}.`, 'Optimize LCP image, defer JS, reduce CLS via dimensioned images & reserved space.', ['Identify LCP element', 'Preload LCP asset', 'Defer non-critical JS', 'Add width/height to images', 'Inline critical CSS'], '1–3 days', 85);
    }

    // ── Accessibility ──────────────────────────────────────────
    if (s.a11y.inputs > 0 && s.a11y.labeledInputs < s.a11y.inputs) {
      const missing = s.a11y.inputs - s.a11y.labeledInputs;
      push('P1', 'On-Page', 'Label every form field', `${missing} of ${s.a11y.inputs} form fields have no associated <label> or aria-label.`, 'Associate every input with a visible <label for> or an aria-label so assistive tech can announce it.', ['Add <label for="id"> to each field', 'Use aria-label where a visible label is undesirable', 'Verify with a screen reader / Lighthouse a11y'], '1 hr', 60);
    }
    if (s.a11y.namelessButtons > 0) {
      push('P2', 'On-Page', 'Give buttons accessible names', `${s.a11y.namelessButtons} button(s) have no text or aria-label — opaque to assistive tech and voice control.`, 'Add visible text, an aria-label, or an alt-texted icon to every button.', ['Locate icon-only buttons', 'Add aria-label describing the action', 'Re-test in Lighthouse a11y'], '30 min', 50, true);
    }
    if (!s.a11y.headingOrderOk) {
      push('P2', 'On-Page', 'Fix heading level order', 'Heading levels skip (e.g. H1 → H3), breaking the document outline for screen readers and search parsers.', 'Use headings sequentially (H1→H2→H3) without skipping levels; control size with CSS, not tag choice.', ['Map the current heading sequence', 'Re-tag to remove skipped levels', 'Style visually with CSS'], '1 hr', 45);
    }

    // ── Link quality & safety ──────────────────────────────────
    if (s.structure.genericAnchors > 0) {
      push('P2', 'On-Page', 'Replace generic anchor text', `${s.structure.genericAnchors} links use vague text like "click here" or "read more".`, 'Use descriptive, keyword-relevant anchor text — it helps ranking, context, and accessibility.', ['Find generic anchors', 'Rewrite with descriptive phrasing', 'Keep anchors concise & unique'], '1 hr', 55);
    }
    if (s.security.unsafeBlankLinks > 0) {
      push('P2', 'Technical', 'Secure target="_blank" links', `${s.security.unsafeBlankLinks} links open new tabs without rel="noopener" — a reverse-tabnabbing risk.`, 'Add rel="noopener noreferrer" to every target="_blank" link.', ['Grep for target="_blank"', 'Append rel="noopener noreferrer"', 'Verify external links still open'], '20 min', 40, true);
    }

    // ── Performance / rendering ────────────────────────────────
    if (s.hints.renderBlockingJs > 3) {
      push('P1', 'Technical', 'Eliminate render-blocking JavaScript', `${s.hints.renderBlockingJs} scripts load synchronously, delaying first paint.`, 'Add async/defer to non-critical scripts or load them as type="module".', ['Identify synchronous <script src>', 'Add defer for order-dependent scripts', 'Add async for independent scripts'], '2 hrs', 70, true);
    }
    if (s.hints.preconnect + s.hints.preload === 0 && s.security.externalScripts > 0) {
      push('P2', 'Technical', 'Add resource hints', 'No preconnect/preload hints, yet the page loads third-party origins — connection setup sits on the critical path.', 'Add <link rel="preconnect"> for key third-party origins and preload the LCP image/font.', ['Identify critical third-party origins', 'Add preconnect for each', 'Preload the LCP asset & primary web font'], '30 min', 55, true);
    }
    if (s.hints.inlineScriptKB > 50) {
      push('P2', 'Technical', 'Externalize large inline scripts', `~${s.hints.inlineScriptKB}KB of inline JavaScript inflates the HTML document and blocks parsing.`, 'Move large inline scripts to cacheable external files loaded with defer.', ['Extract inline JS to .js files', 'Load with defer', 'Enable long-lived cache headers'], '2 hrs', 50);
    }
    if (s.images.total > 0 && s.images.dimensioned / s.images.total < 0.8) {
      push('P1', 'Technical', 'Set explicit image dimensions', `${s.images.total - s.images.dimensioned} of ${s.images.total} images lack width/height — a leading cause of layout shift (CLS).`, 'Add width and height attributes (or CSS aspect-ratio) to every image to reserve layout space.', ['Add width & height to <img>', 'Or set CSS aspect-ratio', 'Re-measure CLS in PageSpeed Insights'], '1–2 hrs', 70);
    }

    // ── Security headers ───────────────────────────────────────
    if (!s.security.csp) {
      push('P3', 'Technical', 'Add a Content Security Policy', 'No CSP detected — without one the page is more exposed to XSS and content injection.', 'Define a CSP via HTTP header (preferred) or a <meta http-equiv> tag, starting in Report-Only mode.', ['Inventory script/style/image origins', 'Draft a CSP in Report-Only mode', 'Monitor violations, then enforce'], '1 day', 45);
    }
    if (s.security.externalScripts > 0 && s.security.sriScripts < s.security.externalScripts) {
      push('P3', 'Technical', 'Add Subresource Integrity to CDN scripts', `${s.security.externalScripts - s.security.sriScripts} third-party scripts load without an integrity hash.`, 'Add integrity + crossorigin attributes so tampered CDN files are rejected by the browser.', ['Generate SRI hashes for each CDN asset', 'Add integrity & crossorigin attributes', 'Verify resources still load'], '1 hr', 35);
    }

    // ── Structured-data depth ──────────────────────────────────
    if (s.ldjson > 0 && !s.schemaTypes.some((t) => /BreadcrumbList/i.test(t))) {
      push('P2', 'On-Page', 'Add BreadcrumbList schema', 'No breadcrumb structured data — breadcrumbs earn richer SERP display and clarify site hierarchy.', 'Add BreadcrumbList JSON-LD reflecting the page\'s position in the site.', ['Map the breadcrumb trail', 'Emit BreadcrumbList JSON-LD', 'Validate with Rich Results Test'], '1 hr', 50);
    }
    if (s.structure.hasFaq && !s.schemaTypes.some((t) => /FAQPage|Question/i.test(t))) {
      push('P2', 'On-Page', 'Mark up FAQ content with schema', 'FAQ-style content exists but lacks FAQPage schema — you\'re leaving FAQ rich results on the table.', 'Wrap question/answer pairs in FAQPage JSON-LD.', ['Identify Q&A pairs', 'Generate FAQPage JSON-LD', 'Validate with Rich Results Test'], '1 hr', 55, true);
    }
    if (s.structure.videos > 0 && !s.schemaTypes.some((t) => /VideoObject/i.test(t))) {
      push('P3', 'On-Page', 'Add VideoObject schema', `${s.structure.videos} embedded video(s) without VideoObject markup — missing video rich results & Google Video indexing.`, 'Add VideoObject JSON-LD with name, description, thumbnailUrl, and uploadDate.', ['Collect video metadata', 'Emit VideoObject JSON-LD', 'Validate with Rich Results Test'], '1 hr', 40);
    }

    // ── E-E-A-T / authorship ───────────────────────────────────
    if (!s.metaExtra.author && !s.schemaTypes.some((t) => /Person|Author/i.test(t))) {
      push('P2', 'Off-Page', 'Add author / authorship signals', 'No author meta or Person schema — weak E-E-A-T, which Google weighs heavily for YMYL and expertise topics.', 'Add visible bylines, an author bio, and Article+Person JSON-LD with author details.', ['Add a visible author byline', 'Create author bio pages', 'Add author to Article JSON-LD'], '2 hrs', 55);
    }

    // ── Content scannability ───────────────────────────────────
    if (s.wordCount >= 600 && s.structure.lists === 0) {
      push('P2', 'Content', 'Break content into scannable lists', `${s.wordCount} words with no lists — dense prose lowers dwell time and comprehension.`, 'Convert dense passages into bulleted/numbered lists and add descriptive subheadings.', ['Identify enumerable passages', 'Convert to <ul>/<ol>', 'Add descriptive subheadings'], '1 hr', 45, true);
    }
    if (s.wordCount >= 1500 && !s.structure.hasToc) {
      push('P3', 'Content', 'Add a table of contents', `Long content (${s.wordCount} words) with no in-page table of contents hurts navigation and can earn jump-to links in SERPs.`, 'Add an anchored table of contents linking to each H2/H3 section.', ['Add IDs to section headings', 'Build a linked ToC at the top', 'Test anchor scrolling'], '1 hr', 40);
    }

    // ── PWA / mobile chrome ────────────────────────────────────
    if (!s.pwa.manifest) {
      push('P3', 'Technical', 'Add a web app manifest', 'No manifest.json — blocks installability and richer mobile presentation.', 'Add a manifest with name, icons, theme_color, and display, linked via <link rel="manifest">.', ['Create manifest.json', 'Reference it in <head>', 'Add maskable icons'], '1 hr', 35);
    }
    if (!s.pwa.appleTouchIcon) {
      push('P3', 'On-Page', 'Add an Apple touch icon', 'No apple-touch-icon — iOS home-screen bookmarks show a blurry screenshot instead of your brand mark.', 'Add a 180×180 apple-touch-icon link in <head>.', ['Export a 180×180 PNG icon', 'Add <link rel="apple-touch-icon">'], '15 min', 25, true);
    }

    // ── URL hygiene ────────────────────────────────────────────
    if (!s.urlInfo.cleanUrl) {
      push('P3', 'Technical', 'Improve URL structure', `URL uses ${s.urlInfo.underscores ? 'underscores ' : ''}${s.urlInfo.uppercase ? 'uppercase ' : ''}${s.urlInfo.depth > 4 ? 'deep nesting ' : ''}— hyphenated, lowercase, shallow URLs are clearer to users and crawlers.`, 'Adopt lowercase, hyphen-separated, shallow paths; 301-redirect legacy URLs.', ['Define a clean URL convention', '301-redirect old URLs', 'Update internal links & sitemap'], '2–4 hrs', 40);
    }

    // ── Deprecated meta ────────────────────────────────────────
    if (s.metaExtra.keywords) {
      push('P3', 'On-Page', 'Drop the meta keywords tag', 'A meta keywords tag is present — ignored by Google since 2009 and it can leak target terms to competitors.', 'Remove the meta keywords tag entirely.', ['Delete <meta name="keywords">'], '5 min', 15, true);
    }

    // ── International ───────────────────────────────────────────
    if (s.hreflang.length > 0 && !s.hreflang.some((h) => /x-default/i.test(h))) {
      push('P3', 'Technical', 'Add hreflang x-default', 'hreflang variants exist but no x-default — search engines lack a fallback for unmatched locales.', 'Add an hreflang="x-default" entry pointing to your default/global page.', ['Add the x-default alternate link', 'Validate hreflang cluster reciprocity'], '30 min', 35);
    }

    // ── WordPress-specific recommendations ──────────────────────
    if (s.wordpress.isWordPress) {
      // Warn if no sitemap (common WP issue)
      if (!audit.extras.sitemap) {
        push('P1', 'WordPress', 'Enable WordPress sitemaps', 'No XML sitemap detected — WordPress can auto-generate them if enabled.', 'Install a WordPress SEO plugin (Yoast, Rank Math, All in One SEO) or enable native WordPress sitemaps.', ['Activate WordPress SEO plugin or native sitemap', 'Verify sitemap at /wp-sitemap.xml or /sitemap.xml', 'Submit to Google Search Console'], '30 min', 75, true);
      }

      // Warn if WP REST API is exposed without need
      if (s.wordpress.hasRestApi) {
        push('P3', 'WordPress', 'Secure WordPress REST API access', 'WordPress REST API endpoint is publicly accessible — restricts to authenticated users if not needed.', 'If only admins need API access, disable with a plugin or remove the Link header from unauthenticated responses.', ['Check wp-json for public endpoints', 'Install REST API security plugin', 'Or add code to restrict unauthenticated access'], '1 hr', 35);
      }

      // Plugin update awareness
      if (s.wordpress.plugins.length > 0) {
        const pluginList = s.wordpress.plugins.slice(0, 5).join(', ') + (s.wordpress.plugins.length > 5 ? ` + ${s.wordpress.plugins.length - 5} more` : '');
        push('P2', 'WordPress', 'Keep plugins updated', `WordPress is running ${s.wordpress.plugins.length} plugins: ${pluginList}. Out-of-date plugins are a common vulnerability vector.`, 'Regularly update all plugins from the WordPress admin dashboard; remove unused plugins; audit for security.', ['Go to Plugins > Updates in WordPress admin', 'Update all available plugins', 'Deactivate & delete unused plugins', 'Run security scan (e.g., Wordfence)'], '30 min', 60);
      }

      // Theme update check
      if (s.wordpress.theme) {
        push('P2', 'WordPress', 'Verify theme is up to date', `Using theme: ${s.wordpress.theme}. Ensure it's regularly updated for security & compatibility.`, 'Check Appearance > Themes in WordPress admin for updates; enable automatic updates if available.', ['Dashboard > Appearance > Themes', 'Check for theme updates', 'Enable auto-updates if available'], '15 min', 55);
      }

      // Version exposure (security concern)
      if (s.wordpress.version) {
        push('P3', 'WordPress', 'Check WordPress version is current', `WordPress version ${s.wordpress.version} detected in header. If outdated, update immediately. If outdated, it exposes known vulnerabilities.`, 'Update WordPress to the latest stable version; enable automatic core updates in wp-config.php.', ['Dashboard > Updates', 'Check latest WordPress version', 'Enable: define(\'WP_AUTO_UPDATE_CORE\', true);'], '1 hr', 65);
      }

      // Comments form optimization for SEO
      if (s.wordpress.hasComments) {
        push('P3', 'WordPress', 'Optimize comments for SEO', 'WordPress comments detected — moderate spam, enable structured data for comments, and ensure comment content doesn\'t leak private info.', 'Enable comment moderation, add schema.org/Comment markup, configure gravatar caching, and consider disabling on non-blog pages.', ['Enable comment moderation in Settings', 'Consider Comment Author Name Relay in SEO plugin', 'Disable comments on non-blog pages'], '2 hrs', 40);
      }
    }

    // Sort by composite priority value
    const order = { P0: 0, P1: 1, P2: 2, P3: 3 };
    a.sort((x, y) => order[x.priority] - order[y.priority] || y.impact - x.impact);
    return a;
  }

  // ── Build audit items for the UI grid ──────────────────────
  function buildAuditItems(audit) {
    const s = audit.signals;
    const groups = { onpage: [], technical: [], content: [], offpage: [], a11y: [], wordpress: [] };
    const push = (g, status, title, detail, value) => groups[g].push({ status, title, detail, value });

    // On-page
    push('onpage', s.title ? (s.titleLen >= 30 && s.titleLen <= 65 ? 'pass' : 'warn') : 'fail',
      'Title Tag', s.title || '— missing —', `${s.titleLen} ch`);
    push('onpage', s.metaDesc ? (s.descLen >= 70 && s.descLen <= 165 ? 'pass' : 'warn') : 'fail',
      'Meta Description', s.metaDesc || '— missing —', `${s.descLen} ch`);
    push('onpage', s.headings.h1.length === 1 ? 'pass' : (s.headings.h1.length === 0 ? 'fail' : 'warn'),
      'H1 Heading', s.headings.h1[0] || '— missing —', `${s.headings.h1.length}`);
    push('onpage', 'info', 'Heading Hierarchy',
      `H2: ${s.headings.h2.length}, H3: ${s.headings.h3.length}, H4: ${s.headings.h4.length}`,
      `${s.headings.h1.length + s.headings.h2.length + s.headings.h3.length}`);
    push('onpage', s.canonical ? 'pass' : 'warn', 'Canonical', s.canonical || 'not set', s.canonical ? 'set' : '—');
    const ogCount = ['og:title','og:description','og:image','og:type'].filter(k=>s.og[k]).length;
    push('onpage', ogCount === 4 ? 'pass' : (ogCount >= 2 ? 'warn' : 'fail'),
      'Open Graph', `${ogCount}/4 core tags · image: ${s.og['og:image'] ? 'yes' : 'no'}`, `${ogCount}/4`);
    push('onpage', s.twitter['twitter:card'] ? 'pass' : 'warn',
      'Twitter Card', s.twitter['twitter:card'] || 'not set', s.twitter['twitter:card'] || '—');
    push('onpage', s.images.total === 0 ? 'info' : (s.images.withAlt / s.images.total >= 0.9 ? 'pass' : 'warn'),
      'Image Alt Coverage', `${s.images.withAlt}/${s.images.total} have alt`,
      s.images.total ? `${Math.round(s.images.withAlt/s.images.total*100)}%` : '—');
    push('onpage', s.links.internal >= 5 ? 'pass' : 'warn', 'Internal Links', `${s.links.internal} on page`, `${s.links.internal}`);
    push('onpage', 'info', 'External Links', `${s.links.external} outbound · ${s.links.nofollow} nofollow`, `${s.links.external}`);
    push('onpage', s.ldjson > 0 ? 'pass' : 'warn',
      'Structured Data',
      s.ldjson ? `${s.ldjson} JSON-LD blocks · ${s.schemaTypes.slice(0,4).join(', ') || 'untyped'}` : 'no JSON-LD',
      `${s.ldjson}`);
    push('onpage', s.lang ? 'pass' : 'warn', 'Language', s.lang || 'not declared', s.lang || '—');
    push('onpage', s.urlInfo.cleanUrl ? 'pass' : 'warn', 'URL Structure',
      `depth ${s.urlInfo.depth}${s.urlInfo.underscores ? ' · underscores' : ''}${s.urlInfo.uppercase ? ' · uppercase' : ''}`,
      s.urlInfo.cleanUrl ? 'clean' : '!');
    push('onpage', s.alignment.titleH1Overlap >= 0.3 ? 'pass' : 'warn', 'Title ↔ H1 Alignment',
      `${Math.round(s.alignment.titleH1Overlap * 100)}% shared keywords`, `${Math.round(s.alignment.titleH1Overlap * 100)}%`);
    push('onpage', s.metaExtra.author ? 'pass' : 'info', 'Author Meta', s.metaExtra.author || 'not set', s.metaExtra.author ? 'set' : '—');

    // Technical
    push('technical', s.isHttps ? 'pass' : 'fail', 'HTTPS', s.isHttps ? 'TLS enabled' : 'HTTP only', s.isHttps ? 'on' : 'off');
    push('technical', /width=device-width/i.test(s.viewport) ? 'pass' : 'fail',
      'Mobile Viewport', s.viewport || 'not set', /width=device-width/i.test(s.viewport) ? 'OK' : '—');
    push('technical', /noindex/i.test(s.robots) ? 'fail' : 'pass',
      'Robots Meta', s.robots || 'default (index, follow)', /noindex/i.test(s.robots) ? 'noindex' : 'OK');
    push('technical', audit.extras.robotsTxt ? 'pass' : 'warn',
      'robots.txt', audit.extras.robotsTxt ? 'found at root' : 'not found', audit.extras.robotsTxt ? 'OK' : '—');
    push('technical', audit.extras.sitemap ? 'pass' : 'warn',
      'XML Sitemap', audit.extras.sitemap ? 'discovered' : 'not discovered', audit.extras.sitemap ? 'OK' : '—');
    push('technical', s.fetchMs < 2000 ? 'pass' : (s.fetchMs < 4000 ? 'warn' : 'fail'),
      'Fetch Latency', `via CORS proxy (not direct origin time)`, `${(s.fetchMs/1000).toFixed(2)}s`);
    push('technical', (s.htmlSize/1024) < 300 ? 'pass' : 'warn',
      'HTML Payload', `${(s.htmlSize/1024).toFixed(1)} KB raw markup`, `${(s.htmlSize/1024).toFixed(0)}KB`);
    push('technical', s.totalScripts < 20 ? 'pass' : 'warn',
      'Script Count', `${s.totalScripts} <script> tags`, `${s.totalScripts}`);
    push('technical', s.stylesheets < 8 ? 'pass' : 'warn',
      'Stylesheets', `${s.stylesheets} external + ${s.inlineStyles} inline`, `${s.stylesheets}`);
    push('technical', s.isHttps && s.mixedContent === 0 ? 'pass' : (s.mixedContent > 0 ? 'fail' : 'info'),
      'Mixed Content', s.mixedContent > 0 ? `${s.mixedContent} insecure assets` : 'none', `${s.mixedContent}`);
    push('technical', s.images.total === 0 ? 'info' : (s.images.modern/s.images.total >= 0.3 ? 'pass' : 'warn'),
      'Modern Image Formats', `${s.images.modern}/${s.images.total} WebP/AVIF`, `${s.images.modern}`);
    push('technical', s.hreflang.length > 0 ? 'pass' : 'info',
      'hreflang', s.hreflang.length ? s.hreflang.join(', ') : 'single locale', `${s.hreflang.length}`);
    push('technical', s.images.total === 0 ? 'info' : (s.images.dimensioned / s.images.total >= 0.8 ? 'pass' : 'warn'),
      'Image Dimensions (CLS)', `${s.images.dimensioned}/${s.images.total} have width+height`, `${s.images.dimensioned}`);
    push('technical', s.hints.renderBlockingJs === 0 ? 'pass' : 'warn',
      'Render-Blocking JS', `${s.hints.renderBlockingJs} blocking · ${s.hints.asyncScripts} async · ${s.hints.deferScripts} defer`, `${s.hints.renderBlockingJs}`);
    if (audit.perf) {
      push('technical', audit.perf.performance >= 80 ? 'pass' : (audit.perf.performance >= 50 ? 'warn' : 'fail'),
        'PSI Performance', `LCP ${audit.perf.lcp || '?'} · CLS ${audit.perf.cls || '?'} · TBT ${audit.perf.tbt || '?'}`,
        `${audit.perf.performance}`);
    }

    // Content
    push('content', s.wordCount >= 600 ? 'pass' : (s.wordCount >= 300 ? 'warn' : 'fail'),
      'Word Count', `${s.sentenceCount} sentences`, `${s.wordCount} w`);
    push('content', s.flesch >= 60 && s.flesch <= 80 ? 'pass' : 'warn',
      'Readability (Flesch)', readingLevel(s.flesch), `${s.flesch.toFixed(0)}`);
    const totalH = s.headings.h1.length + s.headings.h2.length + s.headings.h3.length;
    push('content', totalH >= 4 ? 'pass' : (totalH >= 2 ? 'warn' : 'fail'),
      'Sectioning', `${totalH} top-level headings`, `${totalH}`);
    push('content', 'info', 'Top Keywords',
      s.topKeywords.slice(0, 6).map(([w, n]) => `${w}(${n})`).join(', ') || '—',
      `${s.topKeywords.length}`);
    if (s.topKeywords[0]) {
      const dens = (s.topKeywords[0][1] / Math.max(1, s.wordCount)) * 100;
      push('content', dens >= 0.5 && dens <= 3 ? 'pass' : 'warn',
        'Top Keyword Density', `"${s.topKeywords[0][0]}" appears ${s.topKeywords[0][1]}×`, `${dens.toFixed(2)}%`);
    }
    push('content', s.images.total >= 3 ? 'pass' : 'warn',
      'Multimedia', `${s.images.total} images`, `${s.images.total}`);
    push('content', 'info', 'Forms', `${s.forms} forms on page (lead-capture proxy)`, `${s.forms}`);
    push('content', 'info', 'Reading Time', `~${s.structure.readingTime} min at 200 wpm`, `${s.structure.readingTime}m`);
    push('content', s.structure.lists >= 1 ? 'pass' : 'warn', 'Lists & Scannability',
      `${s.structure.lists} lists · ${s.structure.paragraphs} paragraphs`, `${s.structure.lists}`);
    push('content', s.structure.hasFaq ? 'pass' : 'info', 'FAQ Content',
      s.structure.hasFaq ? 'detected' : 'none detected', s.structure.hasFaq ? 'OK' : '—');
    push('content', 'info', 'Rich Media',
      `${s.structure.videos} video · ${s.images.total} img · ${s.structure.tables} tables`, `${s.structure.videos}`);

    // Off-page
    push('offpage', s.socials.length >= 3 ? 'pass' : (s.socials.length >= 1 ? 'warn' : 'fail'),
      'Social Channels', s.socials.length ? s.socials.join(', ') : 'none linked', `${s.socials.length}`);
    push('offpage', 'info', 'Domain', s.host, s.host.split('.').pop());
    push('offpage', s.og['og:site_name'] ? 'pass' : 'warn',
      'Brand Entity', s.og['og:site_name'] || 'no og:site_name', s.og['og:site_name'] ? 'set' : '—');
    push('offpage', s.schemaTypes.some(t => /Organization|WebSite/i.test(t)) ? 'pass' : 'warn',
      'Organization Schema',
      s.schemaTypes.filter(t => /Organization|WebSite|LocalBusiness/i.test(t)).join(', ') || 'not declared',
      s.schemaTypes.some(t => /Organization/i.test(t)) ? 'OK' : '—');
    push('offpage', s.links.external >= 3 && s.links.external <= 30 ? 'pass' : 'warn',
      'Outbound Citations', `${s.links.external} external links`, `${s.links.external}`);
    push('offpage', 'info', 'E-E-A-T Markers',
      /(author|byline|reviewed by|about us)/i.test(s.bodyText) ? 'author/about signals present' : 'weak — consider adding author bylines & about page',
      /(author|byline|reviewed by|about us)/i.test(s.bodyText) ? 'OK' : '—');

    // Accessibility & Best Practices
    push('a11y', s.a11y.inputs === 0 ? 'info' : (s.a11y.labeledInputs >= s.a11y.inputs ? 'pass' : 'fail'),
      'Form Labels', s.a11y.inputs ? `${s.a11y.labeledInputs}/${s.a11y.inputs} fields labeled` : 'no form fields',
      `${s.a11y.labeledInputs}/${s.a11y.inputs}`);
    push('a11y', s.a11y.namelessButtons === 0 ? 'pass' : 'warn', 'Button Names',
      s.a11y.namelessButtons ? `${s.a11y.namelessButtons} lack an accessible name` : 'all buttons named', `${s.a11y.namelessButtons}`);
    push('a11y', s.a11y.headingOrderOk ? 'pass' : 'warn', 'Heading Order',
      s.a11y.headingOrderOk ? 'no skipped levels' : 'skipped heading levels', s.a11y.headingOrderOk ? 'OK' : '!');
    push('a11y', s.a11y.skipLink ? 'pass' : 'info', 'Skip Link',
      s.a11y.skipLink ? 'skip-to-content present' : 'no skip link', s.a11y.skipLink ? 'OK' : '—');
    push('a11y', s.a11y.ariaLabels > 0 ? 'pass' : 'info', 'ARIA Labels',
      `${s.a11y.ariaLabels} aria-label/labelledby · ${s.a11y.roles} roles`, `${s.a11y.ariaLabels}`);
    push('a11y', s.structure.genericAnchors === 0 ? 'pass' : 'warn', 'Anchor Text',
      s.structure.genericAnchors ? `${s.structure.genericAnchors} generic ("click here")` : 'descriptive', `${s.structure.genericAnchors}`);
    push('a11y', s.security.unsafeBlankLinks === 0 ? 'pass' : 'warn', 'Link Safety',
      s.security.unsafeBlankLinks ? `${s.security.unsafeBlankLinks} target=_blank without noopener` : 'safe', `${s.security.unsafeBlankLinks}`);
    push('a11y', s.security.csp ? 'pass' : 'info', 'Content Security Policy',
      s.security.csp ? 'CSP meta present' : 'no CSP meta (often set via headers)', s.security.csp ? 'OK' : '—');
    push('a11y', s.security.externalScripts === 0 ? 'info' : (s.security.sriScripts >= s.security.externalScripts ? 'pass' : 'warn'),
      'Subresource Integrity', s.security.externalScripts ? `${s.security.sriScripts}/${s.security.externalScripts} third-party scripts` : 'no third-party JS',
      `${s.security.sriScripts}/${s.security.externalScripts}`);
    push('a11y', s.hints.renderBlockingJs === 0 ? 'pass' : 'warn', 'Render-Blocking JS',
      `${s.hints.renderBlockingJs} blocking · ${s.hints.asyncScripts} async · ${s.hints.deferScripts} defer`, `${s.hints.renderBlockingJs}`);
    push('a11y', (s.hints.preconnect + s.hints.preload) > 0 ? 'pass' : 'info', 'Resource Hints',
      `${s.hints.preconnect} preconnect · ${s.hints.preload} preload · ${s.hints.dnsPrefetch} dns-prefetch`, `${s.hints.preconnect + s.hints.preload}`);
    push('a11y', s.pwa.manifest ? 'pass' : 'info', 'Web App Manifest',
      s.pwa.manifest ? 'manifest linked' : 'no manifest', s.pwa.manifest ? 'OK' : '—');
    push('a11y', s.pwa.appleTouchIcon ? 'pass' : 'info', 'Apple Touch Icon',
      s.pwa.appleTouchIcon ? 'present' : 'missing', s.pwa.appleTouchIcon ? 'OK' : '—');
    push('a11y', s.pwa.themeColor ? 'pass' : 'info', 'Theme Color',
      s.pwa.themeColor ? 'set' : 'not set', s.pwa.themeColor ? 'OK' : '—');

    // WordPress Platform
    if (s.wordpress.isWordPress) {
      push('wordpress', 'info', 'Platform Detected', 'WordPress detected', 'WP');
      if (s.wordpress.version) {
        push('wordpress', 'info', 'WordPress Version', `v${s.wordpress.version}`, `${s.wordpress.version}`);
      }
      if (s.wordpress.theme) {
        push('wordpress', 'info', 'Theme', `${s.wordpress.theme}`, s.wordpress.theme);
      }
      if (s.wordpress.plugins.length > 0) {
        push('wordpress', s.wordpress.plugins.length <= 5 ? 'pass' : (s.wordpress.plugins.length <= 15 ? 'warn' : 'fail'),
          'Plugins', `${s.wordpress.plugins.length} plugin${s.wordpress.plugins.length !== 1 ? 's' : ''}: ${s.wordpress.plugins.slice(0, 3).join(', ')}${s.wordpress.plugins.length > 3 ? '...' : ''}`,
          `${s.wordpress.plugins.length}`);
      }
      if (s.wordpress.hasRestApi) {
        push('wordpress', 'warn', 'REST API Exposure', 'WordPress REST API publicly accessible', 'exposed');
      }
      if (s.wordpress.hasComments) {
        push('wordpress', 'info', 'Comments Enabled', 'Comment forms detected on page', 'enabled');
      }
    }

    return groups;
  }

  function readingLevel(f) {
    if (f >= 90) return 'Very easy (5th grade)';
    if (f >= 80) return 'Easy (6th grade)';
    if (f >= 70) return 'Fairly easy (7th)';
    if (f >= 60) return 'Plain English (8–9th)';
    if (f >= 50) return 'Fairly difficult (10–12th)';
    if (f >= 30) return 'Difficult (college)';
    return 'Very difficult (graduate)';
  }

  // Expose
  global.SERPSCOPE = global.SERPSCOPE || {};
  global.SERPSCOPE.analyzer = {
    auditSite, generateActions, buildAuditItems,
    normalizeUrl, domainOf, gradeOf, WEIGHTS,
    // Internal — exposed so other modules (competitors.js, scheduler) can
    // share the resilient multi-proxy fetch chain.
    _probe: probeHead,
    _fetchPage: fetchPage,
  };
})(window);
