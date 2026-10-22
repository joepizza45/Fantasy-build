/* Browser entry for the Fantasy Coach web app: the same connectors and analysis as the server,
   run in the visitor's browser. Sleeper and public ESPN leagues allow this; FPL and private ESPN
   leagues need the self-hosted server. */
const api = require('../server/api');
const players = require('../server/lib/players');

const DATA = {};
async function prefetchData() {
  await Promise.all(['nfl', 'nba', 'fpl'].map((k) => (k in DATA ? null : fetch('data/' + k + '.json')
    .then((r) => (r.ok ? r.json() : null)).catch(() => null).then((j) => { DATA[k] = j; }))));
  players.setDataLoader((sport) => DATA[sport] || null);
}

function browserOnly(b) {
  if (b.platform === 'fpl') throw new Error('Fantasy Premier League blocks requests from web pages. Use a Sleeper Premier League league here, or run the self-hosted version for FPL.');
  if (b.platform === 'espn' && (b.espnS2 || b.swid)) throw new Error('Private ESPN leagues need the self-hosted version. Ask your league manager to make the league viewable to the public, or leave the cookie fields empty for a public league.');
}

window.FantasyCoach = {
  async leagues(b) { browserOnly(b); return api.leagues(b); },
  async analyze(b) {
    browserOnly(b);
    await prefetchData();
    try { return await api.analyzeLeague(b); } catch (e) {
      if (b.platform === 'espn' && e.status === 401) e.message = 'This ESPN league is private. Ask your league manager to turn on "Make League Viewable to Public", then try again.';
      throw e;
    }
  }
};
