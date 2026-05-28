/* ===========================================================
 * SERPSCOPE — App controller
 * Wires UI events, orchestrates audits, handles settings,
 * persistence, email, scheduling, and exports.
 * =========================================================== */

(function (global) {
  'use strict';

  const SS = global.SERPSCOPE;
  const A = SS.analyzer;
  const R = SS.renderer;
  const C = SS.competitors;
  const CR = SS.crawler;
  const E = SS.email;
  const SCH = SS.scheduler;

  const SETTINGS_KEY = 'serpscope.settings.v1';
  const REPORT_KEY = 'serpscope.lastReport.v1';

  const state = {
    target: null,
    comps: [],
    actions: [],
    site: null,
    running: false,
  };

  // ── Settings ────────────────────────────────────────────────
  function getSettings() {
    try { return JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}'); } catch { return {}; }
  }
  function setSettings(s) { localStorage.setItem(SETTINGS_KEY, JSON.stringify(s)); }

  function loadSettingsIntoUI() {
    const s = getSettings();
    setVal('set-psi-key', s.psiKey);
    setVal('set-moz-token', s.mozToken);
    const compsBox = document.getElementById('set-moz-comps');
    if (compsBox) compsBox.checked = s.mozFetchCompetitors !== false;
    setVal('set-ejs-key', s.ejsKey);
    setVal('set-ejs-service', s.ejsService);
    setVal('set-ejs-tpl', s.ejsTpl);
    setVal('set-ejs-from', s.ejsFrom);
    setVal('set-company', s.company);
    setVal('set-footer', s.footer);
    if (s.company) document.getElementById('footer-company').textContent = s.company;
  }
  function saveSettingsFromUI() {
    const s = {
      psiKey: val('set-psi-key'),
      mozToken: val('set-moz-token'),
      mozFetchCompetitors: document.getElementById('set-moz-comps')?.checked !== false,
      ejsKey: val('set-ejs-key'),
      ejsService: val('set-ejs-service'),
      ejsTpl: val('set-ejs-tpl'),
      ejsFrom: val('set-ejs-from'),
      company: val('set-company'),
      footer: val('set-footer'),
    };
    setSettings(s);
    if (s.company) document.getElementById('footer-company').textContent = s.company;
    toast('Settings saved');
  }

  function val(id) { return document.getElementById(id).value.trim(); }
  function setVal(id, v) { const el = document.getElementById(id); if (el && v) el.value = v; }

  // ── Status & log ────────────────────────────────────────────
  function setStatus(state, text) {
    const dot = document.getElementById('status-dot');
    dot.className = 'status-dot' + (state ? ' ' + state : '');
    if (text != null) document.getElementById('status-text').textContent = text;
  }

  function progress(pct, msg, level = 'busy') {
    document.getElementById('progress-fill').style.width = pct + '%';
    document.getElementById('progress-pct').textContent = Math.round(pct) + '%';
    if (msg) {
      const log = document.getElementById('progress-log');
      const li = document.createElement('li');
      li.className = level;
      li.textContent = msg;
      log.appendChild(li);
      log.scrollTop = log.scrollHeight;
    }
  }

  function resetProgress() {
    document.getElementById('progress-log').innerHTML = '';
    document.getElementById('progress-fill').style.width = '0';
    document.getElementById('progress-pct').textContent = '0%';
  }

  // ── View switching ─────────────────────────────────────────
  function switchView(name) {
    document.querySelectorAll('.view').forEach((v) => v.classList.remove('active'));
    document.querySelectorAll('.nav-link').forEach((b) => b.classList.remove('active'));
    document.getElementById('view-' + name).classList.add('active');
    document.querySelector(`.nav-link[data-view="${name}"]`).classList.add('active');
    if (name === 'schedule') SCH.renderList();
    if (name === 'history' && SS.history) SS.history.renderHistoryView();
  }

  // ── Audit run ───────────────────────────────────────────────
  async function runAudit() {
    if (state.running) return;
    const targetInput = val('target-url');
    if (!targetInput) { toast('Enter a target URL', 'err'); return; }
    const targetUrl = A.normalizeUrl(targetInput);
    if (!targetUrl) { toast('Invalid URL', 'err'); return; }

    const compUrls = Array.from(document.querySelectorAll('.competitor-url'))
      .map((i) => i.value.trim()).filter(Boolean).map((u) => A.normalizeUrl(u)).filter(Boolean).slice(0, 5);

    const settings = getSettings();
    const proxyKey = document.getElementById('cors-proxy').value;
    const perfSource = document.getElementById('perf-source').value;
    const useFinalPsi = perfSource === 'psi';
    const auditDepth = document.getElementById('audit-depth').value;
    const crawlMax = parseInt(document.getElementById('crawl-max').value, 10) || 75;

    state.running = true;
    document.getElementById('run-audit').disabled = true;
    setStatus('busy', 'Running audit');
    document.getElementById('progress-panel').hidden = false;
    document.getElementById('report').hidden = true;
    resetProgress();
    progress(2, `Audit started · target: ${targetUrl}`, 'busy');

    const targets = [{ url: targetUrl, label: 'target' }, ...compUrls.map((u) => ({ url: u, label: 'competitor' }))];
    const total = targets.length;
    const results = [];

    for (let i = 0; i < targets.length; i++) {
      const t = targets[i];
      const base = 2 + (i / total) * 90;
      progress(base, `[${i + 1}/${total}] Fetching ${t.url}`, 'busy');
      try {
        const audit = await A.auditSite(t.url, {
          proxy: proxyKey,
          psiKey: settings.psiKey,
          usePsi: useFinalPsi,
          onProgress: ({ msg }) => progress(base + 1, `   ${msg}`, 'busy'),
        });
        results.push(audit);
        progress(base + (90 / total), `   ✓ ${t.url} scored ${audit.composite} (${audit.grade})`, 'done');
      } catch (e) {
        progress(base + (90 / total), `   ✕ ${t.url} failed: ${e.message}`, 'fail');
        // Push a stub
        results.push(null);
      }
    }

    progress(95, 'Generating action plan', 'busy');
    const target = results[0];
    if (!target) {
      setStatus('err', 'Target failed');
      document.getElementById('run-audit').disabled = false;
      state.running = false;
      toast('Target audit failed — try a different CORS proxy in Advanced.', 'err');
      return;
    }
    const comps = results.slice(1).filter(Boolean);
    const actions = A.generateActions(target);
    target._actions = actions; // so history snapshot stores action counts

    // Batch Moz for competitors (cached by host, 7-day TTL)
    if (settings.mozToken && settings.mozFetchCompetitors !== false && SS.moz?.hasToken?.() && comps.length) {
      progress(96, 'Fetching competitor Domain Authority', 'busy');
      try {
        const compMoz = await SS.moz.batchLookup(comps.map((c) => c.url), { rich: false });
        comps.forEach((c, i) => { if (compMoz[i]) c.moz = compMoz[i]; });
      } catch (e) {
        progress(97, '   Moz batch failed: ' + e.message, 'warn');
      }
    }

    state.target = target;
    state.comps = comps;
    state.actions = actions;
    state.site = null;

    // Full-site crawl: discover every page (sitemap-first, then internal
    // links) and audit each so the analysis covers the whole property.
    if (auditDepth === 'deep' && CR) {
      progress(92, `Crawling site (up to ${crawlMax} pages)…`, 'busy');
      try {
        const crawl = await CR.crawlSite(target.url, {
          proxy: proxyKey,
          maxPages: crawlMax,
          seedAudit: target, // reuse the homepage audit we already ran
          onProgress: ({ msg, level }) => progress(96, msg, level || 'busy'),
        });
        const site = CR.analyzeSiteWide(crawl);
        const siteActions = CR.generateSiteActions(site);
        state.site = {
          site, actions: siteActions,
          meta: { startUrl: crawl.startUrl, sitemapCount: crawl.sitemapCount, discovered: crawl.discovered },
        };
        progress(99, `   ✓ crawled ${site.pageCount} page(s) · avg score ${site.avgComposite} · ${siteActions.length} site-wide actions`, 'done');
      } catch (e) {
        progress(99, '   site crawl failed: ' + e.message, 'warn');
      }
    }

    // Persist last report (legacy localStorage cache for instant resume)
    try {
      localStorage.setItem(REPORT_KEY, JSON.stringify({
        target: stripForStorage(target),
        comps: comps.map(stripForStorage),
        actions,
        ts: Date.now(),
      }));
    } catch {}

    // Persist to IndexedDB history (this is what trends are built from)
    if (SS.history) {
      try { await SS.history.saveAudit(target); } catch (e) { console.warn('history save failed', e); }
    }

    progress(100, 'Rendering report', 'done');
    renderReport();
    document.getElementById('report').hidden = false;
    document.getElementById('progress-panel').hidden = true;
    setStatus('', `Done · ${target.composite}/${100}`);
    state.running = false;
    document.getElementById('run-audit').disabled = false;
    R.renderLastRunMeta(target);
  }

  function stripForStorage(audit) {
    // Drop big body text from storage
    const a = JSON.parse(JSON.stringify(audit));
    if (a.signals) a.signals.bodyText = (a.signals.bodyText || '').slice(0, 400);
    return a;
  }

  function renderReport() {
    const { target, comps, actions } = state;
    const rank = R.rankOf(target, comps);
    R.renderHero(target, rank, actions);
    R.renderScorecards(target);
    R.renderCompetitorChart(target, comps, 'radar');
    R.renderRankTable(target, comps);

    // Lighthouse / performance deep-dive
    const P = SS.perf;
    if (P && target.lighthouse) {
      P.renderLighthouseScores(target, 'mobile');
      P.renderCWV(target, 'mobile');
      P.renderFilmstrip(target, 'mobile');
      P.renderPerfBreakdown(target, 'mobile');
      P.renderMobileCompat(target);
      P.bindDeviceToggle(target);
    } else if (P) {
      // No Lighthouse data — still render mobile compat from client signals
      P.renderMobileCompat(target);
    }

    // Detailed blockers
    if (P && target.blockers?.length) {
      P.renderBlockers(target.blockers);
    } else if (P) {
      P.renderBlockers([]);
    }

    const groups = A.buildAuditItems(target);
    R.renderAuditGrid('onpage-grid', groups.onpage);
    R.renderAuditGrid('tech-grid', groups.technical);
    R.renderAuditGrid('content-grid', groups.content);
    R.renderAuditGrid('offpage-grid', groups.offpage);
    R.renderAuditGrid('a11y-grid', groups.a11y);
    R.renderActions(actions);

    // Whole-site crawl (only present after a full-site audit)
    if (state.site && R.renderSiteCrawl) R.renderSiteCrawl(state.site.site, state.site.actions, state.site.meta);
    else if (R.hideSiteCrawl) R.hideSiteCrawl();

    // Trend sparklines for this host (built from IndexedDB)
    if (SS.history) {
      SS.history.renderInlineTrend(target).catch(() => {});
    }

    // Moz backlink authority panel (hidden if no token / no data)
    if (SS.moz) {
      const compsMoz = comps.map((c) => c.moz).filter(Boolean);
      SS.moz.renderPanel(target.moz, compsMoz);
    }

    document.getElementById('report').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  // Load a historical audit snapshot into the dashboard view.
  function loadAudit(audit) {
    if (!audit) return;
    state.target = audit;
    state.comps = audit._comps || [];
    state.actions = A.generateActions(audit);
    state.site = null; // historical snapshots don't carry crawl data
    switchView('dashboard');
    renderReport();
    document.getElementById('report').hidden = false;
    document.getElementById('progress-panel').hidden = true;
  }

  function loadLastReport() {
    try {
      const raw = localStorage.getItem(REPORT_KEY);
      if (!raw) return;
      const r = JSON.parse(raw);
      if (!r?.target) return;
      state.target = r.target;
      state.comps = r.comps || [];
      state.actions = r.actions || [];
      R.renderLastRunMeta(r.target);
      // Don't auto-render the report on load; just show metadata.
    } catch {}
  }

  // ── Competitor auto-discover ────────────────────────────────
  async function discover() {
    const targetInput = val('target-url');
    const kw = val('industry-kw');
    if (!targetInput) { toast('Enter target URL first', 'err'); return; }
    const targetUrl = A.normalizeUrl(targetInput);
    setStatus('busy', 'Discovering competitors');
    const btn = document.getElementById('btn-discover');
    btn.disabled = true;
    btn.textContent = 'Searching…';
    try {
      const proxyKey = document.getElementById('cors-proxy').value;
      const found = await C.discoverCompetitors(targetUrl, kw, proxyKey);
      const inputs = document.querySelectorAll('.competitor-url');
      inputs.forEach((inp) => (inp.value = ''));
      found.slice(0, 5).forEach((h, i) => { if (inputs[i]) inputs[i].value = h; });
      if (!found.length) toast('No competitors found — add manually', 'err');
      else toast(`Found ${found.length} candidate competitors`);
    } catch (e) {
      toast('Discovery failed: ' + e.message, 'err');
    } finally {
      setStatus('', 'Ready');
      btn.disabled = false;
      btn.innerHTML = `<svg viewBox="0 0 24 24" width="14" height="14"><circle cx="11" cy="11" r="7" stroke="currentColor" stroke-width="2" fill="none"/><path d="M20 20l-3-3" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg> Auto-discover`;
    }
  }

  // ── Exports ────────────────────────────────────────────────
  function exportJSON() {
    if (!state.target) return;
    const data = {
      target: state.target,
      competitors: state.comps,
      actions: state.actions,
      generated: new Date().toISOString(),
    };
    downloadBlob(JSON.stringify(data, null, 2), `serpscope-${state.target.host}-${Date.now()}.json`, 'application/json');
  }

  function exportCSV() {
    if (!state.target) return;
    const rows = [['Domain', 'Composite', 'Grade', 'On-Page', 'Technical', 'Content', 'Off-Page']];
    [state.target, ...state.comps].forEach((s) => {
      rows.push([s.host, s.composite, s.grade,
        s.categories.onpage.score, s.categories.technical.score,
        s.categories.content.score, s.categories.offpage.score]);
    });
    rows.push([]);
    rows.push(['Priority', 'Category', 'Title', 'Fix', 'Effort', 'Impact']);
    state.actions.forEach((a) => rows.push([a.priority, a.category, a.title, a.fix, a.effort, a.impact]));
    const csv = rows.map((r) => r.map(csvCell).join(',')).join('\n');
    downloadBlob(csv, `serpscope-${state.target.host}-${Date.now()}.csv`, 'text/csv');
  }

  function csvCell(v) {
    const s = String(v ?? '');
    if (/[,"\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
    return s;
  }

  function downloadBlob(content, name, type) {
    const blob = new Blob([content], { type });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
  }

  // ── Email modal ────────────────────────────────────────────
  function openEmailModal() {
    if (!state.target) { toast('Run an audit first', 'err'); return; }
    const m = E.buildReportEmail(state.target, state.comps, state.actions, { attachJson: true });
    document.getElementById('email-subject').value = m.subject;
    document.getElementById('email-message').value = m.message;
    document.getElementById('email-status').textContent = '';
    document.getElementById('email-status').className = 'email-status';
    document.getElementById('email-modal').hidden = false;
  }

  async function sendEmailFromModal() {
    const to = val('email-to');
    if (!to) { toast('Enter at least one recipient', 'err'); return; }
    const subject = document.getElementById('email-subject').value;
    let message = document.getElementById('email-message').value;
    if (!document.getElementById('email-attach-json').checked) {
      // Strip raw JSON block
      message = message.replace(/─{20,}[\s\S]*RAW AUDIT DATA[\s\S]*$/m, '').trimEnd();
    }
    const status = document.getElementById('email-status');
    status.textContent = 'Sending…'; status.className = 'email-status';
    try {
      const recipients = to.split(/[,;]\s*/).filter(Boolean);
      for (const r of recipients) {
        await E.sendEmail({ to: r, subject, message });
      }
      status.textContent = `Sent to ${recipients.length} recipient(s)`;
      status.className = 'email-status ok';
      setTimeout(() => { document.getElementById('email-modal').hidden = true; }, 1200);
    } catch (e) {
      status.textContent = 'Failed: ' + e.message;
      status.className = 'email-status err';
    }
  }

  // ── Schedule actions ────────────────────────────────────────
  function saveSchedule() {
    const s = {
      name: val('sch-name'),
      url: A.normalizeUrl(val('sch-url')),
      freq: document.getElementById('sch-freq').value,
      time: val('sch-time') || '09:00',
      emails: val('sch-emails').split(/[,;]\s*/).filter(Boolean),
      comps: val('sch-comps').split(/[,;]\s*/).filter(Boolean),
    };
    if (!s.name || !s.url) { toast('Name and URL required', 'err'); return; }
    SCH.add(s);
    SCH.renderList();
    toast('Schedule saved');
  }

  async function sendTestEmail() {
    const emails = val('sch-emails').split(/[,;]\s*/).filter(Boolean);
    if (!emails.length) { toast('Add a recipient email', 'err'); return; }
    if (!state.target) { toast('Run at least one audit first', 'err'); return; }
    try {
      const m = E.buildReportEmail(state.target, state.comps, state.actions, { attachJson: false });
      for (const r of emails) await E.sendEmail({ to: r, subject: '[TEST] ' + m.subject, message: m.message });
      toast(`Test email sent to ${emails.length}`);
    } catch (e) { toast('Email failed: ' + e.message, 'err'); }
  }

  async function checkDueSchedules() {
    const due = SCH.listDue();
    if (!due.length) return;
    for (const s of due) {
      try {
        document.getElementById('target-url').value = s.url;
        document.querySelectorAll('.competitor-url').forEach((i, ix) => { i.value = s.comps[ix] || ''; });
        await runAudit();
        if (s.emails?.length && state.target) {
          const m = E.buildReportEmail(state.target, state.comps, state.actions, { attachJson: true });
          for (const r of s.emails) await E.sendEmail({ to: r, subject: m.subject, message: m.message });
        }
        SCH.update(s.id, { lastStatus: 'OK', lastRun: Date.now() });
      } catch (e) {
        SCH.update(s.id, { lastStatus: 'FAIL: ' + e.message });
      } finally {
        SCH.reschedule(s.id);
      }
    }
  }

  // ── Toast ───────────────────────────────────────────────────
  function toast(msg, kind) {
    const el = document.getElementById('toast');
    el.textContent = msg;
    el.className = 'toast' + (kind === 'err' ? ' err' : '');
    el.hidden = false;
    clearTimeout(toast._t);
    toast._t = setTimeout(() => { el.hidden = true; }, 3000);
  }

  // ── Wire up ─────────────────────────────────────────────────
  function init() {
    // Nav
    document.querySelectorAll('.nav-link').forEach((b) => {
      b.addEventListener('click', () => switchView(b.dataset.view));
    });

    // Run audit
    document.getElementById('run-audit').addEventListener('click', runAudit);
    document.getElementById('target-url').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') runAudit();
    });

    // Competitor controls
    document.getElementById('btn-discover').addEventListener('click', discover);
    document.getElementById('btn-clear-comp').addEventListener('click', () => {
      document.querySelectorAll('.competitor-url').forEach((i) => (i.value = ''));
    });

    // Report toolbar
    document.getElementById('btn-export-json').addEventListener('click', exportJSON);
    document.getElementById('btn-export-csv').addEventListener('click', exportCSV);
    document.getElementById('btn-print').addEventListener('click', () => window.print());
    document.getElementById('btn-email').addEventListener('click', openEmailModal);

    // Email modal
    document.getElementById('email-close').addEventListener('click', () => { document.getElementById('email-modal').hidden = true; });
    document.getElementById('email-cancel').addEventListener('click', () => { document.getElementById('email-modal').hidden = true; });
    document.getElementById('email-send').addEventListener('click', sendEmailFromModal);

    // Action filters
    document.querySelectorAll('.actions-toolbar .filter-pill').forEach((b) => {
      b.addEventListener('click', () => {
        document.querySelectorAll('.actions-toolbar .filter-pill').forEach((x) => x.classList.remove('active'));
        b.classList.add('active');
        R.applyActionFilter(b.dataset.filter);
      });
    });

    // Blocker filters — grouped (severity, category, device) so each group is independent
    ['Sev', 'Cat', 'Device'].forEach((kind) => {
      const attr = `data-blocker-${kind.toLowerCase()}`;
      document.querySelectorAll(`[${attr}]`).forEach((b) => {
        b.addEventListener('click', () => {
          document.querySelectorAll(`[${attr}]`).forEach((x) => x.classList.remove('active'));
          b.classList.add('active');
          SS.perf?.setBlockerFilter(kind.toLowerCase() === 'device' ? 'device' : (kind === 'Sev' ? 'sev' : 'cat'),
            b.getAttribute(attr));
        });
      });
    });

    // Chart tabs
    document.querySelectorAll('.tabs .tab').forEach((t) => {
      t.addEventListener('click', () => {
        document.querySelectorAll('.tabs .tab').forEach((x) => x.classList.remove('active'));
        t.classList.add('active');
        if (state.target) R.renderCompetitorChart(state.target, state.comps, t.dataset.chart);
      });
    });

    // Settings
    document.getElementById('btn-save-settings').addEventListener('click', saveSettingsFromUI);
    document.getElementById('btn-reset-settings').addEventListener('click', () => {
      if (confirm('Reset all settings?')) { localStorage.removeItem(SETTINGS_KEY); loadSettingsIntoUI(); toast('Settings reset'); }
    });

    // Schedule
    document.getElementById('btn-save-schedule').addEventListener('click', saveSchedule);
    document.getElementById('btn-test-schedule').addEventListener('click', sendTestEmail);

    // Load persisted bits
    loadSettingsIntoUI();
    loadLastReport();

    // Periodically check schedules (every 5 min); also on load.
    setTimeout(checkDueSchedules, 5000);
    setInterval(checkDueSchedules, 5 * 60 * 1000);

    // Tip
    setStatus('', 'Ready');
  }

  // expose
  global.SERPSCOPE = global.SERPSCOPE || {};
  global.SERPSCOPE.app = { getSettings, toast, loadAudit };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else { init(); }
})(window);
