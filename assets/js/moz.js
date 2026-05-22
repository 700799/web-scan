/* ===========================================================
 * SERPSCOPE — Moz Links API client (off-page authority data).
 *
 * Talks to Moz Links API v2 (api.moz.com/jsonrpc) — the modern
 * replacement for the retired Mozscape v1 endpoint. Surfaces:
 *
 *   • Domain Authority (DA)
 *   • Page Authority (PA)
 *   • Spam Score
 *   • Linking root domains (count + top samples)
 *   • External equity passing links (count)
 *   • Top backlink anchors
 *
 * Requires the user to supply a Moz API token (Settings panel).
 * Responses are cached in localStorage for 7 days — DA doesn't
 * change daily and the free tier is quota-limited.
 * =========================================================== */

(function (global) {
  'use strict';

  const ENDPOINT = 'https://api.moz.com/jsonrpc';
  const CACHE_PREFIX = 'serpscope.moz.cache.';
  const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

  function getToken() {
    try {
      const s = JSON.parse(localStorage.getItem('serpscope.settings.v1') || '{}');
      return (s.mozToken || '').trim();
    } catch { return ''; }
  }

  function hasToken() { return !!getToken(); }

  function cacheKey(host) { return CACHE_PREFIX + host; }

  function readCache(host) {
    try {
      const raw = localStorage.getItem(cacheKey(host));
      if (!raw) return null;
      const c = JSON.parse(raw);
      if (Date.now() - c.t > CACHE_TTL_MS) return null;
      return c.data;
    } catch { return null; }
  }

  function writeCache(host, data) {
    try {
      localStorage.setItem(cacheKey(host), JSON.stringify({ t: Date.now(), data }));
    } catch {}
  }

  async function rpc(method, params) {
    const token = getToken();
    if (!token) throw new Error('Moz token not configured');
    const body = { jsonrpc: '2.0', id: '1', method, params };
    const r = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-moz-token': token,
      },
      body: JSON.stringify(body),
    });
    if (!r.ok) {
      let msg = `Moz API HTTP ${r.status}`;
      try { const j = await r.json(); if (j?.error?.message) msg += ': ' + j.error.message; } catch {}
      throw new Error(msg);
    }
    const j = await r.json();
    if (j?.error) throw new Error('Moz API: ' + (j.error.message || JSON.stringify(j.error)));
    return j.result;
  }

  // ── Site metrics: DA, PA, spam, linking root domains count ─
  async function fetchSiteMetrics(targetUrl) {
    const host = hostFromUrl(targetUrl);
    const cached = readCache(host);
    if (cached) return { ...cached, _cached: true };

    try {
      const result = await rpc('data.site.metrics.fetch', {
        data: { site_query: { query: host, scope: 'domain' } },
      });
      const metrics = result?.site_metrics || result || {};
      const data = {
        host,
        da: numify(metrics.domain_authority),
        pa: numify(metrics.page_authority),
        spamScore: numify(metrics.spam_score),
        linkingDomains: numify(metrics.linking_root_domains_to_root_domain ?? metrics.root_domains_to_root_domain),
        externalLinks: numify(metrics.external_pages_to_root_domain),
        equityLinks: numify(metrics.external_pages_to_root_domain),
        deepLinkRatio: metrics.deep_link_ratio_to_root_domain ?? null,
        fetchedAt: Date.now(),
      };
      writeCache(host, data);
      return data;
    } catch (e) {
      throw e;
    }
  }

  async function fetchTopAnchors(targetUrl, limit = 10) {
    const host = hostFromUrl(targetUrl);
    try {
      const result = await rpc('data.anchor-text.list', {
        data: {
          target_query: { query: host, scope: 'domain' },
          anchor_text_scope: 'phrase_to_domain',
          limit,
        },
      });
      return (result?.results || result || []).slice(0, limit).map((a) => ({
        anchor: a.anchor_text || a.anchor_text_normalized || '',
        linkingDomains: numify(a.external_pages_to_root_domain ?? a.linking_domains ?? a.count),
        followLinks: numify(a.followed_external_pages_to_root_domain ?? a.followed),
      }));
    } catch (e) {
      return [];
    }
  }

  async function fetchTopLinkingDomains(targetUrl, limit = 15) {
    const host = hostFromUrl(targetUrl);
    try {
      const result = await rpc('data.linking-root-domains.list', {
        data: {
          target_query: { query: host, scope: 'domain' },
          target_scope: 'root_domain_to_root_domain',
          filter: { recently_lost: false, redirect: false, nofollow: false },
          limit,
        },
      });
      return (result?.results || result || []).slice(0, limit).map((d) => ({
        domain: d.source_root_domain || d.root_domain || '',
        da: numify(d.source_domain_authority || d.domain_authority),
        externalLinks: numify(d.external_pages || d.linking_pages),
      }));
    } catch (e) {
      return [];
    }
  }

  // Master fetch — pulls site metrics; optionally enriches with anchors+linking.
  async function lookup(targetUrl, opts = {}) {
    if (!hasToken()) return null;
    const includeRich = opts.rich !== false;
    try {
      const site = await fetchSiteMetrics(targetUrl);
      if (!includeRich) return site;
      const [anchors, topLinkingDomains] = await Promise.all([
        fetchTopAnchors(targetUrl, 10).catch(() => []),
        fetchTopLinkingDomains(targetUrl, 15).catch(() => []),
      ]);
      return { ...site, anchors, topLinkingDomains };
    } catch (e) {
      console.warn('[serpscope.moz] lookup failed for', targetUrl, e.message);
      return { _error: e.message, host: hostFromUrl(targetUrl) };
    }
  }

  // Batch helper for a set of competitor URLs — uses cache to minimise
  // quota burn. Failures are returned as null entries so the caller
  // can still render whatever did come back.
  async function batchLookup(urls, opts = {}) {
    const out = [];
    for (const u of urls) {
      const r = await lookup(u, { rich: false, ...opts });
      out.push(r);
    }
    return out;
  }

  function numify(v) {
    if (v == null) return null;
    const n = Number(v);
    return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
  }

  function hostFromUrl(u) {
    try { return new URL(u).hostname.replace(/^www\./i, ''); }
    catch { return String(u).replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/^www\./i, ''); }
  }

  // ── UI rendering ──────────────────────────────────────────
  function gradeColor(da) {
    if (da == null) return '#9aa7c1';
    if (da >= 60) return '#00d4aa';
    if (da >= 40) return '#6aff9a';
    if (da >= 25) return '#ffb547';
    if (da >= 10) return '#ff8a3d';
    return '#ff5b6b';
  }
  function daLabel(da) {
    if (da == null) return 'unknown';
    if (da >= 70) return 'authoritative';
    if (da >= 50) return 'strong';
    if (da >= 30) return 'established';
    if (da >= 15) return 'emerging';
    return 'new / weak';
  }

  function renderTargetCard(moz) {
    if (!moz) return '';
    if (moz._error) {
      return `<div class="moz-card error">
        <h4>Moz Authority</h4>
        <p class="muted">Lookup failed: ${escape(moz._error)}</p>
        <p class="muted small">Check that your Moz API token is configured in Settings and has remaining quota.</p>
      </div>`;
    }
    const c = gradeColor(moz.da);
    const cached = moz._cached ? '<span class="moz-cached">cached</span>' : '';
    return `
      <div class="moz-card">
        <div class="moz-card-head">
          <h4>Domain Authority</h4>${cached}
        </div>
        <div class="moz-da" style="color:${c}">${moz.da ?? '—'}</div>
        <div class="moz-da-label muted">${daLabel(moz.da)}</div>
        <div class="moz-stats">
          <div><span>${fmt(moz.pa)}</span><label>Page Authority</label></div>
          <div><span>${fmt(moz.linkingDomains)}</span><label>Linking root domains</label></div>
          <div><span>${fmt(moz.externalLinks)}</span><label>External links</label></div>
          <div><span class="${moz.spamScore != null && moz.spamScore >= 30 ? 'bad' : ''}">${fmt(moz.spamScore)}</span><label>Spam score</label></div>
        </div>
      </div>`;
  }

  function renderCompetitorComparison(targetMoz, compsMoz) {
    const rows = [targetMoz, ...compsMoz].filter(Boolean).filter((m) => !m._error);
    if (rows.length === 0) return '';
    rows.sort((a, b) => (b.da || 0) - (a.da || 0));
    const targetHost = targetMoz?.host;
    return `
      <h4>Authority benchmark vs. competitor set</h4>
      <table class="rank-table moz-table">
        <thead>
          <tr>
            <th>#</th><th>Domain</th><th>DA</th><th>PA</th>
            <th>Linking RDs</th><th>Spam</th><th>Rel. DA</th>
          </tr>
        </thead>
        <tbody>
          ${rows.map((r, i) => {
            const self = r.host === targetHost;
            const max = Math.max(...rows.map((x) => x.da || 0)) || 1;
            const rel = ((r.da || 0) / max) * 100;
            const c = gradeColor(r.da);
            return `<tr ${self ? 'class="self"' : ''}>
              <td>#${i + 1}</td>
              <td class="domain">${escape(r.host)}${self ? ' <span class="badge">YOU</span>' : ''}</td>
              <td class="num" style="color:${c}">${fmt(r.da)}</td>
              <td class="num">${fmt(r.pa)}</td>
              <td class="num">${fmt(r.linkingDomains)}</td>
              <td class="num">${fmt(r.spamScore)}</td>
              <td><div class="bar-mini"><div class="bar-mini-fill" style="width:${rel}%;background:${c}"></div></div></td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>`;
  }

  function renderAnchors(moz) {
    if (!moz?.anchors?.length) return '';
    return `
      <h4>Top backlink anchor text</h4>
      <table class="rank-table moz-anchors-table">
        <thead><tr><th>Anchor text</th><th>Linking domains</th><th>Followed</th></tr></thead>
        <tbody>
          ${moz.anchors.slice(0, 10).map((a) => `
            <tr>
              <td>${escape(a.anchor || '(empty)')}</td>
              <td class="num">${fmt(a.linkingDomains)}</td>
              <td class="num">${fmt(a.followLinks)}</td>
            </tr>`).join('')}
        </tbody>
      </table>`;
  }

  function renderTopDomains(moz) {
    if (!moz?.topLinkingDomains?.length) return '';
    return `
      <h4>Top linking root domains</h4>
      <table class="rank-table moz-domains-table">
        <thead><tr><th>Domain</th><th>DA</th><th>Pages linking</th></tr></thead>
        <tbody>
          ${moz.topLinkingDomains.slice(0, 12).map((d) => `
            <tr>
              <td class="domain">${escape(d.domain)}</td>
              <td class="num" style="color:${gradeColor(d.da)}">${fmt(d.da)}</td>
              <td class="num">${fmt(d.externalLinks)}</td>
            </tr>`).join('')}
        </tbody>
      </table>`;
  }

  // Build full off-page panel for the report
  function renderPanel(targetMoz, compsMoz) {
    const el = document.getElementById('moz-panel');
    if (!el) return;
    if (!targetMoz) {
      el.parentElement.hidden = true; // hide entire panel
      return;
    }
    el.parentElement.hidden = false;
    el.innerHTML = `
      <div class="moz-grid">
        <div class="moz-left">${renderTargetCard(targetMoz)}</div>
        <div class="moz-right">${renderCompetitorComparison(targetMoz, compsMoz || [])}</div>
      </div>
      <div class="moz-grid">
        <div>${renderAnchors(targetMoz)}</div>
        <div>${renderTopDomains(targetMoz)}</div>
      </div>
      <p class="muted small moz-disclaimer">Authority data via Moz Links API. Numbers cached for 7 days to conserve quota.</p>
    `;
  }

  function fmt(v) {
    if (v == null) return '—';
    if (v >= 1000) return Math.round(v).toLocaleString();
    return String(Math.round(v));
  }
  function escape(s) {
    return String(s ?? '').replace(/[&<>"']/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[m]);
  }

  global.SERPSCOPE = global.SERPSCOPE || {};
  global.SERPSCOPE.moz = {
    hasToken, lookup, batchLookup,
    fetchSiteMetrics, fetchTopAnchors, fetchTopLinkingDomains,
    renderPanel,
  };
})(window);
