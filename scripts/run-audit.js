/* Headless audit runner for GitHub Actions cron.
 * Reuses the browser analyzer by emulating window + DOMParser
 * via jsdom. Outputs report.txt and report.json. */

const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch');
const { JSDOM } = require('jsdom');

const target = process.env.TARGET;
const compsList = (process.env.COMPS || '').split(/[,;]\s*/).filter(Boolean).slice(0, 5);
const psiKey = process.env.PSI_KEY || '';

if (!target) { console.error('TARGET env var required'); process.exit(1); }

// Set up a minimal browser-like global so analyzer.js can be loaded.
const { window } = new JSDOM('<!doctype html><html><body></body></html>');
global.window = window;
global.document = window.document;
global.DOMParser = window.DOMParser;
global.performance = { now: () => Date.now() };
global.AbortController = global.AbortController || window.AbortController;
global.fetch = async (url, opts) => fetch(url, opts);

// Load analyzer.js in this global scope
const analyzerCode = fs.readFileSync(path.join(__dirname, '..', 'assets', 'js', 'analyzer.js'), 'utf8');
// Replace its `window` references via Function() shim
const ctx = { window: global, console };
new Function('window', analyzerCode)(global);
const A = global.SERPSCOPE.analyzer;

function normalize(u) {
  if (!u) return null;
  if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
  try { return new URL(u).href; } catch { return null; }
}

(async () => {
  const targets = [normalize(target), ...compsList.map(normalize)].filter(Boolean);
  const results = [];
  for (const u of targets) {
    process.stderr.write(`Auditing ${u} ...\n`);
    try {
      const r = await A.auditSite(u, { proxy: 'allorigins', psiKey, usePsi: true });
      results.push(r);
      process.stderr.write(`  ${r.composite} (${r.grade})\n`);
    } catch (e) {
      process.stderr.write(`  FAIL: ${e.message}\n`);
      results.push(null);
    }
  }
  const main = results[0];
  if (!main) { console.error('Target audit failed'); process.exit(1); }
  const comps = results.slice(1).filter(Boolean);
  const actions = A.generateActions(main);

  const out = { target: main, competitors: comps, actions, generated: new Date().toISOString() };
  fs.writeFileSync('report.json', JSON.stringify(out, null, 2));

  // Text report
  const sorted = [main, ...comps].sort((a, b) => b.composite - a.composite);
  const lines = [];
  lines.push('SERPSCOPE — SEO INTELLIGENCE REPORT');
  lines.push(`Generated ${new Date().toISOString()}`);
  lines.push('─────────────────────────────────────────');
  lines.push(`Target  : ${main.url}`);
  lines.push(`Score   : ${main.composite} (Grade ${main.grade})`);
  lines.push('');
  lines.push('Category breakdown');
  lines.push(`  On-Page    ${main.categories.onpage.score}`);
  lines.push(`  Technical  ${main.categories.technical.score}`);
  lines.push(`  Content    ${main.categories.content.score}`);
  lines.push(`  Off-Page   ${main.categories.offpage.score}`);
  lines.push('');
  lines.push('Competitive set');
  sorted.forEach((s, i) => {
    const self = s.host === main.host ? '*' : ' ';
    lines.push(` ${self} #${i + 1}  ${String(s.composite).padStart(3)}  ${s.host}`);
  });
  lines.push('');
  lines.push('Top priorities');
  actions.slice(0, 12).forEach((a, i) => {
    lines.push(`  ${i + 1}. [${a.priority}] ${a.title}`);
    lines.push(`      ${a.fix}`);
  });
  console.log(lines.join('\n'));
})();
