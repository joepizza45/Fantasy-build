/* Builds a standalone report page (no server needed) from live leagues, one tab per league.
   node scripts/snapshot.js --config leagues.json [--notes-dir notes/] [--json-dir out/] --out report.html
   node scripts/snapshot.js --platform sleeper --username JoePizza45 [--sport epl] [--league ID] [--notes notes.md] --out report.html
   Config entries: { key, label, platform, sport, username, league, team, entry, season }.
   ESPN private leagues read cookies from ESPN_S2 and ESPN_SWID. */
const fs = require('fs');
const path = require('path');
const sleeper = require('../server/connectors/sleeper');
const espn = require('../server/connectors/espn');
const fpl = require('../server/connectors/fpl');
const { analyze } = require('../server/analyze');

const ROOT = path.join(__dirname, '..');
const arg = (k) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : undefined; };

async function load(c) {
  const sport = c.sport || 'nfl';
  if (c.platform === 'sleeper') {
    let leagueId = c.league;
    if (!leagueId) {
      const l = await sleeper.listLeagues(c.username, sport);
      if (!l.leagues.length) throw new Error('No ' + sport + ' leagues for ' + c.username);
      leagueId = l.leagues[0].id;
    }
    return sleeper.load({ leagueId, username: c.username, rosterId: c.team });
  }
  if (c.platform === 'espn') return espn.load({ leagueId: c.league, sport, season: c.season, teamId: c.team, espnS2: process.env.ESPN_S2, swid: process.env.ESPN_SWID });
  if (c.platform === 'fpl') return fpl.load({ entryId: c.entry, leagueId: c.league });
  throw new Error('Unknown platform ' + c.platform);
}

const clean = (s) => String(s).replace(/[<&]/g, '').trim();

/* Reuses coach.html's styles and rendering, with the reports baked in and the connect form removed. */
function page(tabs) {
  const src = fs.readFileSync(path.join(ROOT, 'coach.html'), 'utf8');
  const style = src.match(/<style>([\s\S]*?)<\/style>/)[1];
  const fonts = src.match(/<link rel="preconnect"[\s\S]*?display=swap">/)[0];
  const script = src.match(/<script>([\s\S]*?)<\/script>/)[1]
    .replace(/if \(location\.protocol === 'file:'\)[^\n]*\n/, '')
    .replace("const h = ['<div class=\"sec-h\">AI coach</div>'];", "const h = ['<div class=\"sec-h\">Coach notes</div>'];");
  const json = (v) => JSON.stringify(v).replace(/</g, '\\u003c');
  const owner = tabs[0].report.me.name;
  return `<title>${tabs.length > 1 ? clean(tabs[0].report.me.owner || owner) + ' League Coach' : clean(owner) + ' Game Plan'}</title>
<meta name="claude:viewport-fit-sides" content="cover">
${fonts}
<style>${style}
.askrow{display:none}
.tabs{display:flex;gap:6px;flex-wrap:wrap}
.tabs button{border:1px solid var(--line);background:var(--surface);border-radius:999px;padding:7px 14px;cursor:pointer;font-weight:600;color:var(--mute)}
.tabs button[aria-selected="true"]{background:var(--accent);border-color:var(--accent);color:var(--on-accent)}
</style>
<div class="wrap">
  <header class="top">
    <div><h1>League Coach</h1><p class="sub" id="sub"></p></div>
  </header>
  <nav class="tabs" role="tablist" aria-label="Leagues" id="tabs"${tabs.length > 1 ? '' : ' hidden'}></nav>
  <section id="connect" hidden></section>
  <div id="report" class="wrap" style="max-width:none"></div>
</div>
<script>
const TABS = ${json(tabs.map((t) => ({ key: t.key, label: t.label, report: t.report, notes: t.notes || '' })))};
${script}
function showTab(key) {
  const t = TABS.find((x) => x.key === key) || TABS[0];
  st.report = t.report; st.chat = t.notes ? [{ role: 'assistant', content: t.notes }] : [];
  document.body.dataset.sport = t.report.league.sport;
  const when = new Date(t.report.generatedAt).toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  $('sub').textContent = t.report.league.name.trim() + ' · stats through ' + t.report.league.statsThrough + ' · updated ' + when;
  $('tabs').innerHTML = TABS.map((x) => '<button role="tab" data-tab="' + esc(x.key) + '" aria-selected="' + (x === t) + '">' + esc(x.label) + '</button>').join('');
  renderReport();
  $('coach').hidden = !t.notes;
  try { localStorage.setItem('leaguecoach-tab', t.key); } catch (e) {}
}
$('tabs').addEventListener('click', (e) => { const b = e.target.closest('button[data-tab]'); if (b) showTab(b.dataset.tab); });
let first = location.hash.slice(1);
if (!TABS.some((x) => x.key === first)) { try { first = localStorage.getItem('leaguecoach-tab'); } catch (e) { first = null; } }
showTab(first);
</script>
`;
}

async function main() {
  const out = arg('out');
  if (!out) throw new Error('--out is required');
  const cfg = arg('config')
    ? JSON.parse(fs.readFileSync(arg('config'), 'utf8'))
    : [{ key: arg('sport') || 'league', label: arg('label') || '', platform: arg('platform') || 'sleeper', sport: arg('sport'), username: arg('username'), league: arg('league'), team: arg('team'), entry: arg('entry'), season: arg('season'), notesFile: arg('notes') }];
  const tabs = [];
  for (const c of cfg) {
    try {
      const report = analyze(await load(c), { teamId: c.team });
      report.generatedAt = new Date().toISOString();
      const nf = c.notesFile || (arg('notes-dir') && path.join(arg('notes-dir'), c.key + '.md'));
      const notes = nf && fs.existsSync(nf) ? fs.readFileSync(nf, 'utf8') : '';
      if (arg('json-dir')) { fs.mkdirSync(arg('json-dir'), { recursive: true }); fs.writeFileSync(path.join(arg('json-dir'), c.key + '.json'), JSON.stringify(report, null, 1)); }
      tabs.push({ key: c.key, label: c.label || report.league.sportName, report, notes });
      console.log('OK   ' + c.key + ': ' + report.me.name + ' in ' + report.league.name.trim() + ', stats through ' + report.league.statsThrough + (notes ? ', with notes' : ''));
    } catch (e) {
      console.error('FAIL ' + c.key + ': ' + e.message);
    }
  }
  if (!tabs.length) throw new Error('No league loaded, page not written');
  fs.writeFileSync(out, page(tabs));
  console.log('Wrote ' + out + ' with ' + tabs.length + ' of ' + cfg.length + ' leagues');
  if (tabs.length < cfg.length) process.exitCode = 2;
}

if (require.main === module) main().catch((e) => { console.error(e.message); process.exit(1); });
module.exports = { page };
