/* ===========================================================
 * SERPSCOPE — Site Crawler
 *
 * Discovers and audits *every* reachable page of a site so the
 * SEO analysis covers the whole property, not just the homepage.
 *
 * Discovery is sitemap-first, then internal-link BFS:
 *   1. Parse robots.txt → Sitemap: directives + Disallow rules
 *   2. Fetch + parse sitemap.xml (recursing <sitemapindex>)
 *   3. Breadth-first follow internal links to fill any gap
 *      up to the page cap.
 *
 * Each page is audited with the shared analyzer in a lightweight
 * mode (no PSI / Moz / per-page robots probe — one fetch each),
 * then aggregated into a site-wide report that surfaces issues
 * only visible across pages: duplicate titles / descriptions /
 * H1s, thin pages, missing meta, noindex leaks, missing
 * canonicals, and potential orphan pages.
 *
 * All client-side, through the same resilient multi-proxy fetch.
 * =========================================================== */

(function (global) {
  'use strict';

  const A = () => global.SERPSCOPE.analyzer;

  function rootDomain(host) {
    const fn = global.SERPSCOPE.competitors && global.SERPSCOPE.competitors.rootDomain;
    return fn ? fn(host) : String(host).replace(/^www\./i, '').toLowerCase();
  }

  function sameSite(a, b) {
    try { return rootDomain(new URL(a).hostname) === rootDomain(new URL(b).hostname); } catch { return false; }
  }

  // Strip the fragment; keep the query (some sites paginate via ?page=).
  function normUrl(u) {
    try { const x = new URL(u); x.hash = ''; return x.href; } catch { return null; }
  }

  // ── robots.txt ─────────────────────────────────────────────
  // Collect global Sitemap: directives and the Disallow rules that
  // apply to the `*` (all-crawler) group. Deliberately conservative:
  // when a rule is ambiguous we err toward allowing the fetch.
  function parseRobots(txt) {
    const sitemaps = [], disallow = [];
    let inStar = false;
    txt.split(/\r?\n/).forEach((line) => {
      const l = line.replace(/#.*$/, '').trim();
      if (!l) return;
      const m = l.match(/^([a-z-]+)\s*:\s*(.*)$/i);
      if (!m) return;
      const key = m[1].toLowerCase(), val = m[2].trim();
      if (key === 'sitemap') { if (val) sitemaps.push(val); return; }
      if (key === 'user-agent') { inStar = (val === '*'); return; }
      if (key === 'disallow' && inStar && val) disallow.push(val);
    });
    return { sitemaps, disallow };
  }

  function isDisallowed(url, disallow) {
    if (!disallow || !disallow.length) return false;
    let path;
    try { path = new URL(url).pathname; } catch { return false; }
    return disallow.some((rule) => {
      // Treat a leading wildcard segment loosely; match on the literal prefix.
      const prefix = rule.split('*')[0];
      if (prefix === '/') return false; // "Disallow: /" with a wildcard is too broad to honor blindly here
      return prefix && path.startsWith(prefix);
    });
  }

  // ── Sitemaps ───────────────────────────────────────────────
  // Extract <loc> values via regex — robust against XML namespace
  // quirks and proxy wrapping. Recurse sitemap indexes up to a cap.
  function extractLocs(xml) {
    const out = [];
    const re = /<loc>\s*([^<]+?)\s*<\/loc>/gi;
    let m;
    while ((m = re.exec(xml))) out.push(m[1].replace(/&amp;/g, '&').trim());
    return out;
  }

  async function collectSitemap(url, proxyKey, budget, depth = 0) {
    if (budget.fetches <= 0 || depth > 3) return [];
    budget.fetches--;
    let res;
    try { res = await A()._probe(url, proxyKey); } catch { return []; }
    if (!res || !res.ok || !res.text) return [];
    const xml = res.text;
    const isIndex = /<sitemapindex/i.test(xml);
    const locs = extractLocs(xml);
    if (isIndex) {
      const pages = [];
      for (const sm of locs) {
        if (budget.fetches <= 0) break;
        const child = await collectSitemap(sm, proxyKey, budget, depth + 1);
        pages.push(...child);
        if (pages.length >= budget.maxUrls) break;
      }
      return pages;
    }
    return locs;
  }

  // ── Crawl ──────────────────────────────────────────────────
  async function crawlSite(startUrl, opts = {}) {
    const proxy = opts.proxy || 'allorigins';
    const maxPages = Math.max(1, Math.min(opts.maxPages || 75, 200));
    const includeLinks = opts.includeLinks !== false;
    const includeSitemap = opts.includeSitemap !== false;
    const seedAudit = opts.seedAudit || null;
    const onProgress = opts.onProgress || (() => {});

    const origin = new URL(startUrl).origin;

    // 1. robots.txt
    let disallow = [], sitemaps = [], robotsOk = false;
    onProgress({ msg: 'Reading robots.txt' });
    const robots = await A()._probe(origin + '/robots.txt', proxy).catch(() => ({ ok: false }));
    if (robots && robots.ok) {
      robotsOk = true;
      const p = parseRobots(robots.text || '');
      disallow = p.disallow;
      sitemaps = p.sitemaps;
    }
    if (!sitemaps.length) sitemaps = [origin + '/sitemap.xml', origin + '/sitemap_index.xml'];

    // 2. Sitemap URLs
    let sitemapUrls = [];
    if (includeSitemap) {
      onProgress({ msg: `Parsing ${sitemaps.length} sitemap source(s)` });
      const budget = { fetches: 12, maxUrls: maxPages * 4 };
      for (const sm of sitemaps) {
        if (budget.fetches <= 0 || sitemapUrls.length >= budget.maxUrls) break;
        const found = await collectSitemap(sm, proxy, budget).catch(() => []);
        sitemapUrls.push(...found);
      }
    }
    sitemapUrls = Array.from(new Set(
      sitemapUrls.map(normUrl).filter(Boolean)
        .filter((u) => sameSite(u, startUrl) && !isDisallowed(u, disallow))
    ));
    onProgress({ msg: `   ${sitemapUrls.length} URL(s) in sitemap(s)`, level: sitemapUrls.length ? 'done' : 'warn' });

    // 3. Integrated audit + internal-link BFS
    const visited = new Set();
    const queued = new Set();
    const pages = [];
    const failed = [];
    const linkTargets = new Set();
    const queue = [];

    const enqueue = (u) => {
      const n = normUrl(u);
      if (!n || !sameSite(n, startUrl) || visited.has(n) || queued.has(n) || isDisallowed(n, disallow)) return;
      queued.add(n);
      queue.push(n);
    };

    enqueue(startUrl);
    sitemapUrls.forEach(enqueue);

    while (pages.length < maxPages && queue.length) {
      const u = queue.shift();
      if (visited.has(u)) continue;
      visited.add(u);

      let audit = null;
      if (seedAudit && normUrl(seedAudit.url) === u) {
        audit = seedAudit;
      } else {
        try {
          audit = await A().auditSite(u, {
            proxy, usePsi: false, fetchMoz: false, probeRobots: false,
            onProgress: () => {},
          });
        } catch (e) {
          failed.push({ url: u, error: e.message });
          onProgress({ msg: `   ✕ [${pages.length}/${maxPages}] ${u} — ${e.message}`, level: 'fail' });
          continue;
        }
      }

      pages.push(audit);
      (audit.signals && audit.signals.internalLinks || []).forEach((l) => {
        const n = normUrl(l);
        if (n) linkTargets.add(n);
      });
      onProgress({ msg: `   ✓ [${pages.length}/${maxPages}] ${u} — ${audit.composite} (${audit.grade})`, level: 'done' });

      if (includeLinks) (audit.signals && audit.signals.internalLinks || []).forEach(enqueue);
    }

    // Potential orphans: present in the sitemap but never linked from any
    // page we crawled (and not the entry page itself).
    const start = normUrl(startUrl);
    const orphans = sitemapUrls.filter((u) => !linkTargets.has(u) && normUrl(u) !== start);

    return {
      startUrl,
      pages,
      failed,
      crawled: pages.length,
      sitemapCount: sitemapUrls.length,
      discovered: visited.size,
      orphans,
      disallow,
      sitemaps,
      robotsOk,
      capped: queue.length > 0,
    };
  }

  // ── Site-wide aggregation ──────────────────────────────────
  function analyzeSiteWide(cr) {
    const pages = cr.pages || [];
    const byTitle = {}, byDesc = {}, byH1 = {};
    const missingTitle = [], missingDesc = [], missingH1 = [];
    const thinPages = [], noindexPages = [], missingCanonical = [], httpPages = [];
    let sumComposite = 0;

    const bump = (map, key, url) => { (map[key] || (map[key] = [])).push(url); };

    pages.forEach((p) => {
      const s = p.signals || {};
      sumComposite += p.composite || 0;
      const title = (s.title || '').trim();
      const desc = (s.metaDesc || '').trim();
      const h1 = (s.headings && s.headings.h1[0] || '').trim();
      if (title) bump(byTitle, title, p.url); else missingTitle.push(p.url);
      if (desc) bump(byDesc, desc, p.url); else missingDesc.push(p.url);
      if (h1) bump(byH1, h1, p.url); else missingH1.push(p.url);
      if ((s.wordCount || 0) < 300) thinPages.push({ url: p.url, words: s.wordCount || 0 });
      if (/noindex/i.test(s.robots || '')) noindexPages.push(p.url);
      if (!s.canonical) missingCanonical.push(p.url);
      if (s.isHttps === false) httpPages.push(p.url);
    });

    const dups = (map) => Object.entries(map)
      .filter(([, urls]) => urls.length > 1)
      .map(([value, urls]) => ({ value, urls }))
      .sort((a, b) => b.urls.length - a.urls.length);

    const ranked = pages.slice().sort((a, b) => (a.composite || 0) - (b.composite || 0));

    return {
      pageCount: pages.length,
      avgComposite: pages.length ? Math.round(sumComposite / pages.length) : 0,
      duplicateTitles: dups(byTitle),
      duplicateDescriptions: dups(byDesc),
      duplicateH1s: dups(byH1),
      missingTitle, missingDesc, missingH1,
      thinPages: thinPages.sort((a, b) => a.words - b.words),
      noindexPages, missingCanonical, httpPages,
      orphans: cr.orphans || [],
      failed: cr.failed || [],
      worst: ranked.slice(0, 5),
      best: ranked.slice(-5).reverse(),
      capped: cr.capped,
      sitemapCount: cr.sitemapCount,
      robotsOk: cr.robotsOk,
    };
  }

  // ── Site-wide action plan ──────────────────────────────────
  // These complement the per-page action plan with issues that only
  // exist at the site level (cross-page duplication, coverage gaps).
  function generateSiteActions(site) {
    const a = [];
    const push = (priority, category, title, problem, fix, steps, effort, impact, quickwin) =>
      a.push({ priority, category, title, problem, fix, steps, effort, impact, quickwin: !!quickwin });

    if (site.duplicateTitles.length) {
      const n = site.duplicateTitles.reduce((s, d) => s + d.urls.length, 0);
      push('P1', 'On-Page', 'Eliminate duplicate title tags',
        `${n} pages share ${site.duplicateTitles.length} duplicated title(s) — Google may treat them as near-duplicates and pick its own.`,
        'Give every indexable page a unique, descriptive title with its primary keyword.',
        ['Export the duplicate-title list below', 'Rewrite each title to be page-specific', 'Re-crawl to confirm uniqueness'],
        '2–4 hrs', 80);
    }
    if (site.duplicateDescriptions.length) {
      const n = site.duplicateDescriptions.reduce((s, d) => s + d.urls.length, 0);
      push('P2', 'On-Page', 'Write unique meta descriptions',
        `${n} pages reuse ${site.duplicateDescriptions.length} meta description(s), wasting SERP snippet real estate.`,
        'Author a distinct 140–160 char description per page with its own keyword + CTA.',
        ['Identify duplicated descriptions', 'Draft unique copy per page', 'Re-crawl to verify'],
        '2–4 hrs', 60);
    }
    if (site.missingTitle.length) {
      push('P0', 'On-Page', 'Add titles to untitled pages',
        `${site.missingTitle.length} crawled page(s) have no <title> tag.`,
        'Add a unique, keyword-led title to every page.',
        ['Review the missing-title list', 'Add <title> to each template/page', 'Re-crawl'],
        '1–2 hrs', 90, true);
    }
    if (site.missingDesc.length) {
      push('P2', 'On-Page', 'Fill in missing meta descriptions',
        `${site.missingDesc.length} crawled page(s) have no meta description.`,
        'Add a compelling 140–160 char description to each page.',
        ['Review the missing-description list', 'Write per-page descriptions', 'Re-crawl'],
        '2–3 hrs', 55);
    }
    if (site.missingH1.length) {
      push('P1', 'On-Page', 'Add an H1 to every page',
        `${site.missingH1.length} crawled page(s) lack an H1 heading.`,
        'Add exactly one descriptive H1 per page reflecting its primary topic.',
        ['Review the missing-H1 list', 'Add a single H1 to each', 'Re-crawl'],
        '1–2 hrs', 70);
    }
    if (site.thinPages.length) {
      push('P1', 'Content', 'Expand or consolidate thin pages',
        `${site.thinPages.length} crawled page(s) have under 300 words — thin content rarely ranks and can dilute site quality.`,
        'Expand thin pages to fully satisfy intent, or consolidate/redirect low-value ones.',
        ['Review the thin-page list', 'Expand keepers to 600+ words', 'Consolidate or 301-redirect the rest'],
        '1–3 days', 65);
    }
    if (site.noindexPages.length) {
      push('P1', 'Technical', 'Review noindex pages',
        `${site.noindexPages.length} crawled page(s) carry a noindex directive — confirm none of these should rank.`,
        'Audit each noindex page; remove the directive from any that should be indexable.',
        ['Review the noindex list', 'Confirm intent per URL', 'Remove unintended noindex & request re-indexing'],
        '1 hr', 75, true);
    }
    if (site.missingCanonical.length) {
      push('P2', 'Technical', 'Add canonical tags site-wide',
        `${site.missingCanonical.length} crawled page(s) have no rel="canonical" — duplicate/variant URLs can split ranking signals.`,
        'Emit a self-referential canonical on every page (templated).',
        ['Add a canonical tag to the page template', 'Verify variants (trailing slash, params) canonicalize correctly', 'Re-crawl'],
        '2 hrs', 55);
    }
    if (site.orphans.length) {
      push('P2', 'On-Page', 'Link to orphan pages',
        `${site.orphans.length} sitemap URL(s) weren't linked from any crawled page — orphans get little crawl equity.`,
        'Add contextual internal links (and nav/hub links) so every important page is reachable.',
        ['Review the orphan list', 'Add internal links from relevant pages', 'Re-crawl to confirm reachability'],
        '2–4 hrs', 50);
    }
    if (site.httpPages.length) {
      push('P0', 'Technical', 'Serve every page over HTTPS',
        `${site.httpPages.length} crawled page(s) were reached over plain HTTP.`,
        'Force HTTPS site-wide with 301 redirects and HSTS.',
        ['Install/verify TLS', '301 all HTTP→HTTPS', 'Add HSTS header'],
        '2–4 hrs', 95);
    }

    const order = { P0: 0, P1: 1, P2: 2, P3: 3 };
    a.sort((x, y) => order[x.priority] - order[y.priority] || y.impact - x.impact);
    return a;
  }

  global.SERPSCOPE = global.SERPSCOPE || {};
  global.SERPSCOPE.crawler = {
    crawlSite, analyzeSiteWide, generateSiteActions,
    // internals exposed for testing
    _parseRobots: parseRobots, _isDisallowed: isDisallowed, _extractLocs: extractLocs, _normUrl: normUrl,
  };
})(window);
