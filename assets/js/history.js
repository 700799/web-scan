/* ===========================================================
 * SERPSCOPE — Audit history & trend tracking via IndexedDB.
 *
 * Every audit run is persisted to IndexedDB indexed by host +
 * timestamp. Subsequent audits of the same host can show a
 * trend sparkline (composite + per-category) and a delta vs.
 * the previous run. The History view lets you browse every
 * tracked property and load any historical snapshot.
 *
 * Schema
 *   db:    serpscope_v1
 *   store: audits    { id, host, url, timestamp, composite,
 *                      grade, categories, summary, full }
 *   index: by-host, by-timestamp
 * =========================================================== */

(function (global) {
  'use strict';

  const DB_NAME = 'serpscope_v1';
  const DB_VERSION = 1;
  const STORE = 'audits';
  const MAX_KEEP_PER_HOST = 50; // hard cap per host to keep DB lean

  let dbPromise = null;

  function open() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      if (!global.indexedDB) { reject(new Error('IndexedDB unavailable')); return; }
      const req = global.indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains(STORE)) {
          const store = db.createObjectStore(STORE, { keyPath: 'id' });
          store.createIndex('by-host', 'host', { unique: false });
          store.createIndex('by-timestamp', 'timestamp', { unique: false });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    }).catch((e) => { dbPromise = null; throw e; });
    return dbPromise;
  }

  function tx(mode = 'readonly') {
    return open().then((db) => db.transaction(STORE, mode).objectStore(STORE));
  }

  function reqPromise(req) {
    return new Promise((res, rej) => {
      req.onsuccess = () => res(req.result);
      req.onerror = () => rej(req.error);
    });
  }

  // ── Public API ─────────────────────────────────────────────

  // Save a snapshot. Strips heavy/binary fields so we don't bloat the DB
  // with megabytes of base64 screenshots.
  async function saveAudit(audit) {
    if (!audit?.host) return null;
    const id = `${audit.host}__${audit.timestamp || Date.now()}`;
    const slim = sliceForStorage(audit);
    const record = {
      id,
      host: audit.host,
      url: audit.url,
      timestamp: audit.timestamp || Date.now(),
      composite: audit.composite,
      grade: audit.grade,
      categories: {
        onpage: audit.categories.onpage.score,
        technical: audit.categories.technical.score,
        content: audit.categories.content.score,
        offpage: audit.categories.offpage.score,
      },
      summary: {
        title: audit.signals?.title || '',
        wordCount: audit.signals?.wordCount || 0,
        lh: {
          mobilePerf: audit.lighthouse?.mobile?.scores?.performance ?? null,
          desktopPerf: audit.lighthouse?.desktop?.scores?.performance ?? null,
          a11y: audit.lighthouse?.mobile?.scores?.accessibility ?? null,
          seo: audit.lighthouse?.mobile?.scores?.seo ?? null,
          bp: audit.lighthouse?.mobile?.scores?.bestPractices ?? null,
        },
        blockerCounts: countBlockers(audit.blockers),
        actionCounts: countActions(audit._actions),
      },
      moz: audit.moz || null,
      full: slim, // full audit minus heavy fields, so we can re-render later
    };
    try {
      const store = await tx('readwrite');
      await reqPromise(store.put(record));
      await pruneHost(audit.host).catch(() => {});
      return id;
    } catch (e) {
      console.warn('[serpscope.history] save failed', e);
      return null;
    }
  }

  function sliceForStorage(audit) {
    if (!audit) return null;
    // Deep copy via JSON then drop expensive fields.
    let copy;
    try { copy = JSON.parse(JSON.stringify(audit)); } catch { return null; }
    // Drop base64 screenshots & filmstrip
    if (copy.lighthouse?.mobile?.screenshots) copy.lighthouse.mobile.screenshots = null;
    if (copy.lighthouse?.desktop?.screenshots) copy.lighthouse.desktop.screenshots = null;
    // Drop big network arrays
    ['mobile', 'desktop'].forEach((m) => {
      if (copy.lighthouse?.[m]) {
        copy.lighthouse[m].networkRequests = (copy.lighthouse[m].networkRequests || []).slice(0, 30);
        copy.lighthouse[m].opportunities = (copy.lighthouse[m].opportunities || []).map((o) => {
          const { items, ...rest } = o; return { ...rest, items: (items || []).slice(0, 5) };
        });
        copy.lighthouse[m].diagnostics = (copy.lighthouse[m].diagnostics || []).map((d) => {
          const { items, ...rest } = d; return { ...rest, items: (items || []).slice(0, 5) };
        });
      }
    });
    if (copy.signals?.bodyText) copy.signals.bodyText = copy.signals.bodyText.slice(0, 600);
    return copy;
  }

  function countBlockers(list) {
    const c = { P0: 0, P1: 0, P2: 0, P3: 0, total: 0 };
    (list || []).forEach((b) => { c[b.severity] = (c[b.severity] || 0) + 1; c.total++; });
    return c;
  }
  function countActions(list) {
    const c = { P0: 0, P1: 0, P2: 0, P3: 0, total: 0, quickwin: 0 };
    (list || []).forEach((a) => {
      c[a.priority] = (c[a.priority] || 0) + 1; c.total++;
      if (a.quickwin) c.quickwin++;
    });
    return c;
  }

  async function pruneHost(host) {
    const all = await listByHost(host, 9999);
    if (all.length <= MAX_KEEP_PER_HOST) return;
    const sorted = all.sort((a, b) => b.timestamp - a.timestamp);
    const toDelete = sorted.slice(MAX_KEEP_PER_HOST);
    const store = await tx('readwrite');
    await Promise.all(toDelete.map((r) => reqPromise(store.delete(r.id))));
  }

  async function listByHost(host, limit = 20) {
    try {
      const db = await open();
      const store = db.transaction(STORE, 'readonly').objectStore(STORE);
      const idx = store.index('by-host');
      return new Promise((res) => {
        const out = [];
        idx.openCursor(IDBKeyRange.only(host), 'prev').onsuccess = (e) => {
          const c = e.target.result;
          if (c && out.length < limit) { out.push(c.value); c.continue(); }
          else res(out);
        };
      });
    } catch { return []; }
  }

  async function listAll(limit = 500) {
    try {
      const db = await open();
      const store = db.transaction(STORE, 'readonly').objectStore(STORE);
      return new Promise((res) => {
        const out = [];
        store.index('by-timestamp').openCursor(null, 'prev').onsuccess = (e) => {
          const c = e.target.result;
          if (c && out.length < limit) { out.push(c.value); c.continue(); }
          else res(out);
        };
      });
    } catch { return []; }
  }

  async function getById(id) {
    try {
      const store = await tx('readonly');
      return await reqPromise(store.get(id));
    } catch { return null; }
  }

  async function getLatestForHost(host) {
    const list = await listByHost(host, 1);
    return list[0] || null;
  }

  async function deleteById(id) {
    const store = await tx('readwrite');
    return reqPromise(store.delete(id));
  }

  async function deleteHost(host) {
    const all = await listByHost(host, 9999);
    const store = await tx('readwrite');
    await Promise.all(all.map((r) => reqPromise(store.delete(r.id))));
  }

  async function clearAll() {
    const store = await tx('readwrite');
    return reqPromise(store.clear());
  }

  async function listHosts() {
    const all = await listAll(1000);
    const byHost = new Map();
    all.forEach((r) => {
      const cur = byHost.get(r.host);
      if (!cur || r.timestamp > cur.lastRun) {
        byHost.set(r.host, {
          host: r.host,
          lastRun: r.timestamp,
          lastScore: r.composite,
          lastGrade: r.grade,
          runs: (cur?.runs || 0) + 1,
        });
      } else if (cur) {
        cur.runs++;
      }
    });
    return Array.from(byHost.values()).sort((a, b) => b.lastRun - a.lastRun);
  }

  // ── Trend computation ──────────────────────────────────────
  // Returns a normalized trend object suitable for rendering a
  // sparkline or delta indicator.
  async function buildTrend(host, currentScore = null) {
    const runs = await listByHost(host, 20);
    if (!runs.length) return { runs: [], delta: null };
    const sorted = runs.sort((a, b) => a.timestamp - b.timestamp);
    const series = sorted.map((r) => ({
      t: r.timestamp,
      composite: r.composite,
      onpage: r.categories?.onpage,
      technical: r.categories?.technical,
      content: r.categories?.content,
      offpage: r.categories?.offpage,
    }));
    const last = series[series.length - 1];
    const prev = series.length > 1 ? series[series.length - 2] : null;
    const delta = (currentScore != null && prev) ? currentScore - prev.composite : (prev ? last.composite - prev.composite : null);
    return { runs: series, delta, lastRun: last.t };
  }

  // ── Rendering helpers ─────────────────────────────────────
  function sparklineSVG(values, opts = {}) {
    const w = opts.width || 120;
    const h = opts.height || 28;
    const stroke = opts.stroke || '#00d4aa';
    const fill = opts.fill || 'rgba(0, 212, 170, 0.15)';
    if (!values.length) return `<svg width="${w}" height="${h}"></svg>`;
    const min = Math.min(0, ...values);
    const max = Math.max(100, ...values);
    const range = max - min || 1;
    const stepX = values.length > 1 ? w / (values.length - 1) : 0;
    const points = values.map((v, i) => {
      const x = i * stepX;
      const y = h - ((v - min) / range) * h;
      return `${x.toFixed(2)},${y.toFixed(2)}`;
    });
    const path = `M ${points.join(' L ')}`;
    const area = `M 0,${h} L ${points.join(' L ')} L ${w},${h} Z`;
    const lastV = values[values.length - 1];
    const lastX = (values.length - 1) * stepX;
    const lastY = h - ((lastV - min) / range) * h;
    return `<svg class="spark" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
      <path d="${area}" fill="${fill}" stroke="none"/>
      <path d="${path}" fill="none" stroke="${stroke}" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"/>
      <circle cx="${lastX.toFixed(2)}" cy="${lastY.toFixed(2)}" r="2.5" fill="${stroke}"/>
    </svg>`;
  }

  function renderTrendBadge(delta) {
    if (delta == null) return `<span class="trend-badge new">NEW</span>`;
    if (delta > 0) return `<span class="trend-badge up">▲ +${delta}</span>`;
    if (delta < 0) return `<span class="trend-badge down">▼ ${delta}</span>`;
    return `<span class="trend-badge flat">─ 0</span>`;
  }

  // Render the "trend" card that appears in the main report when a
  // host has prior audits.
  async function renderInlineTrend(target) {
    const root = document.getElementById('trend-card');
    if (!root) return;
    const trend = await buildTrend(target.host, target.composite);
    if (trend.runs.length < 2) {
      root.innerHTML = `
        <div class="trend-empty">
          <span class="muted small">First audit of ${escape(target.host)} stored.</span>
          <span class="muted small">Run again later to see trend lines for every signal.</span>
        </div>`;
      return;
    }
    const series = trend.runs;
    const composite = series.map((r) => r.composite);
    const cats = {
      onpage:    series.map((r) => r.onpage || 0),
      technical: series.map((r) => r.technical || 0),
      content:   series.map((r) => r.content || 0),
      offpage:   series.map((r) => r.offpage || 0),
    };
    const first = series[0];
    const last = series[series.length - 1];
    const days = Math.max(1, Math.round((last.t - first.t) / 86400000));

    root.innerHTML = `
      <div class="trend-grid">
        <div class="trend-main">
          <div class="trend-label">${series.length} audits · ${days} day window</div>
          <div class="trend-spark">${sparklineSVG(composite, { width: 280, height: 60 })}</div>
          <div class="trend-foot">
            <span class="muted small">First ${composite[0]}</span>
            <span class="muted small">→</span>
            <span>Latest ${composite[composite.length - 1]} ${renderTrendBadge(trend.delta)}</span>
          </div>
        </div>
        <div class="trend-cats">
          ${trendRow('On-Page', cats.onpage, '#00d4aa')}
          ${trendRow('Technical', cats.technical, '#6aa1ff')}
          ${trendRow('Content', cats.content, '#b779ff')}
          ${trendRow('Off-Page', cats.offpage, '#ffb547')}
        </div>
      </div>`;
  }

  function trendRow(label, values, color) {
    const first = values[0] || 0;
    const last = values[values.length - 1] || 0;
    const delta = last - first;
    return `
      <div class="trend-row">
        <span class="trend-row-label">${label}</span>
        <span class="trend-row-spark">${sparklineSVG(values, { width: 90, height: 24, stroke: color, fill: color + '22' })}</span>
        <span class="trend-row-vals">
          <span class="trend-row-now">${last}</span>
          <span class="trend-row-delta ${delta > 0 ? 'up' : delta < 0 ? 'down' : 'flat'}">${delta > 0 ? '+' + delta : delta}</span>
        </span>
      </div>`;
  }

  // ── History view ─────────────────────────────────────────
  async function renderHistoryView() {
    const root = document.getElementById('view-history');
    if (!root) return;
    const hosts = await listHosts();
    const all = await listAll(500);
    const totalRuns = all.length;
    const html = `
      <div class="panel">
        <div class="panel-head">
          <div>
            <h2>Audit History</h2>
            <p class="muted">${totalRuns} audit${totalRuns === 1 ? '' : 's'} across ${hosts.length} propert${hosts.length === 1 ? 'y' : 'ies'}, stored locally in your browser.</p>
          </div>
          <div class="panel-head-meta">
            <button class="btn small" id="history-export">Export all</button>
            <button class="btn small" id="history-clear">Clear all</button>
          </div>
        </div>

        ${hosts.length === 0 ? `
          <div class="muted center" style="padding:40px">
            No audits yet. Run an audit from the Dashboard to start tracking trends.
          </div>` :
          `<table class="rank-table history-table">
            <thead>
              <tr>
                <th>Property</th>
                <th>Runs</th>
                <th>Latest score</th>
                <th>Trend</th>
                <th>Last audit</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              ${(await Promise.all(hosts.map(hostRow))).join('')}
            </tbody>
          </table>`}
      </div>

      <div class="panel" id="history-detail" hidden>
        <div class="panel-head"><h3>Property timeline</h3></div>
        <div id="history-detail-body"></div>
      </div>
    `;
    root.innerHTML = html;

    document.getElementById('history-export')?.addEventListener('click', exportAll);
    document.getElementById('history-clear')?.addEventListener('click', async () => {
      if (!confirm('Delete every saved audit? This cannot be undone.')) return;
      await clearAll();
      renderHistoryView();
    });
    root.querySelectorAll('[data-host-detail]').forEach((b) => {
      b.addEventListener('click', () => showHostDetail(b.dataset.hostDetail));
    });
    root.querySelectorAll('[data-host-delete]').forEach((b) => {
      b.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (!confirm(`Delete all saved audits for ${b.dataset.hostDelete}?`)) return;
        await deleteHost(b.dataset.hostDelete);
        renderHistoryView();
      });
    });
  }

  async function hostRow(h) {
    const runs = await listByHost(h.host, 20);
    const series = runs.sort((a, b) => a.timestamp - b.timestamp).map((r) => r.composite);
    const delta = series.length >= 2 ? series[series.length - 1] - series[series.length - 2] : null;
    const grade = h.lastGrade || '—';
    const gradeColor = { A: '#00d4aa', B: '#6aff9a', C: '#ffb547', D: '#ff8a3d', F: '#ff5b6b' }[grade] || '#9aa7c1';
    return `
      <tr data-host-detail="${escape(h.host)}" class="clickable">
        <td class="domain">${escape(h.host)}</td>
        <td class="num">${h.runs}</td>
        <td class="num"><span style="color:${gradeColor}">${h.lastScore} ${grade}</span></td>
        <td>${sparklineSVG(series, { width: 110, height: 24 })} ${renderTrendBadge(delta)}</td>
        <td class="muted small">${new Date(h.lastRun).toLocaleString()}</td>
        <td><button class="btn small ghost" data-host-delete="${escape(h.host)}">Delete</button></td>
      </tr>`;
  }

  async function showHostDetail(host) {
    const root = document.getElementById('history-detail');
    const body = document.getElementById('history-detail-body');
    if (!root || !body) return;
    const runs = await listByHost(host, 50);
    if (!runs.length) { root.hidden = true; return; }
    const sorted = runs.sort((a, b) => a.timestamp - b.timestamp);
    const composite = sorted.map((r) => r.composite);
    body.innerHTML = `
      <h3>${escape(host)}</h3>
      <div class="trend-spark">${sparklineSVG(composite, { width: 600, height: 90 })}</div>
      <table class="rank-table history-detail-table">
        <thead>
          <tr><th>When</th><th>Composite</th><th>On-Page</th><th>Technical</th><th>Content</th><th>Off-Page</th><th>Blockers</th><th></th></tr>
        </thead>
        <tbody>
          ${sorted.reverse().map((r) => {
            const c = r.categories || {};
            const b = r.summary?.blockerCounts || {};
            return `<tr>
              <td class="muted small">${new Date(r.timestamp).toLocaleString()}</td>
              <td class="num">${r.composite} ${r.grade}</td>
              <td class="num">${c.onpage ?? '—'}</td>
              <td class="num">${c.technical ?? '—'}</td>
              <td class="num">${c.content ?? '—'}</td>
              <td class="num">${c.offpage ?? '—'}</td>
              <td class="num">${b.total ?? 0}</td>
              <td><button class="btn small" data-load-id="${escape(r.id)}">Load</button></td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>
    `;
    body.querySelectorAll('[data-load-id]').forEach((b) => {
      b.addEventListener('click', async () => {
        const rec = await getById(b.dataset.loadId);
        if (rec?.full && global.SERPSCOPE?.app?.loadAudit) global.SERPSCOPE.app.loadAudit(rec.full);
      });
    });
    root.hidden = false;
    root.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  async function exportAll() {
    const all = await listAll(9999);
    const blob = new Blob([JSON.stringify({ exported: new Date().toISOString(), audits: all }, null, 2)], { type: 'application/json' });
    const u = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = u; a.download = `serpscope-history-${Date.now()}.json`;
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(u);
  }

  function escape(s) {
    return String(s ?? '').replace(/[&<>"']/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[m]);
  }

  global.SERPSCOPE = global.SERPSCOPE || {};
  global.SERPSCOPE.history = {
    saveAudit, listByHost, listAll, listHosts, getById, getLatestForHost,
    deleteById, deleteHost, clearAll,
    buildTrend, renderInlineTrend, renderHistoryView,
    sparklineSVG,
  };
})(window);
