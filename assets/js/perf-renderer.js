/* ===========================================================
 * SERPSCOPE — Performance / Mobile / Blocker renderer.
 * Builds the deep-dive sections under the main SEO report.
 * =========================================================== */

(function (global) {
  'use strict';

  const B = global.SERPSCOPE.blockers;
  const fmtBytes = B.fmtBytes;
  const fmtMs = B.fmtMs;

  // ── Lighthouse score ring ─────────────────────────────────
  function ringSVG(score, label, size = 64) {
    const s = score == null ? 0 : score;
    const color = s >= 90 ? '#00d4aa' : (s >= 50 ? '#ffb547' : '#ff5b6b');
    const c = 2 * Math.PI * 22;
    const dash = c * (s / 100);
    return `
      <div class="lh-ring" style="--c:${color}">
        <svg viewBox="0 0 50 50" width="${size}" height="${size}">
          <circle cx="25" cy="25" r="22" stroke="#1f2c4a" stroke-width="3" fill="none"/>
          <circle cx="25" cy="25" r="22" stroke="${color}" stroke-width="3" fill="none"
            stroke-dasharray="${dash} ${c}" stroke-linecap="round"
            transform="rotate(-90 25 25)"/>
        </svg>
        <div class="lh-ring-score" style="color:${color}">${score == null ? '—' : score}</div>
        <div class="lh-ring-label">${label}</div>
      </div>`;
  }

  // ── Hero: PSI scores 4-up ─────────────────────────────────
  function renderLighthouseScores(target, mode = 'mobile') {
    const root = document.getElementById('lh-scores');
    if (!root) return;
    const lh = target.lighthouse?.[mode];
    if (!lh) {
      root.innerHTML = `<div class="muted center" style="padding:24px">Lighthouse data unavailable for ${mode}.</div>`;
      return;
    }
    root.innerHTML = [
      ringSVG(lh.scores.performance, 'Performance', 72),
      ringSVG(lh.scores.accessibility, 'Accessibility', 72),
      ringSVG(lh.scores.bestPractices, 'Best Practices', 72),
      ringSVG(lh.scores.seo, 'SEO', 72),
      lh.scores.pwa != null ? ringSVG(lh.scores.pwa, 'PWA', 72) : '',
    ].join('');
  }

  // ── Core Web Vitals (lab + field) ─────────────────────────
  function cwvCard({ label, lab, field, target, unit, lowerIsBetter = true, thresholds }) {
    const cls = (v) => {
      if (v == null) return '';
      if (lowerIsBetter ? v <= thresholds.good : v >= thresholds.good) return 'good';
      if (lowerIsBetter ? v <= thresholds.ni : v >= thresholds.ni) return 'warn';
      return 'bad';
    };
    const labV = lab?.numericValue ?? null;
    const fieldV = field?.percentile ?? null;
    const fmt = (v) => {
      if (v == null) return '—';
      if (unit === 'ms') return fmtMs(v);
      return v.toFixed(unit === 'cls' ? 3 : 2);
    };
    return `
      <div class="cwv-card">
        <div class="cwv-label">${label}</div>
        <div class="cwv-rows">
          <div class="cwv-row">
            <span class="cwv-tag">LAB</span>
            <span class="cwv-val ${cls(labV)}">${lab?.displayValue || fmt(labV)}</span>
          </div>
          <div class="cwv-row">
            <span class="cwv-tag field">FIELD</span>
            <span class="cwv-val ${cls(fieldV)}">${fieldV == null ? 'no data' : (unit === 'ms' ? fmtMs(fieldV) : (fieldV / (unit === 'cls' ? 100 : 1)).toFixed(unit === 'cls' ? 3 : 0) + (unit === 'cls' ? '' : ' ms'))}</span>
          </div>
        </div>
        ${field?.distributions ? renderDist(field.distributions) : ''}
        <div class="cwv-target muted">Target ≤ ${target}</div>
      </div>`;
  }

  function renderDist(d) {
    if (!d || !d.length) return '';
    // d is array of {min,max,proportion}
    const good = (d[0]?.proportion || 0) * 100;
    const ni = (d[1]?.proportion || 0) * 100;
    const poor = (d[2]?.proportion || 0) * 100;
    return `
      <div class="cwv-dist">
        <div style="background:#00d4aa;width:${good.toFixed(1)}%" title="Good ${good.toFixed(0)}%"></div>
        <div style="background:#ffb547;width:${ni.toFixed(1)}%" title="Needs improvement ${ni.toFixed(0)}%"></div>
        <div style="background:#ff5b6b;width:${poor.toFixed(1)}%" title="Poor ${poor.toFixed(0)}%"></div>
      </div>
      <div class="cwv-dist-legend">
        <span>${good.toFixed(0)}%</span>
        <span>${ni.toFixed(0)}%</span>
        <span>${poor.toFixed(0)}%</span>
      </div>`;
  }

  function renderCWV(target, mode = 'mobile') {
    const root = document.getElementById('cwv-grid');
    if (!root) return;
    const lh = target.lighthouse?.[mode];
    if (!lh) { root.innerHTML = `<div class="muted center" style="padding:18px">No Lighthouse data.</div>`; return; }
    const f = lh.field || {};
    root.innerHTML = [
      cwvCard({ label: 'Largest Contentful Paint', lab: lh.metrics.lcp, field: f.lcp, target: '2.5 s', unit: 'ms', thresholds: { good: 2500, ni: 4000 } }),
      cwvCard({ label: 'Cumulative Layout Shift', lab: lh.metrics.cls, field: f.cls, target: '0.1', unit: 'cls', thresholds: { good: 0.1, ni: 0.25 } }),
      cwvCard({ label: 'Interaction to Next Paint', lab: lh.metrics.inp, field: f.inp, target: '200 ms', unit: 'ms', thresholds: { good: 200, ni: 500 } }),
      cwvCard({ label: 'First Contentful Paint', lab: lh.metrics.fcp, field: f.fcp, target: '1.8 s', unit: 'ms', thresholds: { good: 1800, ni: 3000 } }),
      cwvCard({ label: 'Total Blocking Time', lab: lh.metrics.tbt, field: null, target: '200 ms', unit: 'ms', thresholds: { good: 200, ni: 600 } }),
      cwvCard({ label: 'Time to First Byte', lab: lh.metrics.ttfb, field: f.ttfb, target: '800 ms', unit: 'ms', thresholds: { good: 800, ni: 1800 } }),
    ].join('');

    // Originate label
    const fieldNote = document.getElementById('cwv-field-note');
    if (fieldNote) {
      if (lh.field?.overall) {
        fieldNote.textContent = `Field data: real-world ${lh.field.overall} performance from Chrome users (CrUX, trailing 28 days).`;
      } else {
        fieldNote.textContent = 'Field data: insufficient real-world traffic — Lab data only. (CrUX requires ~1k+ daily users.)';
      }
    }
  }

  // ── Filmstrip + final screenshot ──────────────────────────
  function renderFilmstrip(target, mode = 'mobile') {
    const root = document.getElementById('filmstrip');
    if (!root) return;
    const lh = target.lighthouse?.[mode];
    if (!lh) { root.innerHTML = ''; return; }
    const items = lh.screenshots?.filmstrip || [];
    if (!items.length && !lh.screenshots?.final) { root.innerHTML = `<div class="muted">No screenshots from Lighthouse.</div>`; return; }
    let html = '<div class="filmstrip-wrap">';
    items.forEach((it) => {
      const t = it.timing ? (it.timing / 1000).toFixed(2) + 's' : '';
      html += `<div class="film-frame"><img alt="t+${t}" src="${it.data}"/><span>${t}</span></div>`;
    });
    if (lh.screenshots.final) {
      html += `<div class="film-frame final"><img alt="final" src="${lh.screenshots.final}"/><span>final</span></div>`;
    }
    html += '</div>';
    root.innerHTML = html;
  }

  // ── Mobile compatibility panel ────────────────────────────
  function renderMobileCompat(target) {
    const root = document.getElementById('mobile-compat-grid');
    if (!root) return;
    const lh = target.lighthouse?.mobile;
    const items = [];

    if (lh) {
      items.push({
        status: lh.mobile.viewportPass ? 'pass' : 'fail',
        title: 'Mobile viewport',
        detail: lh.mobile.viewportPass ? 'Responsive viewport meta detected' : 'Viewport meta is missing or non-responsive',
        value: lh.mobile.viewportPass ? 'OK' : 'FAIL',
      });
      const tt = lh.mobile.tapTargets || [];
      items.push({
        status: tt.length === 0 ? 'pass' : (tt.length < 5 ? 'warn' : 'fail'),
        title: 'Tap target sizing',
        detail: tt.length === 0 ? 'All tap targets ≥ 48×48 px with proper spacing'
          : `${tt.length} targets too small or too close together — risk of mis-taps`,
        value: tt.length === 0 ? 'OK' : `${tt.length} issue${tt.length === 1 ? '' : 's'}`,
      });
      const fs = lh.mobile.fontSize || [];
      const fsScore = target.lighthouse?.mobile?.scores?.seo;
      items.push({
        status: fs.length === 0 ? 'pass' : 'warn',
        title: 'Legible font sizes',
        detail: fs.length === 0 ? 'Body text ≥ 12 px throughout' : `${fs.length} text regions smaller than 12 px`,
        value: fs.length === 0 ? 'OK' : `${fs.length} small`,
      });
      const ri = lh.mobile.responsiveImages || [];
      items.push({
        status: ri.length === 0 ? 'pass' : (ri.length < 5 ? 'warn' : 'fail'),
        title: 'Responsive images (srcset)',
        detail: ri.length === 0 ? 'Images served at appropriate sizes'
          : `${ri.length} images delivered larger than rendered — mobile bandwidth waste`,
        value: ri.length === 0 ? 'OK' : `${ri.length} oversized`,
      });
      const ui = lh.mobile.unsizedImages || [];
      items.push({
        status: ui.length === 0 ? 'pass' : 'warn',
        title: 'Images have dimensions (CLS)',
        detail: ui.length === 0 ? 'All images have width/height or aspect-ratio'
          : `${ui.length} images missing dimensions — causes layout shift`,
        value: ui.length === 0 ? 'OK' : `${ui.length} unsized`,
      });
      // Mobile vs desktop performance delta
      const mobS = lh.scores.performance, desS = target.lighthouse?.desktop?.scores?.performance;
      if (mobS != null && desS != null) {
        const delta = desS - mobS;
        items.push({
          status: delta <= 10 ? 'pass' : (delta <= 25 ? 'warn' : 'fail'),
          title: 'Mobile-desktop perf gap',
          detail: `Mobile perf ${mobS}, desktop ${desS} — gap of ${delta} points`,
          value: `Δ${delta}`,
        });
      }
    }

    // From client signals
    const s = target.signals;
    items.push({
      status: /width=device-width/i.test(s.viewport) ? 'pass' : 'fail',
      title: 'Viewport meta declared',
      detail: s.viewport || 'not declared',
      value: /width=device-width/i.test(s.viewport) ? 'OK' : '—',
    });
    const lazy = s.images.lazy, totalImg = s.images.total;
    items.push({
      status: totalImg < 5 ? 'info' : (lazy / totalImg >= 0.5 ? 'pass' : 'warn'),
      title: 'Lazy-loading attribute',
      detail: totalImg ? `${lazy}/${totalImg} images use loading="lazy"` : 'no images',
      value: totalImg ? `${Math.round((lazy / totalImg) * 100)}%` : '—',
    });
    const modern = s.images.modern;
    items.push({
      status: totalImg < 5 ? 'info' : (modern / totalImg >= 0.3 ? 'pass' : 'warn'),
      title: 'Modern image formats',
      detail: totalImg ? `${modern}/${totalImg} images are WebP/AVIF` : 'no images',
      value: totalImg ? `${modern}` : '—',
    });

    root.innerHTML = items.map((it) => {
      const sym = { pass: '✓', warn: '!', fail: '✕', info: 'i' }[it.status] || '·';
      return `<div class="audit-item ${it.status}">
        <div class="audit-icon">${sym}</div>
        <div class="audit-body">
          <div class="audit-title">${escape(it.title)}</div>
          <div class="audit-detail">${escape(it.detail)}</div>
        </div>
        <div class="audit-value">${escape(String(it.value))}</div>
      </div>`;
    }).join('');
  }

  // ── Performance breakdown panel ──────────────────────────
  function renderPerfBreakdown(target, mode = 'mobile') {
    const root = document.getElementById('perf-breakdown');
    if (!root) return;
    const lh = target.lighthouse?.[mode];
    if (!lh) { root.innerHTML = `<div class="muted center" style="padding:18px">No Lighthouse data.</div>`; return; }

    const totalBytes = lh.totals.totalBytes;
    const reqCount = lh.totals.requestCount;
    const domSize = lh.totals.domSize;

    // Resource summary
    const rs = lh.resourceSummary || [];
    const rsRows = rs.map((r) => `
      <tr>
        <td>${escape(prettyResType(r.resourceType || r.label))}</td>
        <td class="num">${r.requestCount || 0}</td>
        <td class="num">${fmtBytes(r.transferSize || 0)}</td>
      </tr>`).join('');

    // Third parties
    const tp = lh.thirdParties || [];
    const tpRows = tp.slice(0, 10).map((t) => `
      <tr>
        <td>${escape(t.entity?.text || t.entity || '')}</td>
        <td class="num">${fmtMs(t.mainThreadTime || 0)}</td>
        <td class="num">${fmtMs(t.blockingTime || 0)}</td>
        <td class="num">${fmtBytes(t.transferSize || 0)}</td>
      </tr>`).join('');

    // Long tasks
    const lt = lh.longTasks || [];
    const ltSummary = lt.length === 0 ? '<div class="muted">No long tasks &gt; 50 ms</div>' :
      `<div class="micro-stat"><span class="num">${lt.length}</span><span class="lbl">long tasks</span></div>
       <div class="micro-stat"><span class="num">${fmtMs(lt.reduce((a, t) => a + (t.duration || 0), 0))}</span><span class="lbl">total duration</span></div>
       <div class="micro-stat"><span class="num">${fmtMs(Math.max(...lt.map((t) => t.duration || 0)))}</span><span class="lbl">longest</span></div>`;

    // LCP element
    let lcpBlock = '';
    if (lh.lcpElement) {
      const e = lh.lcpElement.node || lh.lcpElement;
      lcpBlock = `
        <div class="lcp-block">
          <div class="muted small">Largest Contentful Paint element</div>
          <code class="lcp-selector">${escape(e?.selector || e?.path || '—')}</code>
          ${e?.snippet ? `<pre class="lcp-snippet">${escape(e.snippet)}</pre>` : ''}
        </div>`;
    }

    root.innerHTML = `
      <div class="perf-totals">
        <div class="micro-stat"><span class="num">${fmtBytes(totalBytes)}</span><span class="lbl">total weight</span></div>
        <div class="micro-stat"><span class="num">${reqCount}</span><span class="lbl">requests</span></div>
        <div class="micro-stat"><span class="num">${domSize.toLocaleString()}</span><span class="lbl">DOM nodes</span></div>
        <div class="micro-stat"><span class="num">${(lh.bootup || []).length}</span><span class="lbl">scripts profiled</span></div>
      </div>

      ${lcpBlock}

      <div class="perf-grid-2">
        <div class="perf-sub">
          <h4>Resource summary</h4>
          <table class="rank-table">
            <thead><tr><th>Type</th><th>Count</th><th>Size</th></tr></thead>
            <tbody>${rsRows || '<tr><td colspan="3" class="muted">No data</td></tr>'}</tbody>
          </table>
        </div>
        <div class="perf-sub">
          <h4>Top third parties (main-thread impact)</h4>
          <table class="rank-table">
            <thead><tr><th>Entity</th><th>Main-thread</th><th>Blocking</th><th>Bytes</th></tr></thead>
            <tbody>${tpRows || '<tr><td colspan="4" class="muted">No third parties detected</td></tr>'}</tbody>
          </table>
        </div>
      </div>

      <div class="perf-sub">
        <h4>Long tasks (&gt; 50 ms on main thread)</h4>
        <div class="micro-row">${ltSummary}</div>
      </div>
    `;
  }

  function prettyResType(t) {
    return { document: 'HTML', stylesheet: 'CSS', script: 'JavaScript', image: 'Images', font: 'Fonts', media: 'Media', other: 'Other', third_party: 'Third-party' }[t] || t || 'Other';
  }

  // ── Detailed blockers list ────────────────────────────────
  let allBlockers = [];
  let blockerFilter = { sev: 'all', cat: 'all', device: 'all' };

  function renderBlockers(blockers) {
    allBlockers = blockers;
    renderBlockerCounts();
    applyBlockerFilter();
  }

  function renderBlockerCounts() {
    const counts = { P0: 0, P1: 0, P2: 0, P3: 0 };
    let totalMs = 0, totalBytes = 0;
    allBlockers.forEach((b) => {
      counts[b.severity]++;
      totalMs += b.savings.ms || 0;
      totalBytes += b.savings.bytes || 0;
    });
    const root = document.getElementById('blocker-summary');
    if (!root) return;
    root.innerHTML = `
      <div class="blocker-stat"><span class="num p0">${counts.P0}</span><span class="lbl">critical (P0)</span></div>
      <div class="blocker-stat"><span class="num p1">${counts.P1}</span><span class="lbl">high (P1)</span></div>
      <div class="blocker-stat"><span class="num p2">${counts.P2}</span><span class="lbl">medium (P2)</span></div>
      <div class="blocker-stat"><span class="num p3">${counts.P3}</span><span class="lbl">low (P3)</span></div>
      <div class="blocker-stat"><span class="num">${fmtMs(totalMs)}</span><span class="lbl">total time savings</span></div>
      <div class="blocker-stat"><span class="num">${fmtBytes(totalBytes)}</span><span class="lbl">total byte savings</span></div>
    `;
  }

  function applyBlockerFilter() {
    const root = document.getElementById('blockers-list');
    if (!root) return;
    const list = allBlockers.filter((b) => {
      if (blockerFilter.sev !== 'all' && b.severity !== blockerFilter.sev) return false;
      if (blockerFilter.cat !== 'all' && b.category !== blockerFilter.cat) return false;
      if (blockerFilter.device !== 'all' && b.device !== blockerFilter.device && b.device !== 'both') return false;
      return true;
    });
    if (!list.length) {
      root.innerHTML = `<div class="muted center" style="padding:30px">No blockers match this filter.</div>`;
      return;
    }
    root.innerHTML = list.map(renderBlocker).join('');
  }

  function renderBlocker(b) {
    const savings = [];
    if (b.savings.ms) savings.push(`<span class="save save-ms">⏱ −${fmtMs(b.savings.ms)}</span>`);
    if (b.savings.bytes) savings.push(`<span class="save save-bytes">↓ ${fmtBytes(b.savings.bytes)}</span>`);
    if (!savings.length && b.displayValue) savings.push(`<span class="save">${escape(b.displayValue)}</span>`);

    const elements = (b.elements || []).slice(0, 5);
    const elsHtml = elements.length ? `
      <details class="blocker-els">
        <summary>${elements.length} affected element${elements.length === 1 ? '' : 's'}</summary>
        <ul>
          ${elements.map((e) => `<li>
            ${e.selector ? `<code>${escape(e.selector)}</code>` : ''}
            ${e.url ? `<div class="blocker-url">${escape(e.url)}</div>` : ''}
            ${e.snippet ? `<pre>${escape(e.snippet).slice(0, 240)}</pre>` : ''}
            <span class="blocker-el-meta">
              ${e.size ? fmtBytes(e.size) : ''}
              ${e.wastedBytes ? ' · saves ' + fmtBytes(e.wastedBytes) : ''}
              ${e.wastedMs ? ' · saves ' + fmtMs(e.wastedMs) : ''}
              ${e.duration ? ' · ' + fmtMs(e.duration) : ''}
            </span>
          </li>`).join('')}
        </ul>
      </details>` : '';

    return `
      <div class="blocker-card" data-priority="${b.severity}">
        <div class="blocker-head">
          <span class="pill ${b.severity.toLowerCase()}">${b.severity}</span>
          <span class="blocker-cat">${escape(b.category)}</span>
          <span class="blocker-device device-${b.device}">${b.device.toUpperCase()}</span>
          <span class="blocker-source">${b.source}</span>
        </div>
        <h4 class="blocker-title">${escape(b.title)}</h4>
        <p class="blocker-desc">${stripMd(b.description)}</p>
        <p class="blocker-fix"><b>Fix.</b> ${escape(b.fix)}</p>
        ${b.steps?.length ? `<ol class="blocker-steps">${b.steps.map((s) => `<li>${escape(s)}</li>`).join('')}</ol>` : ''}
        ${savings.length ? `<div class="blocker-savings">${savings.join('')}</div>` : ''}
        ${elsHtml}
      </div>`;
  }

  function setBlockerFilter(key, val) {
    blockerFilter[key] = val;
    applyBlockerFilter();
  }

  // ── Device toggle wiring ───────────────────────────────────
  function bindDeviceToggle(target) {
    document.querySelectorAll('[data-device]').forEach((btn) => {
      btn.onclick = () => {
        document.querySelectorAll('[data-device]').forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        const mode = btn.dataset.device;
        renderLighthouseScores(target, mode);
        renderCWV(target, mode);
        renderFilmstrip(target, mode);
        renderPerfBreakdown(target, mode);
      };
    });
  }

  function escape(s) {
    return String(s ?? '').replace(/[&<>"']/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[m]);
  }
  function stripMd(s) {
    // Strip Lighthouse markdown links + bold/italic
    return escape(String(s ?? '').replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').replace(/\*\*([^*]+)\*\*/g, '$1').replace(/`([^`]+)`/g, '$1'));
  }

  global.SERPSCOPE = global.SERPSCOPE || {};
  global.SERPSCOPE.perf = {
    renderLighthouseScores, renderCWV, renderFilmstrip,
    renderMobileCompat, renderPerfBreakdown,
    renderBlockers, setBlockerFilter, applyBlockerFilter,
    bindDeviceToggle,
  };
})(window);
