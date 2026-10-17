/* Builds a standalone report page (no server needed) from a live league.
   node scripts/snapshot.js --platform sleeper --username JoePizza45 [--league ID] [--team ID] [--notes notes.md] --out report.html
   Also: --platform fpl --entry ID [--league ID]; --platform espn --league ID [--sport nba] [--season 2026]. */
const fs = require('fs');
const path = require('path');
const sleeper = require('../server/connectors/sleeper');
const espn = require('../server/connectors/espn');
const fpl = require('../server/connectors/fpl');
const { analyze } = require('../server/analyze');

const ROOT = path.join(__dirname, '..');
const arg = (k) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : undefined; };

async function load() {
  const platform = arg('platform') || 'sleeper', sport = arg('sport') || 'nfl';
  if (platform === 'sleeper') {
    let leagueId = arg('league');
    if (!leagueId) {
      const l = await sleeper.listLeagues(arg('username'), sport);
      if (!l.leagues.length) throw new Error('No ' + sport + ' leagues for ' + arg('username'));
      leagueId = l.leagues[0].id;
    }
    return sleeper.load({ leagueId, username: arg('username'), rosterId: arg('team') });
  }
  if (platform === 'espn') return espn.load({ leagueId: arg('league'), sport, season: arg('season'), teamId: arg('team'), espnS2: process.env.ESPN_S2, swid: process.env.ESPN_SWID });
  if (platform === 'fpl') return fpl.load({ entryId: arg('entry'), leagueId: arg('league') });
  throw new Error('Unknown platform ' + platform);
}

/* Reuses coach.html's styles and rendering, with the report baked in and the connect form removed. */
function page(report, notes) {
  const src = fs.readFileSync(path.join(ROOT, 'coach.html'), 'utf8');
  const style = src.match(/<style>([\s\S]*?)<\/style>/)[1];
  const fonts = src.match(/<link rel="preconnect"[\s\S]*?display=swap">/)[0];
  const script = src.match(/<script>([\s\S]*?)<\/script>/)[1]
    .replace(/if \(location\.protocol === 'file:'\)[^\n]*\n/, '')
    .replace("const h = ['<div class=\"sec-h\">AI coach</div>'];", "const h = ['<div class=\"sec-h\">Coach notes</div>'];");
  const json = (v) => JSON.stringify(v).replace(/</g, '\\u003c');
  const when = new Date(report.generatedAt).toUTCString().replace(/:\d\d GMT$/, ' UTC');
  return `<title>${report.me.name.replace(/[<&]/g, '')} Game Plan</title>
<meta name="claude:viewport-fit-sides" content="cover">
${fonts}
<style>${style}
.askrow{display:none}${notes ? '' : '\n#coach{display:none}'}
</style>
<div class="wrap">
  <header class="top">
    <div><h1>League Coach</h1><p class="sub">${report.league.name.replace(/[<&]/g, '')} · stats through ${report.league.statsThrough} · updated ${when}</p></div>
  </header>
  <section id="connect" hidden></section>
  <div id="report" class="wrap" style="max-width:none"></div>
</div>
<script>
const REPORT = ${json(report)};
const NOTES = ${json(notes || '')};
${script}
st.report = REPORT; st.chat = NOTES ? [{ role: 'assistant', content: NOTES }] : [];
renderReport();
</script>
`;
}

async function main() {
  const out = arg('out');
  if (!out) throw new Error('--out is required');
  const report = analyze(await load(), { teamId: arg('team') });
  report.generatedAt = new Date().toISOString();
  const notesFile = arg('notes');
  const notes = notesFile && fs.existsSync(notesFile) ? fs.readFileSync(notesFile, 'utf8') : '';
  fs.writeFileSync(out, page(report, notes));
  if (arg('json')) fs.writeFileSync(arg('json'), JSON.stringify(report, null, 1));
  console.log('Wrote ' + out + ' for ' + report.me.name + ' (' + report.league.name.trim() + ', stats through ' + report.league.statsThrough + ')');
}

if (require.main === module) main().catch((e) => { console.error(e.message); process.exit(1); });
module.exports = { page };
