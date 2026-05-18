/* ===========================================================
 * Scheduler — browser-side recurring audits.
 * Stores schedules in localStorage. On dashboard load, checks
 * for due schedules and runs them. For true server-side cron,
 * see .github/workflows/scheduled-audit.yml.
 * =========================================================== */

(function (global) {
  'use strict';

  const KEY = 'serpscope.schedules.v1';

  function load() {
    try { return JSON.parse(localStorage.getItem(KEY) || '[]'); } catch { return []; }
  }
  function save(list) { localStorage.setItem(KEY, JSON.stringify(list)); }

  function add(s) {
    const list = load();
    s.id = 's_' + Math.random().toString(36).slice(2, 10);
    s.created = Date.now();
    s.nextRun = computeNext(s);
    s.lastRun = null;
    s.lastStatus = null;
    list.push(s);
    save(list);
    return s;
  }

  function remove(id) { save(load().filter((s) => s.id !== id)); }

  function update(id, patch) {
    const list = load();
    const i = list.findIndex((s) => s.id === id);
    if (i >= 0) { list[i] = { ...list[i], ...patch }; save(list); }
  }

  function computeNext(s, from = Date.now()) {
    const d = new Date(from);
    const [hh, mm] = (s.time || '09:00').split(':').map(Number);
    d.setHours(hh, mm, 0, 0);
    if (d.getTime() <= from) {
      // bump
      switch (s.freq) {
        case 'daily': d.setDate(d.getDate() + 1); break;
        case 'weekly': d.setDate(d.getDate() + 7); break;
        case 'biweekly': d.setDate(d.getDate() + 14); break;
        case 'monthly': d.setMonth(d.getMonth() + 1); break;
        default: d.setDate(d.getDate() + 7);
      }
    }
    return d.getTime();
  }

  function listDue(now = Date.now()) {
    return load().filter((s) => s.nextRun && s.nextRun <= now);
  }

  function reschedule(id) {
    const list = load();
    const i = list.findIndex((s) => s.id === id);
    if (i >= 0) {
      list[i].lastRun = Date.now();
      list[i].nextRun = computeNext(list[i], Date.now() + 1000);
      save(list);
    }
  }

  function renderList() {
    const tbody = document.getElementById('schedules-tbody');
    const list = load();
    if (!list.length) {
      tbody.innerHTML = '<tr><td colspan="6" class="muted center">No schedules configured.</td></tr>';
      return;
    }
    tbody.innerHTML = '';
    list.forEach((s) => {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${escape(s.name)}</td>
        <td class="domain">${escape(s.url)}</td>
        <td>${escape(s.freq)} @ ${escape(s.time)}</td>
        <td>${s.nextRun ? new Date(s.nextRun).toLocaleString() : '—'}</td>
        <td>${escape(s.lastStatus || '—')}</td>
        <td><button class="btn small" data-del="${s.id}">Delete</button></td>
      `;
      tbody.appendChild(tr);
    });
    tbody.querySelectorAll('[data-del]').forEach((b) => {
      b.addEventListener('click', () => { remove(b.dataset.del); renderList(); });
    });
  }

  function escape(s) {
    return String(s ?? '').replace(/[&<>"']/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[m]);
  }

  global.SERPSCOPE = global.SERPSCOPE || {};
  global.SERPSCOPE.scheduler = { add, remove, update, load, save, listDue, reschedule, renderList, computeNext };
})(window);
