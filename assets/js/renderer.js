/* ===========================================================
 * Renderer — turns audit + competitor data into the UI.
 * =========================================================== */

(function (global) {
  'use strict';

  const A = global.SERPSCOPE.analyzer;

  // Color helpers
  function gradeColor(g) {
    return { A: '#00d4aa', B: '#6aff9a', C: '#ffb547', D: '#ff8a3d', F: '#ff5b6b' }[g] || '#9aa7c1';
  }

  function tagline(audit) {
    const c = audit.composite;
    if (c >= 90) return 'Exceptional SEO health. Maintain & monitor for regressions.';
    if (c >= 80) return 'Strong fundamentals with high-leverage refinements available.';
    if (c >= 65) return 'Solid foundation, several material gaps suppressing performance.';
    if (c >= 50) return 'Significant gaps across multiple categories — priority remediation recommended.';
    return 'Critical SEO debt. Foundational fixes required before content investment will pay off.';
  }

  // ── Hero & gauge ───────────────────────────────────────────
  function drawGauge(canvas, score, color) {
    const ctx = canvas.getContext('2d');
    const w = canvas.width, h = canvas.height;
    ctx.clearRect(0, 0, w, h);
    const cx = w / 2, cy = h / 2;
    const r = Math.min(w, h) / 2 - 16;
    // background ring
    ctx.lineWidth = 14;
    ctx.strokeStyle = '#1f2c4a';
    ctx.beginPath();
    ctx.arc(cx, cy, r, -Math.PI * 0.75, Math.PI * 0.75);
    ctx.stroke();
    // value
    const t = score / 100;
    const end = -Math.PI * 0.75 + (Math.PI * 1.5) * t;
    const grad = ctx.createLinearGradient(0, 0, w, 0);
    grad.addColorStop(0, color);
    grad.addColorStop(1, color + 'cc');
    ctx.strokeStyle = grad;
    ctx.beginPath();
    ctx.arc(cx, cy, r, -Math.PI * 0.75, end);
    ctx.stroke();
    // score text
    ctx.fillStyle = '#e6ecf5';
    ctx.font = '700 48px "JetBrains Mono", monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(score), cx, cy - 8);
    ctx.font = '500 11px Inter, sans-serif';
    ctx.fillStyle = '#9aa7c1';
    ctx.fillText('SERPSCOPE INDEX', cx, cy + 24);
  }

  function renderHero(audit, rank, actions) {
    const t = audit;
    document.getElementById('hero-target').textContent = t.host;
    document.getElementById('hero-tagline').textContent = tagline(t);
    document.getElementById('kpi-score').textContent = t.composite;
    document.getElementById('kpi-rank').textContent = `#${rank.position}`;
    const critical = actions.filter((a) => a.priority === 'P0').length;
    const quick = actions.filter((a) => a.quickwin).length;
    document.getElementById('kpi-critical').textContent = critical;
    document.getElementById('kpi-wins').textContent = quick;

    const grade = document.getElementById('grade-badge');
    grade.textContent = `Grade ${t.grade}`;
    grade.className = 'grade-badge ' + t.grade;

    drawGauge(document.getElementById('gauge'), t.composite, gradeColor(t.grade));

    document.getElementById('report-meta').textContent =
      `Audited ${new Date(t.timestamp).toLocaleString()} · ${t.url}`;
  }

  // ── Scorecards ─────────────────────────────────────────────
  function renderScorecards(audit) {
    const cats = [
      { key: 'onpage', label: 'On-Page', weight: A.WEIGHTS.onpage },
      { key: 'technical', label: 'Technical', weight: A.WEIGHTS.technical },
      { key: 'content', label: 'Content', weight: A.WEIGHTS.content },
      { key: 'offpage', label: 'Off-Page', weight: A.WEIGHTS.offpage },
    ];
    const root = document.getElementById('scorecards');
    root.innerHTML = '';
    cats.forEach((c) => {
      const cat = audit.categories[c.key];
      const grade = A.gradeOf(cat.score);
      const color = gradeColor(grade);
      const passing = cat.details.filter((d) => d.status === 'pass').length;
      const failing = cat.details.filter((d) => d.status === 'fail').length;
      const card = document.createElement('div');
      card.className = 'scorecard';
      card.innerHTML = `
        <div class="scorecard-head">
          <span class="scorecard-title">${c.label}</span>
          <span class="scorecard-weight">${Math.round(c.weight * 100)}% weight</span>
        </div>
        <div class="scorecard-score" style="color:${color}">
          ${cat.score}<span class="scorecard-grade" style="color:${color}">·${grade}</span>
        </div>
        <div class="scorecard-bar">
          <div class="scorecard-bar-fill" style="width:${cat.score}%;background:${color}"></div>
        </div>
        <div class="scorecard-meta">
          <span>${passing} passing</span>
          <span>${failing} failing</span>
        </div>
      `;
      root.appendChild(card);
    });
  }

  // ── Competitor chart ───────────────────────────────────────
  let chartInst = null;
  function renderCompetitorChart(target, comps, mode = 'radar') {
    const canvas = document.getElementById('competitor-chart');
    const ctx = canvas.getContext('2d');
    if (chartInst) { chartInst.destroy(); chartInst = null; }
    const all = [target, ...comps].filter(Boolean);
    const palette = ['#00d4aa', '#6aa1ff', '#b779ff', '#ffb547', '#ff5b6b', '#6aff9a'];

    if (mode === 'radar') {
      chartInst = new Chart(ctx, {
        type: 'radar',
        data: {
          labels: ['On-Page', 'Technical', 'Content', 'Off-Page'],
          datasets: all.map((s, i) => ({
            label: s.host,
            data: [s.categories.onpage.score, s.categories.technical.score, s.categories.content.score, s.categories.offpage.score],
            borderColor: palette[i % palette.length],
            backgroundColor: i === 0 ? palette[0] + '33' : palette[i % palette.length] + '11',
            borderWidth: i === 0 ? 2.5 : 1.5,
            pointRadius: i === 0 ? 4 : 2,
            pointBackgroundColor: palette[i % palette.length],
          })),
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: { legend: { position: 'bottom', labels: { color: '#9aa7c1', font: { family: 'Inter', size: 11 }, boxWidth: 12 } } },
          scales: {
            r: {
              min: 0, max: 100,
              ticks: { color: '#6b7997', backdropColor: 'transparent', stepSize: 25, font: { size: 10 } },
              grid: { color: '#1f2c4a' },
              angleLines: { color: '#1f2c4a' },
              pointLabels: { color: '#9aa7c1', font: { family: 'Inter', size: 11 } },
            },
          },
        },
      });
    } else if (mode === 'bars') {
      chartInst = new Chart(ctx, {
        type: 'bar',
        data: {
          labels: all.map((s) => s.host),
          datasets: [
            { label: 'On-Page', data: all.map((s) => s.categories.onpage.score), backgroundColor: palette[0] },
            { label: 'Technical', data: all.map((s) => s.categories.technical.score), backgroundColor: palette[1] },
            { label: 'Content', data: all.map((s) => s.categories.content.score), backgroundColor: palette[2] },
            { label: 'Off-Page', data: all.map((s) => s.categories.offpage.score), backgroundColor: palette[3] },
          ],
        },
        options: {
          responsive: true, maintainAspectRatio: false,
          plugins: { legend: { position: 'bottom', labels: { color: '#9aa7c1', font: { family: 'Inter', size: 11 }, boxWidth: 12 } } },
          scales: {
            x: { ticks: { color: '#9aa7c1', font: { size: 10 } }, grid: { color: '#1f2c4a' } },
            y: { min: 0, max: 100, ticks: { color: '#6b7997' }, grid: { color: '#1f2c4a' } },
          },
        },
      });
    } else if (mode === 'matrix') {
      // bubble: x=content score, y=technical score, size=composite
      chartInst = new Chart(ctx, {
        type: 'bubble',
        data: {
          datasets: all.map((s, i) => ({
            label: s.host,
            data: [{ x: s.categories.content.score, y: s.categories.technical.score, r: 6 + s.composite / 8 }],
            backgroundColor: palette[i % palette.length] + 'aa',
            borderColor: palette[i % palette.length],
            borderWidth: 1.5,
          })),
        },
        options: {
          responsive: true, maintainAspectRatio: false,
          plugins: {
            legend: { position: 'bottom', labels: { color: '#9aa7c1', font: { family: 'Inter', size: 11 }, boxWidth: 12 } },
            tooltip: { callbacks: { label: (c) => `${c.dataset.label} — content ${c.parsed.x}, tech ${c.parsed.y}` } },
          },
          scales: {
            x: { title: { display: true, text: 'Content Score', color: '#9aa7c1' }, min: 0, max: 100, ticks: { color: '#6b7997' }, grid: { color: '#1f2c4a' } },
            y: { title: { display: true, text: 'Technical Score', color: '#9aa7c1' }, min: 0, max: 100, ticks: { color: '#6b7997' }, grid: { color: '#1f2c4a' } },
          },
        },
      });
    }
  }

  function renderRankTable(target, comps) {
    const all = [target, ...comps].filter(Boolean);
    const sorted = [...all].sort((a, b) => b.composite - a.composite);
    const tbody = document.querySelector('#rank-table tbody');
    tbody.innerHTML = '';
    sorted.forEach((s, i) => {
      const self = s.host === target.host;
      const tr = document.createElement('tr');
      if (self) tr.className = 'self';
      const miniBar = (n, c) => `<div class="bar-mini"><div class="bar-mini-fill" style="width:${n}%;background:${c}"></div></div>`;
      tr.innerHTML = `
        <td>#${i + 1}</td>
        <td class="domain">${s.host}${self ? ' <span class="badge">YOU</span>' : ''}</td>
        <td class="score-cell">${s.composite} <span style="color:${gradeColor(s.grade)}">${s.grade}</span></td>
        <td>${s.categories.onpage.score}${miniBar(s.categories.onpage.score, '#00d4aa')}</td>
        <td>${s.categories.technical.score}${miniBar(s.categories.technical.score, '#6aa1ff')}</td>
        <td>${s.categories.content.score}${miniBar(s.categories.content.score, '#b779ff')}</td>
        <td>${s.categories.offpage.score}${miniBar(s.categories.offpage.score, '#ffb547')}</td>
      `;
      tbody.appendChild(tr);
    });
  }

  function rankOf(target, comps) {
    const all = [target, ...comps].filter(Boolean);
    const sorted = [...all].sort((a, b) => b.composite - a.composite);
    return { position: sorted.findIndex((s) => s.host === target.host) + 1, total: sorted.length };
  }

  // ── Audit grid ─────────────────────────────────────────────
  function renderAuditGrid(elId, items) {
    const root = document.getElementById(elId);
    root.innerHTML = '';
    items.forEach((it) => {
      const div = document.createElement('div');
      div.className = `audit-item ${it.status}`;
      const sym = { pass: '✓', warn: '!', fail: '✕', info: 'i' }[it.status] || '·';
      div.innerHTML = `
        <div class="audit-icon">${sym}</div>
        <div class="audit-body">
          <div class="audit-title">${escapeHtml(it.title)}</div>
          <div class="audit-detail">${escapeHtml(it.detail).slice(0, 280)}</div>
        </div>
        <div class="audit-value">${escapeHtml(String(it.value))}</div>
      `;
      root.appendChild(div);
    });
  }

  // ── Actions ────────────────────────────────────────────────
  let allActions = [];
  function renderActions(actions) {
    allActions = actions;
    applyActionFilter('all');
  }

  function applyActionFilter(filter) {
    const root = document.getElementById('actions-list');
    root.innerHTML = '';
    const list = allActions.filter((a) => {
      if (filter === 'all') return true;
      if (filter === 'quickwin') return a.quickwin;
      return a.priority === filter;
    });
    if (!list.length) {
      root.innerHTML = `<div class="muted center" style="padding:30px">No actions match this filter.</div>`;
      return;
    }
    list.forEach((a) => {
      const div = document.createElement('div');
      div.className = 'action-card';
      div.dataset.priority = a.priority;
      div.innerHTML = `
        <div class="action-priority">
          <span class="pill ${a.priority.toLowerCase()}">${a.priority}</span>
          <div class="action-impact-label">Impact</div>
          <div class="action-impact-val">${a.impact}</div>
        </div>
        <div class="action-body">
          <h4>${escapeHtml(a.title)}</h4>
          <p><b>Problem.</b> ${escapeHtml(a.problem)}</p>
          <p><b>Recommendation.</b> ${escapeHtml(a.fix)}</p>
          ${a.steps && a.steps.length ? `<ol class="action-steps">${a.steps.map((s) => `<li>${escapeHtml(s)}</li>`).join('')}</ol>` : ''}
          <div class="action-tags">
            <span class="action-tag">${a.category}</span>
            ${a.quickwin ? '<span class="action-tag" style="color:#00d4aa">quick-win</span>' : ''}
          </div>
        </div>
        <div class="action-meta">
          <span class="action-effort">⏱ ${a.effort}</span>
        </div>
      `;
      root.appendChild(div);
    });
  }

  // ── Site crawl report ──────────────────────────────────────
  function shortUrl(u) {
    try { const x = new URL(u); return (x.pathname + x.search) || '/'; } catch { return u; }
  }

  function urlList(urls, cap = 25) {
    if (!urls || !urls.length) return '';
    const shown = urls.slice(0, cap).map((u) => `<li><a href="${escapeHtml(u)}" target="_blank" rel="noopener">${escapeHtml(shortUrl(u))}</a></li>`).join('');
    const more = urls.length > cap ? `<li class="muted">+${urls.length - cap} more</li>` : '';
    return `<ul class="crawl-url-list">${shown}${more}</ul>`;
  }

  function issueBlock(title, body, count, tone = 'warn') {
    if (!count) return '';
    return `<details class="crawl-issue ${tone}">
      <summary><span class="crawl-issue-count ${tone}">${count}</span> ${escapeHtml(title)}</summary>
      <div class="crawl-issue-body">${body}</div>
    </details>`;
  }

  function actionCardHtml(a) {
    return `<div class="action-card" data-priority="${a.priority}">
      <div class="action-priority">
        <span class="pill ${a.priority.toLowerCase()}">${a.priority}</span>
        <div class="action-impact-label">Impact</div>
        <div class="action-impact-val">${a.impact}</div>
      </div>
      <div class="action-body">
        <h4>${escapeHtml(a.title)}</h4>
        <p><b>Problem.</b> ${escapeHtml(a.problem)}</p>
        <p><b>Recommendation.</b> ${escapeHtml(a.fix)}</p>
        ${a.steps && a.steps.length ? `<ol class="action-steps">${a.steps.map((s) => `<li>${escapeHtml(s)}</li>`).join('')}</ol>` : ''}
        <div class="action-tags">
          <span class="action-tag">${escapeHtml(a.category)}</span>
          ${a.quickwin ? '<span class="action-tag" style="color:#00d4aa">quick-win</span>' : ''}
        </div>
      </div>
      <div class="action-meta"><span class="action-effort">⏱ ${escapeHtml(a.effort)}</span></div>
    </div>`;
  }

  function renderSiteCrawl(site, actions, meta) {
    const wrap = document.getElementById('site-crawl-wrap');
    if (!wrap) return;
    wrap.hidden = false;

    const tile = (label, value, tone) =>
      `<div class="crawl-stat ${tone || ''}"><div class="crawl-stat-val">${value}</div><div class="crawl-stat-label">${escapeHtml(label)}</div></div>`;

    const dupCount = site.duplicateTitles.reduce((s, d) => s + d.urls.length, 0);
    const summary = document.getElementById('site-crawl-summary');
    summary.innerHTML = [
      tile('Pages crawled', site.pageCount, 'good'),
      tile('Avg page score', site.avgComposite, site.avgComposite >= 65 ? 'good' : 'warn'),
      tile('In sitemap', meta.sitemapCount, ''),
      tile('Dup. titles', dupCount, dupCount ? 'bad' : 'good'),
      tile('Thin pages', site.thinPages.length, site.thinPages.length ? 'warn' : 'good'),
      tile('Orphan pages', site.orphans.length, site.orphans.length ? 'warn' : 'good'),
      tile('noindex', site.noindexPages.length, site.noindexPages.length ? 'warn' : 'good'),
      tile('Failed', site.failed.length, site.failed.length ? 'bad' : 'good'),
    ].join('');

    // Issue accordions
    const issues = [
      issueBlock('Duplicate title tags',
        site.duplicateTitles.map((d) => `<div class="crawl-dup"><div class="crawl-dup-val">“${escapeHtml(d.value)}” <span class="muted">×${d.urls.length}</span></div>${urlList(d.urls)}</div>`).join(''),
        site.duplicateTitles.length, 'bad'),
      issueBlock('Duplicate meta descriptions',
        site.duplicateDescriptions.map((d) => `<div class="crawl-dup"><div class="crawl-dup-val">“${escapeHtml(d.value.slice(0, 120))}…” <span class="muted">×${d.urls.length}</span></div>${urlList(d.urls)}</div>`).join(''),
        site.duplicateDescriptions.length, 'warn'),
      issueBlock('Duplicate H1 headings',
        site.duplicateH1s.map((d) => `<div class="crawl-dup"><div class="crawl-dup-val">“${escapeHtml(d.value)}” <span class="muted">×${d.urls.length}</span></div>${urlList(d.urls)}</div>`).join(''),
        site.duplicateH1s.length, 'warn'),
      issueBlock('Thin pages (< 300 words)',
        `<ul class="crawl-url-list">${site.thinPages.slice(0, 40).map((p) => `<li><a href="${escapeHtml(p.url)}" target="_blank" rel="noopener">${escapeHtml(shortUrl(p.url))}</a> <span class="muted">${p.words} words</span></li>`).join('')}</ul>`,
        site.thinPages.length, 'warn'),
      issueBlock('Pages missing a title', urlList(site.missingTitle), site.missingTitle.length, 'bad'),
      issueBlock('Pages missing a meta description', urlList(site.missingDesc), site.missingDesc.length, 'warn'),
      issueBlock('Pages missing an H1', urlList(site.missingH1), site.missingH1.length, 'warn'),
      issueBlock('Pages missing a canonical tag', urlList(site.missingCanonical), site.missingCanonical.length, 'warn'),
      issueBlock('noindex pages', urlList(site.noindexPages), site.noindexPages.length, 'warn'),
      issueBlock('Potential orphan pages (in sitemap, not internally linked)', urlList(site.orphans), site.orphans.length, 'warn'),
      issueBlock('Pages served over HTTP', urlList(site.httpPages), site.httpPages.length, 'bad'),
      issueBlock('Pages that failed to fetch',
        `<ul class="crawl-url-list">${site.failed.map((f) => `<li>${escapeHtml(shortUrl(f.url))} <span class="muted">${escapeHtml(f.error || '')}</span></li>`).join('')}</ul>`,
        site.failed.length, 'bad'),
    ].join('');

    // Per-page table (worst first)
    const rows = site.pages.slice()
      .sort((a, b) => (a.composite || 0) - (b.composite || 0))
      .map((p) => {
        const s = p.signals || {};
        const flags = [];
        if (!s.title) flags.push('no title');
        if (!s.metaDesc) flags.push('no desc');
        if (!(s.headings && s.headings.h1.length)) flags.push('no H1');
        if ((s.wordCount || 0) < 300) flags.push('thin');
        if (/noindex/i.test(s.robots || '')) flags.push('noindex');
        if (!s.canonical) flags.push('no canonical');
        return `<tr>
          <td class="domain"><a href="${escapeHtml(p.url)}" target="_blank" rel="noopener">${escapeHtml(shortUrl(p.url))}</a></td>
          <td class="score-cell">${p.composite} <span style="color:${gradeColor(p.grade)}">${p.grade}</span></td>
          <td>${s.wordCount || 0}</td>
          <td>${(s.title || '').length}</td>
          <td>${flags.length ? flags.map((f) => `<span class="crawl-flag">${escapeHtml(f)}</span>`).join(' ') : '<span class="muted">clean</span>'}</td>
        </tr>`;
      }).join('');

    const cappedNote = site.capped ? ` · crawl hit the page cap — raise “Max pages” to go deeper` : '';
    const body = document.getElementById('site-crawl-body');
    body.innerHTML = `
      <div class="crawl-meta muted small">Entry: ${escapeHtml(meta.startUrl)} · ${site.pageCount} audited · ${meta.discovered} discovered · robots.txt ${site.robotsOk ? 'found' : 'not found'}${cappedNote}</div>
      <div class="crawl-issues">${issues || '<p class="muted">No site-wide issues detected across crawled pages. 🎉</p>'}</div>
      ${actions && actions.length ? `<h4 class="crawl-subhead">Site-wide action plan</h4><div class="actions-list">${actions.map(actionCardHtml).join('')}</div>` : ''}
      <h4 class="crawl-subhead">All crawled pages <span class="muted small">(weakest first)</span></h4>
      <div class="rank-table-wrap">
        <table class="rank-table">
          <thead><tr><th>Page</th><th>Score</th><th>Words</th><th>Title ch</th><th>Issues</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>`;
  }

  function hideSiteCrawl() {
    const wrap = document.getElementById('site-crawl-wrap');
    if (wrap) wrap.hidden = true;
  }

  // ── Last-run metadata ──────────────────────────────────────
  function renderLastRunMeta(audit) {
    document.getElementById('last-run-meta').textContent =
      `Last: ${audit.host} · ${audit.composite} (${audit.grade}) · ${new Date(audit.timestamp).toLocaleDateString()}`;
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[m]);
  }

  global.SERPSCOPE = global.SERPSCOPE || {};
  global.SERPSCOPE.renderer = {
    renderHero, renderScorecards, renderCompetitorChart, renderRankTable,
    rankOf, renderAuditGrid, renderActions, applyActionFilter,
    renderSiteCrawl, hideSiteCrawl,
    renderLastRunMeta, escapeHtml,
  };
})(window);
