/* ===========================================================
 * SERPSCOPE — Multi-page site crawler (site-architecture audit).
 *
 * Crawls internal pages starting from the audited URL and surfaces
 * SITE-WIDE issues a single-page audit can't see:
 *
 *   • Broken internal links (4xx/410)
 *   • Duplicate title tags / meta descriptions / H1s
 *   • Missing title / meta / H1, multiple H1s
 *   • Thin content (low word count)
 *   • Orphan page candidates (in sitemap, no internal inlinks)
 *   • Noindex pages, canonical-mismatch pages, deep pages
 *
 * Reuses analyzer.js's resilient multi-proxy fetch chain
 * (_fetchPage / _probe) so it inherits the same CORS fallback.
 * Seeds the frontier from sitemap.xml when available, then BFS
 * across the on-page link graph with a small concurrency pool.
 * =========================================================== */

(function (global) {
  'use strict';

  const SS = global.SERPSCOPE || (global.SERPSCOPE = {});

  const TRACKING = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'gclid', 'fbclid', 'ref', 'mc_cid', 'mc_eid', 'igshid', '_ga'];
  const SKIP_EXT = /\.(?:jpe?g|png|gif|webp|avif|svg|ico|bmp|tiff?|css|js|mjs|json|xml|rss|atom|txt|pdf|docx?|xlsx?|pptx?|csv|zip|rar|gz|tgz|tar|7z|mp4|webm|mov|avi|wmv|mkv|mp3|wav|ogg|flac|woff2?|ttf|otf|eot|map|dmg|exe|apk|wasm)(?:$|\?|#)/i;
  const THIN_WORDS = 250;
  const MAX_LINKS_PER_PAGE = 300;

  // ── small helpers ──────────────────────────────────────────
  function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }
  function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
  }
  function normHost(h) { return String(h || '').replace(/^www\./i, '').toLowerCase(); }
  function normText(s) { return String(s || '').replace(/\s+/g, ' ').trim(); }

  // Canonical de-dup key: host (no www) + path (no trailing slash) + non-tracking query.
  // Protocol and hash are intentionally dropped so sitemap URLs and on-page
  // links collapse onto the same key.
  function urlKey(u) {
    try {
      const url = new URL(u);
      TRACKING.forEach((p) => url.searchParams.delete(p));
      const host = normHost(url.hostname);
      let path = url.pathname.replace(/\/{2,}/g, '/').replace(/\/+$/, '');
      if (!path) path = '/';
      const qs = url.searchParams.toString();
      return host + path + (qs ? '?' + qs : '');
    } catch { return String(u); }
  }

  function shortPath(u) {
    try {
      const url = new URL(u);
      const p = (url.pathname + url.search) || '/';
      return p.length > 1 ? p.replace(/\/$/, '') : '/';
    } catch { return u; }
  }

  function looksLikeAsset(u) {
    try { const url = new URL(u); return SKIP_EXT.test(url.pathname + url.search); }
    catch { return SKIP_EXT.test(u); }
  }

  // ── per-page extraction (crawl-relevant fields only) ───────
  function extractPageInfo(html, baseUrl, rootHost) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const title = normText(doc.querySelector('title')?.textContent);
    const metaDesc = normText(doc.querySelector('meta[name="description" i]')?.getAttribute('content'));
    const h1s = Array.from(doc.querySelectorAll('h1')).map((h) => normText(h.textContent)).filter(Boolean);
    const canonical = (doc.querySelector('link[rel="canonical" i]')?.getAttribute('href') || '').trim();
    const robots = (doc.querySelector('meta[name="robots" i]')?.getAttribute('content') || '').toLowerCase();
    const noindex = /noindex/.test(robots);

    const body = doc.body ? doc.body.cloneNode(true) : null;
    if (body) body.querySelectorAll('script,style,noscript,template,svg').forEach((n) => n.remove());
    const wordCount = body ? normText(body.textContent).split(/\s+/).filter(Boolean).length : 0;

    const links = [];
    const seen = new Set();
    const anchors = doc.querySelectorAll('a[href]');
    for (let i = 0; i < anchors.length && links.length < MAX_LINKS_PER_PAGE; i++) {
      const href = (anchors[i].getAttribute('href') || '').trim();
      if (!href || href.startsWith('#') || /^(mailto:|tel:|javascript:|data:|sms:)/i.test(href)) continue;
      let abs;
      try { abs = new URL(href, baseUrl); } catch { continue; }
      if (abs.protocol !== 'http:' && abs.protocol !== 'https:') continue;
      if (normHost(abs.hostname) !== rootHost) continue; // internal only
      if (looksLikeAsset(abs.href)) continue;
      const k = urlKey(abs.href);
      if (seen.has(k)) continue;
      seen.add(k);
      abs.hash = '';
      links.push(abs.href);
    }

    let canonicalResolved = '';
    if (canonical) { try { canonicalResolved = new URL(canonical, baseUrl).href; } catch {} }

    return { title, metaDesc, h1s, canonical, canonicalResolved, noindex, wordCount, links };
  }

  // ── sitemap seeding (best-effort, follows one index level) ──
  async function fetchSitemapUrls(origin, rootHost, proxyKey, cap) {
    const A = SS.analyzer;
    const out = new Map(); // key -> original url
    if (!A?._probe) return out;

    async function load(url, depth) {
      if (out.size >= cap || depth > 1) return;
      let res;
      try { res = await A._probe(url, proxyKey); } catch { return; }
      if (!res || !res.ok || !res.text) return;
      const text = res.text;
      const locs = Array.from(text.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)).map((m) => m[1].trim());
      if (/<sitemapindex/i.test(text)) {
        let n = 0;
        for (const loc of locs) {
          if (n >= 3 || out.size >= cap) break;
          n++;
          await load(loc, depth + 1);
        }
      } else {
        for (const loc of locs) {
          if (out.size >= cap) break;
          let abs;
          try { abs = new URL(loc); } catch { continue; }
          if (normHost(abs.hostname) !== rootHost) continue;
          if (looksLikeAsset(abs.href)) continue;
          out.set(urlKey(abs.href), abs.href);
        }
      }
    }

    await load(origin + '/sitemap.xml', 0);
    if (out.size === 0) await load(origin + '/sitemap_index.xml', 0);
    return out;
  }

  // ── main crawl ─────────────────────────────────────────────
  async function crawl(startUrl, opts = {}, onProgress = () => {}) {
    const A = SS.analyzer;
    if (!A?._fetchPage) throw new Error('Analyzer engine not available');

    const proxyKey = opts.proxy || 'allorigins';
    const maxPages = clamp(opts.maxPages || 25, 1, 100);
    const concurrency = clamp(opts.concurrency || 3, 1, 5);
    const start = A.normalizeUrl ? A.normalizeUrl(startUrl) : startUrl;
    const startU = new URL(start);
    const rootHost = normHost(startU.hostname);
    const origin = startU.origin;
    const entryKey = urlKey(start);

    const pages = new Map();   // key -> record
    const inlink = new Map();  // key -> inbound link count (from crawled pages)
    const sources = new Map(); // key -> [linking urls] (capped at 5)
    const queue = [];
    const enqueued = new Set();

    function enqueue(url, depth, fromSitemap) {
      const k = urlKey(url);
      if (enqueued.has(k)) return;
      if (enqueued.size >= maxPages * 4) return; // bound memory on huge sites
      enqueued.add(k);
      queue.push({ url, depth, key: k, fromSitemap: !!fromSitemap });
    }

    enqueue(start, 0, false);

    onProgress({ phase: 'sitemap', msg: 'Reading sitemap.xml' });
    let sitemapMap = new Map();
    try { sitemapMap = await fetchSitemapUrls(origin, rootHost, proxyKey, maxPages); } catch {}
    const sitemapKeys = new Set(sitemapMap.keys());
    for (const u of sitemapMap.values()) enqueue(u, 1, true);

    function recordLink(fromUrl, toUrl) {
      const k = urlKey(toUrl);
      inlink.set(k, (inlink.get(k) || 0) + 1);
      let arr = sources.get(k);
      if (!arr) { arr = []; sources.set(k, arr); }
      if (arr.length < 5 && !arr.includes(fromUrl)) arr.push(fromUrl);
    }

    async function visit(item) {
      const k = item.key;
      if (pages.has(k)) return;
      onProgress({ phase: 'crawl', done: pages.size, total: Math.min(maxPages, enqueued.size), url: item.url });
      try {
        const page = await A._fetchPage(item.url, proxyKey, {});
        const info = extractPageInfo(page.html, item.url, rootHost);
        pages.set(k, {
          url: item.url, key: k, depth: item.depth,
          fromSitemap: item.fromSitemap || sitemapKeys.has(k),
          ok: true, status: page.status || 200, bytes: page.html.length, ms: page.ms,
          title: info.title, metaDesc: info.metaDesc, h1s: info.h1s,
          canonical: info.canonical, canonicalResolved: info.canonicalResolved,
          noindex: info.noindex, wordCount: info.wordCount, outlinks: info.links.length,
        });
        for (const l of info.links) {
          recordLink(item.url, l);
          if (pages.size + queue.length < maxPages) enqueue(l, item.depth + 1, false);
        }
      } catch (e) {
        const attempts = e.attempts || [];
        const statuses = attempts.map((a) => a.status).filter((s) => s > 0);
        const hard = statuses.some((s) => s >= 400 && s < 500 && s !== 408 && s !== 429 && s !== 425);
        pages.set(k, {
          url: item.url, key: k, depth: item.depth,
          fromSitemap: item.fromSitemap || sitemapKeys.has(k),
          ok: false, status: statuses[0] || 0, error: e.message,
          failClass: hard ? 'broken' : 'unverified',
        });
      }
    }

    await new Promise((resolve) => {
      let inFlight = 0;
      function pump() {
        while (queue.length && inFlight < concurrency && pages.size + inFlight < maxPages) {
          const item = queue.shift();
          if (pages.has(item.key)) continue;
          inFlight++;
          visit(item).catch(() => {}).finally(() => { inFlight--; pump(); });
        }
        if (inFlight === 0 && (!queue.length || pages.size >= maxPages)) resolve();
      }
      pump();
    });

    onProgress({ phase: 'done', done: pages.size, total: pages.size });
    return buildResult({ start, rootHost, origin, pages, inlink, sources, sitemapKeys, entryKey, maxPages });
  }

  // ── issue derivation ───────────────────────────────────────
  function groupDup(pages, keyFn) {
    const map = new Map();
    pages.forEach((p) => {
      const raw = keyFn(p);
      const v = normText(raw).toLowerCase();
      if (!v) return;
      if (!map.has(v)) map.set(v, { value: normText(raw), urls: [] });
      map.get(v).urls.push(p.url);
    });
    return Array.from(map.values()).filter((g) => g.urls.length > 1).sort((a, b) => b.urls.length - a.urls.length);
  }

  function buildResult(ctx) {
    const { start, rootHost, origin, pages, inlink, sources, sitemapKeys, entryKey, maxPages } = ctx;
    const all = Array.from(pages.values());
    const okPages = all.filter((p) => p.ok);

    const broken = all.filter((p) => !p.ok && p.failClass === 'broken')
      .map((p) => ({ url: p.url, status: p.status, sources: sources.get(p.key) || [] }));
    const unverified = all.filter((p) => !p.ok && p.failClass === 'unverified')
      .map((p) => ({ url: p.url, error: p.error, sources: sources.get(p.key) || [] }));

    const dupTitles = groupDup(okPages.filter((p) => p.title), (p) => p.title);
    const dupMeta = groupDup(okPages.filter((p) => p.metaDesc), (p) => p.metaDesc);
    const dupH1 = groupDup(okPages.filter((p) => p.h1s && p.h1s.length), (p) => p.h1s[0]);

    const missingTitle = okPages.filter((p) => !p.title).map((p) => p.url);
    const missingMeta = okPages.filter((p) => !p.metaDesc).map((p) => p.url);
    const missingH1 = okPages.filter((p) => !p.h1s || p.h1s.length === 0).map((p) => p.url);
    const multiH1 = okPages.filter((p) => p.h1s && p.h1s.length > 1).map((p) => ({ url: p.url, count: p.h1s.length }));

    const thin = okPages.filter((p) => p.wordCount < THIN_WORDS)
      .map((p) => ({ url: p.url, words: p.wordCount })).sort((a, b) => a.words - b.words);

    const noindex = okPages.filter((p) => p.noindex).map((p) => p.url);
    const canonical = okPages.filter((p) => p.canonicalResolved && urlKey(p.canonicalResolved) !== p.key)
      .map((p) => ({ url: p.url, canonical: p.canonicalResolved }));

    const orphans = okPages
      .filter((p) => sitemapKeys.has(p.key) && p.key !== entryKey && (inlink.get(p.key) || 0) === 0)
      .map((p) => p.url);

    const deep = okPages.filter((p) => p.depth >= 4).map((p) => ({ url: p.url, depth: p.depth }));
    const avgWords = okPages.length ? Math.round(okPages.reduce((s, p) => s + (p.wordCount || 0), 0) / okPages.length) : 0;

    return {
      startUrl: start, host: rootHost, origin, crawledAt: Date.now(),
      stats: {
        crawled: pages.size,
        reachable: okPages.length,
        broken: broken.length,
        unverified: unverified.length,
        sitemapUrls: sitemapKeys.size,
        orphans: orphans.length,
        avgWords,
        dupTitleGroups: dupTitles.length,
        thin: thin.length,
        capped: pages.size >= maxPages,
        maxPages,
      },
      pages: all.map((p) => ({
        url: p.url, ok: p.ok, status: p.status, title: p.title || '',
        words: p.wordCount || 0, h1: p.h1s ? p.h1s.length : 0,
        depth: p.depth, inlinks: inlink.get(p.key) || 0, noindex: !!p.noindex,
      })).sort((a, b) => (a.depth - b.depth) || a.url.localeCompare(b.url)),
      issues: { broken, unverified, dupTitles, dupMeta, dupH1, missingTitle, missingMeta, missingH1, multiH1, thin, noindex, canonical, orphans, deep },
    };
  }

  // ── rendering ──────────────────────────────────────────────
  function pageLink(u) {
    return `<a href="${escapeHtml(u)}" target="_blank" rel="noopener" title="${escapeHtml(u)}">${escapeHtml(shortPath(u))}</a>`;
  }
  function moreNote(total, cap) { return total > cap ? `<p class="muted small">Showing first ${cap} of ${total}.</p>` : ''; }
  function trimErr(e) { const s = String(e || 'unreachable'); return s.length > 64 ? s.slice(0, 61) + '…' : s; }

  function blockShell(title, sevClass, count, inner, open) {
    return `<details class="crawl-block"${open ? ' open' : ''}>
      <summary><span class="pill ${sevClass}">${sevClass.toUpperCase()}</span> ${escapeHtml(title)} <span class="crawl-count">${count}</span></summary>
      <div class="crawl-block-body">${inner}</div>
    </details>`;
  }

  function linkIssueBlock(title, sevClass, rows, showStatus, open) {
    if (!rows || !rows.length) return '';
    const cap = 50;
    const body = `<table class="rank-table crawl-table">
      <thead><tr><th>URL</th><th>${showStatus ? 'Status' : 'Reason'}</th><th>Linked from</th></tr></thead>
      <tbody>${rows.slice(0, cap).map((r) => `<tr>
        <td class="domain">${pageLink(r.url)}</td>
        <td class="num ${showStatus ? 'bad' : 'warn'}">${showStatus ? escapeHtml(String(r.status || '4xx')) : escapeHtml(trimErr(r.error))}</td>
        <td>${(r.sources && r.sources.length) ? r.sources.map(pageLink).join('<br>') : '<span class="muted">—</span>'}</td>
      </tr>`).join('')}</tbody>
    </table>${moreNote(rows.length, cap)}`;
    return blockShell(title, sevClass, rows.length, body, open);
  }

  function dupBlock(title, sevClass, groups) {
    if (!groups || !groups.length) return '';
    const cap = 30;
    const body = groups.slice(0, cap).map((g) => `<div class="crawl-dup">
      <div class="crawl-dup-val">${escapeHtml(g.value)} <span class="crawl-count">${g.urls.length}×</span></div>
      <ul class="crawl-url-list">${g.urls.slice(0, 8).map((u) => `<li>${pageLink(u)}</li>`).join('')}${g.urls.length > 8 ? `<li class="muted">+${g.urls.length - 8} more</li>` : ''}</ul>
    </div>`).join('');
    return blockShell(title, sevClass, groups.length, body + moreNote(groups.length, cap));
  }

  function listBlock(title, sevClass, urls, hint) {
    if (!urls || !urls.length) return '';
    const cap = 50;
    const body = `${hint ? `<p class="muted small">${escapeHtml(hint)}</p>` : ''}<ul class="crawl-url-list cols">${urls.slice(0, cap).map((u) => `<li>${pageLink(u)}</li>`).join('')}</ul>${moreNote(urls.length, cap)}`;
    return blockShell(title, sevClass, urls.length, body);
  }

  function countListBlock(title, sevClass, rows, unit) {
    if (!rows || !rows.length) return '';
    const cap = 50;
    const body = `<ul class="crawl-url-list">${rows.slice(0, cap).map((r) => `<li>${pageLink(r.url)} <span class="muted">(${r.count} ${escapeHtml(unit)})</span></li>`).join('')}</ul>${moreNote(rows.length, cap)}`;
    return blockShell(title, sevClass, rows.length, body);
  }

  function thinBlock(title, sevClass, rows) {
    if (!rows || !rows.length) return '';
    const cap = 50;
    const body = `<table class="rank-table crawl-table"><thead><tr><th>URL</th><th>Words</th></tr></thead>
      <tbody>${rows.slice(0, cap).map((r) => `<tr><td class="domain">${pageLink(r.url)}</td><td class="num ${r.words < 120 ? 'bad' : 'warn'}">${r.words}</td></tr>`).join('')}</tbody>
    </table>${moreNote(rows.length, cap)}`;
    return blockShell(title, sevClass, rows.length, body);
  }

  function canonicalBlock(title, sevClass, rows) {
    if (!rows || !rows.length) return '';
    const cap = 50;
    const body = `<table class="rank-table crawl-table"><thead><tr><th>Page</th><th>Canonical points to</th></tr></thead>
      <tbody>${rows.slice(0, cap).map((r) => `<tr><td class="domain">${pageLink(r.url)}</td><td class="domain">${pageLink(r.canonical)}</td></tr>`).join('')}</tbody>
    </table>${moreNote(rows.length, cap)}`;
    return blockShell(title, sevClass, rows.length, body);
  }

  function allPagesBlock(pages) {
    if (!pages || !pages.length) return '';
    const cap = 150;
    const body = `<div class="rank-table-wrap"><table class="rank-table crawl-table crawl-all-table">
      <thead><tr><th>#</th><th>URL</th><th>Status</th><th>Title</th><th>Words</th><th>H1</th><th>Depth</th><th>Inlinks</th></tr></thead>
      <tbody>${pages.slice(0, cap).map((p, i) => `<tr class="${p.ok ? '' : 'row-bad'}">
        <td>${i + 1}</td>
        <td class="domain">${pageLink(p.url)}${p.noindex ? ' <span class="badge subtle">noindex</span>' : ''}</td>
        <td class="num ${p.ok ? '' : 'bad'}">${p.ok ? (p.status || 200) : 'ERR'}</td>
        <td class="crawl-title-cell" title="${escapeHtml(p.title)}">${escapeHtml(p.title || '—')}</td>
        <td class="num">${p.ok ? p.words : '—'}</td>
        <td class="num ${p.ok && p.h1 === 1 ? '' : 'warn'}">${p.ok ? p.h1 : '—'}</td>
        <td class="num">${p.depth}</td>
        <td class="num">${p.inlinks}</td>
      </tr>`).join('')}</tbody>
    </table></div>${moreNote(pages.length, cap)}`;
    return `<details class="crawl-all"><summary>All crawled pages <span class="crawl-count">${pages.length}</span></summary><div class="crawl-block-body">${body}</div></details>`;
  }

  function render(result, container) {
    if (!container) return;
    if (!result) { container.innerHTML = ''; return; }
    const s = result.stats;
    const I = result.issues;

    const tiles = [
      ['Pages crawled', s.crawled + (s.capped ? ` / ${s.maxPages}` : ''), ''],
      ['Reachable', s.reachable, ''],
      ['Broken links', s.broken, s.broken ? 'bad' : 'good'],
      ['Unverified', s.unverified, s.unverified ? 'warn' : ''],
      ['Dup. titles', s.dupTitleGroups, s.dupTitleGroups ? 'warn' : 'good'],
      ['Thin pages', s.thin, s.thin ? 'warn' : 'good'],
      ['Orphan cand.', s.orphans, s.orphans ? 'warn' : 'good'],
      ['Avg words', s.avgWords, ''],
    ];

    let html = `<div class="crawl-summary">${tiles.map((t) => `
      <div class="crawl-stat">
        <span class="crawl-stat-val ${t[2]}">${escapeHtml(String(t[1]))}</span>
        <label>${escapeHtml(t[0])}</label>
      </div>`).join('')}</div>`;

    const blocks = [
      linkIssueBlock('Broken internal links', 'p0', I.broken, true, true),
      dupBlock('Duplicate title tags', 'p1', I.dupTitles),
      listBlock('Missing title tag', 'p1', I.missingTitle),
      listBlock('Missing H1 heading', 'p1', I.missingH1),
      dupBlock('Duplicate meta descriptions', 'p2', I.dupMeta),
      listBlock('Missing meta description', 'p2', I.missingMeta),
      dupBlock('Duplicate H1 headings', 'p2', I.dupH1),
      countListBlock('Multiple H1 tags', 'p2', I.multiH1, 'H1s'),
      thinBlock(`Thin content (under ${THIN_WORDS} words)`, 'p2', I.thin),
      listBlock('Orphan page candidates', 'p2', I.orphans, 'Present in the sitemap but no internal links to them were found among crawled pages — verify they are reachable.'),
      canonicalBlock('Canonicalized to another URL', 'p3', I.canonical),
      listBlock('Noindex pages', 'p3', I.noindex, 'These pages are excluded from search results. Confirm this is intentional.'),
      countListBlock('Deep pages (4+ clicks from start)', 'p3', I.deep, 'clicks'),
      linkIssueBlock('Unverified pages (proxy throttled / timed out)', 'p3', I.unverified, false, false),
    ].filter(Boolean);

    if (blocks.length) {
      html += `<div class="crawl-issues">${blocks.join('')}</div>`;
    } else {
      html += `<p class="muted center crawl-clean">No structural issues found across ${s.reachable} crawled pages.</p>`;
    }

    html += allPagesBlock(result.pages);
    html += `<p class="muted small crawl-disclaimer">Crawl reuses the resilient CORS-proxy chain; broken/unverified status reflects proxy reachability — confirm flagged URLs directly. Orphan detection is bounded to the crawled set${s.capped ? ' (page cap reached — raise the limit for fuller coverage)' : ''}.</p>`;

    container.innerHTML = html;
  }

  SS.crawler = { crawl, render };
})(window);
