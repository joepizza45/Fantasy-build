/* The two calls every Fantasy Coach front end makes: find a user's leagues, and analyze one league.
   Shared by the Node server and the browser build. */
const sleeper = require('./connectors/sleeper');
const espn = require('./connectors/espn');
const fpl = require('./connectors/fpl');
const { analyze } = require('./analyze');
const { writeNotes } = require('./notes');

const need = (v, what) => { if (!v || !String(v).trim()) throw Object.assign(new Error(what + ' is required'), { status: 400 }); return String(v).trim(); };
const sleeperSport = (s) => (['nba', 'epl'].indexOf(s) >= 0 ? s : 'nfl');

async function leagues(b) {
  if (b.platform === 'sleeper') return sleeper.listLeagues(need(b.username, 'Sleeper username'), sleeperSport(b.sport));
  if (b.platform === 'fpl') return fpl.listLeagues(need(b.entryId, 'FPL team ID'));
  throw Object.assign(new Error('League lookup works for Sleeper and FPL. For ESPN, enter the league ID from the league URL.'), { status: 400 });
}

async function loadLeague(b) {
  if (b.platform === 'sleeper') return sleeper.load({ leagueId: need(b.leagueId, 'League'), username: b.username, rosterId: b.teamId });
  if (b.platform === 'espn') return espn.load({ leagueId: need(b.leagueId, 'ESPN league ID'), sport: b.sport === 'nba' ? 'nba' : 'nfl', season: b.season, teamId: b.teamId, espnS2: b.espnS2, swid: b.swid });
  if (b.platform === 'fpl') return fpl.load({ entryId: need(b.entryId, 'FPL team ID'), leagueId: b.leagueId });
  throw Object.assign(new Error('Unknown platform ' + b.platform), { status: 400 });
}

async function analyzeLeague(b) {
  const t0 = Date.now();
  const report = analyze(await loadLeague(b), { teamId: b.teamId });
  report.generatedAt = new Date().toISOString();
  report.autoNotes = writeNotes(report);
  report.ms = Date.now() - t0;
  return report;
}

module.exports = { leagues, loadLeague, analyzeLeague, need };
