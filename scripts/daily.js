/* The whole daily refresh in one command: pulls every league in the config, builds the report page
   with automatic coach notes, and writes the email (subject, HTML and plain text).
   node scripts/daily.js --config leagues.json --out-dir <dir> [--page-url https://...]
   Writes <dir>/page.html and prints one line of JSON: {subject, body, failed}. The body is the plain-text email,
   kept short so the scheduled job spends few tokens sending it. */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const FOOTER = '*Move Scores run 1–30; the key is at the bottom of the page. Refreshes every day at 9am Pacific.*';

/* Every scored move in a report, best first: lineup changes, pickups or transfers, and trades worth a look. */
function topMoves(r, n) {
  const moves = r.lineup.changes.map((c) => ({ score: c.score, label: c.label, text: 'Start ' + c.start + (c.bench ? ' over ' + c.bench : '') }))
    .concat(r.pickups.map((m) => ({ score: m.score, label: m.label, text: m.title })))
    .concat(r.trades.filter((m) => m.score >= 10).map((m) => ({ score: m.score, label: m.label, text: m.title + ' (' + m.partner + ')' })));
  return moves.sort((a, b) => b.score - a.score).slice(0, n);
}

function email(reports, failed, pageUrl, day) {
  const text = [];
  reports.forEach(({ label, r }) => {
    text.push(label + ':');
    const moves = topMoves(r, 4);
    moves.forEach((m) => text.push(m.score + '/30 ' + m.label + ': ' + m.text));
    if (!moves.length) text.push('Nothing scores well enough to act on.');
    const out = r.roster.filter((p) => (p.health === 'short' || p.health === 'long') && p.slot !== 'IR').map((p) => p.name);
    if (out.length) text.push('Out: ' + out.join(', '));
    text.push('');
  });
  if (failed.length) text.push('Not loaded: ' + failed.map((f) => f.split(':')[0]).join(', '));
  if (pageUrl) text.push('Full plan: ' + pageUrl);
  return { subject: 'Fantasy Coach: your moves for ' + day, body: text.join('\n') };
}

function main() {
  const config = arg('config', path.join(ROOT, 'leagues.json'));
  const out = arg('out-dir');
  if (!out) throw new Error('--out-dir is required');
  const reportsDir = path.join(out, 'reports'), notesDir = path.join(out, 'notes');
  fs.mkdirSync(notesDir, { recursive: true });

  let log = '';
  try {
    log = execFileSync(process.execPath, [path.join(__dirname, 'snapshot.js'), '--config', config, '--json-dir', reportsDir, '--out', path.join(out, 'page.html')], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    log = (e.stdout || '') + (e.stderr || '');
    if (e.status !== 2) throw new Error('No league loaded:\n' + log); // 2 means some, not all, leagues failed
  }
  const failed = log.split('\n').filter((l) => l.startsWith('FAIL ')).map((l) => l.slice(5));

  const { writeNotes } = require('../server/notes');
  const leagues = JSON.parse(fs.readFileSync(config, 'utf8'));
  const reports = leagues.filter((c) => fs.existsSync(path.join(reportsDir, c.key + '.json')))
    .map((c) => ({ key: c.key, label: c.label || c.key, r: JSON.parse(fs.readFileSync(path.join(reportsDir, c.key + '.json'), 'utf8')) }));
  if (!reports.length) throw new Error('No league loaded:\n' + log);

  // Notes with the daily footer, then rebuild the page with them.
  reports.forEach(({ key, r }) => fs.writeFileSync(path.join(notesDir, key + '.md'), writeNotes(r).replace(/\*Move Scores run[^\n]*\*$/, FOOTER)));
  try {
    execFileSync(process.execPath, [path.join(__dirname, 'snapshot.js'), '--config', config, '--notes-dir', notesDir, '--out', path.join(out, 'page.html')], { stdio: 'ignore' });
  } catch (e) { if (e.status !== 2) throw e; }

  const day = new Date().toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'America/Los_Angeles' });
  const mail = email(reports, failed, arg('page-url'), day);
  console.log(JSON.stringify({ subject: mail.subject, body: mail.body, failed: failed.map((f) => f.split(':')[0]) }));
}

if (require.main === module) {
  try { main(); } catch (e) { console.error(e.message); process.exit(1); }
}
module.exports = { topMoves, email };
