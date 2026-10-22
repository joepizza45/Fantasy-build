/* Fantasy Coach web bundle. Built by scripts/build-web.js; edit the sources, not this file. */
(function () {
var defs = {
"web/entry.js": function (module, exports, __require, __builtin, __dirname) {
/* Browser entry for the Fantasy Coach web app: the same connectors and analysis as the server,
   run in the visitor's browser. Sleeper and public ESPN leagues allow this; FPL and private ESPN
   leagues need the self-hosted server. */
const api = __require("server/api.js");
const players = __require("server/lib/players.js");

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

},
"server/api.js": function (module, exports, __require, __builtin, __dirname) {
/* The two calls every Fantasy Coach front end makes: find a user's leagues, and analyze one league.
   Shared by the Node server and the browser build. */
const sleeper = __require("server/connectors/sleeper.js");
const espn = __require("server/connectors/espn.js");
const fpl = __require("server/connectors/fpl.js");
const { analyze } = __require("server/analyze.js");
const { writeNotes } = __require("server/notes.js");

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

},
"server/connectors/sleeper.js": function (module, exports, __require, __builtin, __dirname) {
/* Sleeper (NFL and NBA). Public read-only API, no login: https://docs.sleeper.com */
const { getJSON, FetchError } = __require("server/lib/fetch.js");
const { averages, fillFromData, healthFrom, makePlayer } = __require("server/lib/players.js");
const { SPORTS } = __require("engine.js");
const { byeWeeks } = __require("server/lib/nfl.js");

const B = 'https://api.sleeper.app/v1';
const HOUR = 3600 * 1000;
const SEASON_WEEKS = { nfl: 18, nba: 25, epl: 38 };
const API_SPORT = { nfl: 'nfl', nba: 'nba', epl: 'clubsoccer:epl' };
const EPL_POS = { GK: 'GKP', D: 'DEF', M: 'MID', F: 'FWD' };
const SKILL = ['RB', 'WR', 'TE'];
const BENCH_SLOTS = ['BN', 'IR', 'TAXI'];

const toPos = (sport, raw) => {
  let p = String(raw || '').toUpperCase();
  if (sport === 'nfl' && p === 'DEF') p = 'DST';
  if (sport === 'epl') p = EPL_POS[p] || '';
  return SPORTS[sport].positions.indexOf(p) >= 0 ? p : null;
};

async function findUser(username) {
  username = String(username).trim().replace(/^@/, '');
  const u = await getJSON(B + '/user/' + encodeURIComponent(username), { ttl: HOUR });
  if (!u || !u.user_id) throw new FetchError('No Sleeper user called "' + username + '"', 404);
  return u;
}

async function listLeagues(username, sport) {
  const u = await findUser(username);
  const st = await getJSON(B + '/state/' + API_SPORT[sport], { ttl: 10 * 60 * 1000 });
  const season = st.league_season || st.season;
  let leagues = await getJSON(B + '/user/' + u.user_id + '/leagues/' + API_SPORT[sport] + '/' + season, { ttl: 10 * 60 * 1000 });
  if (!leagues || !leagues.length) leagues = await getJSON(B + '/user/' + u.user_id + '/leagues/' + API_SPORT[sport] + '/' + st.previous_season, { ttl: HOUR });
  return {
    user: { id: u.user_id, name: u.display_name },
    leagues: (leagues || []).map((l) => ({ id: l.league_id, name: l.name, season: l.season, teams: l.total_rosters, status: l.status }))
  };
}

/* Fantasy points for one stat line under this league's scoring. Falls back to Sleeper's own totals. */
function points(stats, scoring, sport) {
  let pts = 0;
  for (const k in scoring) if (typeof stats[k] === 'number') pts += stats[k] * scoring[k];
  if (pts === 0 && sport === 'nfl') {
    const rec = scoring.rec || 0;
    pts = (rec >= 1 ? stats.pts_ppr : rec >= 0.5 ? stats.pts_half_ppr : stats.pts_std) || 0;
  }
  if (pts === 0 && sport === 'nba') pts = stats.pts_std || 0;
  return pts;
}

/* Last-3-game offensive snap share sets the role for skill players. */
function snapRole(weekly) {
  const shares = weekly.filter((w) => w.gp > 0 && w.tmSnaps > 0).map((w) => w.snaps / w.tmSnaps);
  if (shares.length < 2) return null;
  const last = shares.slice(-3), early = shares.slice(0, -3);
  const avg = (a) => a.reduce((x, y) => x + y, 0) / a.length;
  const r = avg(last);
  if (r < 0.3) return { role: 'fringe', why: 'On the field for ' + Math.round(r * 100) + '% of snaps lately.' };
  if (early.length && r - avg(early) >= 0.15) return { role: 'rising', why: 'Snap share up from ' + Math.round(avg(early) * 100) + '% to ' + Math.round(r * 100) + '%.' };
  if (r < 0.55) return { role: 'rotation', why: 'On the field for ' + Math.round(r * 100) + '% of snaps lately.' };
  return null;
}

async function load({ leagueId, username, rosterId }) {
  username = username && String(username).replace(/^@/, '');
  const league = await getJSON(B + '/league/' + encodeURIComponent(leagueId), { ttl: 10 * 60 * 1000 });
  if (!league) throw new FetchError('No Sleeper league with ID ' + leagueId, 404);
  const sport = league.sport === 'nba' ? 'nba' : league.sport === 'clubsoccer:epl' ? 'epl' : 'nfl';
  const [rosters, users, st, db] = await Promise.all([
    getJSON(B + '/league/' + leagueId + '/rosters', { ttl: 5 * 60 * 1000 }),
    getJSON(B + '/league/' + leagueId + '/users', { ttl: HOUR }),
    getJSON(B + '/state/' + API_SPORT[sport], { ttl: 10 * 60 * 1000 }),
    getJSON(B + '/players/' + API_SPORT[sport], { ttl: 24 * HOUR, disk: true, timeout: 120000 })
  ]);

  const season = String(league.season);
  const current = String(st.league_season || st.season) === season;
  let lastWeek = SEASON_WEEKS[sport];
  if (current) lastWeek = st.season_type === 'regular' ? Math.max(0, (st.week || 1) - 1) : st.season_type === 'pre' ? 0 : SEASON_WEEKS[sport];
  const weeks = [];
  for (let w = 1; w <= lastWeek; w++) weeks.push(w);
  const weekStats = await Promise.all(weeks.map((w) =>
    getJSON(B + '/stats/' + API_SPORT[sport] + '/regular/' + season + '/' + w, { ttl: w < lastWeek ? 24 * HOUR : HOUR, disk: true, timeout: 60000 }).catch(() => ({}))));

  const scoring = league.scoring_settings || {};
  const perPlayer = (id) => weekStats.map((ws) => {
    const s = ws[id] || {};
    const gp = s.gp || 0;
    return { pts: gp ? points(s, scoring, sport) : 0, gp, snaps: s.off_snp || 0, tmSnaps: s.tm_off_snp || 0 };
  });

  const build = (id, slot) => {
    const d = db[id];
    if (!d) return null;
    const pos = toPos(sport, (d.fantasy_positions && d.fantasy_positions[0]) || d.position);
    if (!pos) return null;
    const weekly = perPlayer(id);
    const a = averages(weekly, sport);
    const flags = [];
    let role = 'steady';
    if (sport === 'nfl' && SKILL.indexOf(pos) >= 0) {
      const r = snapRole(weekly);
      if (r) { role = r.role; flags.push(r.why); }
    }
    const injury = d.injury_status || '';
    const news = [d.injury_body_part, d.injury_notes].filter(Boolean).join(': ');
    const name = pos === 'DST' ? (d.first_name + ' ' + d.last_name).trim() : d.full_name || (d.first_name + ' ' + d.last_name);
    const elig = (d.fantasy_positions || []).map((x) => toPos(sport, x)).filter(Boolean);
    const p = makePlayer({ id, name, team: d.team_abbr || d.team || 'FA', pos, elig: elig.length ? elig : [pos], age: d.age, yearsExp: d.years_exp, season: a.season, recent: a.recent, gp: a.gp, health: healthFrom(injury), role, injury, news, flags, slot });
    return current ? fillFromData(p, sport) : p;
  };

  const userById = new Map(users.map((u) => [u.user_id, u]));
  let me = null;
  if (username) {
    const u = users.find((x) => String(x.display_name || '').toLowerCase() === String(username).trim().toLowerCase()) ||
      await findUser(username).then((f) => users.find((x) => x.user_id === f.user_id)).catch(() => null);
    if (u) me = rosters.find((r) => r.owner_id === u.user_id || (r.co_owners || []).indexOf(u.user_id) >= 0);
  }
  if (rosterId) me = rosters.find((r) => String(r.roster_id) === String(rosterId)) || me;

  const rostered = new Set();
  const teams = rosters.map((r) => {
    const u = userById.get(r.owner_id) || {};
    const starters = (r.starters || []).filter((x) => x && x !== '0');
    const reserve = new Set(r.reserve || []);
    const ids = (r.players || []);
    ids.forEach((id) => rostered.add(id));
    const players = ids.map((id) => build(id, reserve.has(id) ? 'IR' : starters.indexOf(id) >= 0 ? 'START' : 'BN')).filter(Boolean);
    const s = r.settings || {};
    return {
      id: String(r.roster_id), name: (u.metadata && u.metadata.team_name) || u.display_name || 'Team ' + r.roster_id,
      owner: u.display_name || '', isMine: me ? r.roster_id === me.roster_id : false,
      wins: s.wins || 0, losses: s.losses || 0, ties: s.ties || 0,
      pointsFor: (s.fpts || 0) + (s.fpts_decimal || 0) / 100, players
    };
  });

  const freeAgents = [];
  for (const id in db) {
    if (rostered.has(id)) continue;
    const d = db[id];
    if (!d.team || d.active === false) continue;
    const p = build(id, 'FA');
    if (p && p.season > 0) freeAgents.push(p);
  }

  const byes = sport === 'nfl' ? await byeWeeks(season) : {};
  const slots = (league.roster_positions || []).filter((s) => BENCH_SLOTS.indexOf(s) < 0)
    .map((s) => (sport === 'nfl' && s === 'DEF' ? 'DST' : sport === 'epl' ? EPL_POS[s] || s : s));
  const recLabel = sport === 'epl' ? 'league scoring' : sport === 'nfl' ? ({ 1: 'PPR', 0.5: 'Half PPR', 0: 'Standard' }[scoring.rec || 0] || scoring.rec + ' per catch') : 'league points';
  return {
    platform: 'sleeper', sport, name: league.name, season, week: lastWeek,
    statsThrough: lastWeek ? 'Week ' + lastWeek : 'no games yet',
    scoring: recLabel, slots, teams, freeAgents,
    waiver: (league.settings || {}).waiver_type === 2 ? 'faab' : 'priority',
    type: ({ 1: 'keeper', 2: 'dynasty' })[(league.settings || {}).type] || 'redraft',
    byes, nextWeek: current && st.season_type === 'regular' ? st.week : null,
    notes: lastWeek ? [] : ['No ' + season + ' games played yet. Numbers come from the repo data files where available.']
  };
}

module.exports = { listLeagues, load, points, snapRole };

},
"server/lib/fetch.js": function (module, exports, __require, __builtin, __dirname) {
/* JSON fetch with a timeout, an in-memory cache and an optional on-disk cache for large, slow-changing files. */
const IN_BROWSER = typeof window !== 'undefined';
const fs = IN_BROWSER ? null : __builtin("fs");
const path = IN_BROWSER ? null : __builtin("path");

const CACHE_DIR = path ? path.join(__dirname, '..', '..', '.cache') : null;
const mem = new Map();

class FetchError extends Error {
  constructor(message, status, url) { super(message); this.status = status; this.url = url; }
}

async function getJSON(url, { headers = {}, ttl = 5 * 60 * 1000, disk = false, timeout = 30000 } = {}) {
  const key = url + '|' + JSON.stringify(headers);
  const hit = mem.get(key);
  if (hit && Date.now() - hit.at < ttl) return hit.data;

  const file = disk && fs ? path.join(CACHE_DIR, url.replace(/[^a-z0-9]+/gi, '_').slice(-180) + '.json') : null;
  if (file) {
    try {
      const st = fs.statSync(file);
      if (Date.now() - st.mtimeMs < ttl) {
        const data = JSON.parse(fs.readFileSync(file, 'utf8'));
        mem.set(key, { at: st.mtimeMs, data });
        return data;
      }
    } catch (e) { /* no usable cache file */ }
  }

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeout);
  let res;
  try {
    res = await fetch(url, { headers: IN_BROWSER ? headers : { 'User-Agent': 'FantasyCoach/1.0', Accept: 'application/json', ...headers }, signal: ctl.signal });
  } catch (e) {
    throw new FetchError(e.name === 'AbortError' ? 'Timed out reaching ' + new URL(url).host : 'Could not reach ' + new URL(url).host + ' (' + e.message + ')', 0, url);
  } finally { clearTimeout(timer); }
  if (!res.ok) throw new FetchError(new URL(url).host + ' answered ' + res.status, res.status, url);
  const data = await res.json();
  mem.set(key, { at: Date.now(), data });
  if (file) {
    try { fs.mkdirSync(CACHE_DIR, { recursive: true }); fs.writeFileSync(file, JSON.stringify(data)); } catch (e) { /* cache is optional */ }
  }
  return data;
}

module.exports = { getJSON, FetchError };

},
"server/lib/players.js": function (module, exports, __require, __builtin, __dirname) {
/* Helpers that turn platform data into the engine's player shape:
   { id, name, team, pos, season, recent, gp, health, role, sched, injury, news, flags } */
const RECENT_GAMES = { nfl: 4, nba: 10, fpl: 4 };

const normName = (s) => String(s || '').toLowerCase()
  .normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/\b(jr|sr|ii|iii|iv|v)\b\.?/g, '').replace(/[^a-z0-9]+/g, ' ').trim();

const round2 = (n) => Math.round(n * 100) / 100;

/* weeks: [{ pts, gp }] oldest first. Season = points per game; recent = per game over the last N games. */
function averages(weeks, sport) {
  const played = weeks.filter((w) => w.gp > 0);
  const gp = played.reduce((a, w) => a + w.gp, 0);
  if (!gp) return { season: 0, recent: 0, gp: 0 };
  const total = played.reduce((a, w) => a + w.pts, 0);
  const want = RECENT_GAMES[sport] || 4;
  let rp = 0, rg = 0;
  for (let i = played.length - 1; i >= 0 && rg < want; i--) { rp += played[i].pts; rg += played[i].gp; }
  return { season: round2(Math.max(0, total / gp)), recent: round2(Math.max(0, rp / rg)), gp };
}

const dataCache = {};
let loadData = (sport) => {
  const fs = __builtin("fs"), path = __builtin("path");
  return JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'data', sport + '.json'), 'utf8'));
};
/* The browser build swaps this for data it fetched up front. */
function setDataLoader(fn) { loadData = fn; Object.keys(dataCache).forEach((k) => delete dataCache[k]); }

function dataFile(sport) {
  if (sport in dataCache) return dataCache[sport];
  let out = null;
  try {
    const j = loadData(sport);
    if (!j) throw new Error('no data');
    const by = new Map();
    (j.players || []).forEach((p) => { if (p && p.name) by.set(normName(p.name) + '|' + (p.pos || ''), p); if (p && p.name && !by.has(normName(p.name))) by.set(normName(p.name), p); });
    out = { fetched: String(j.fetched_at || '').slice(0, 10), through: j.through || '', by, players: j.players || [] };
  } catch (e) { out = null; }
  dataCache[sport] = out;
  return out;
}

/* Fill a player with no games this season from data/<sport>.json, when the repo has a matching entry. */
function fillFromData(p, sport) {
  if (p.gp > 0) return p;
  const d = dataFile(sport);
  const m = d && (d.by.get(normName(p.name) + '|' + p.pos) || d.by.get(normName(p.name)));
  if (!m || !Number.isFinite(m.season)) return p;
  p.season = Math.max(0, m.season);
  p.recent = Number.isFinite(m.recent) ? Math.max(0, m.recent) : p.season;
  if (p.health === 'healthy' && m.health) p.health = m.health;
  if (p.role === 'steady' && m.role) p.role = m.role;
  if (!p.news && m.news) p.news = m.news;
  p.source = 'data';
  p.flags.push('Numbers from data/' + sport + '.json (' + (d.through || d.fetched) + '), not from your league.');
  return p;
}

/* Maps an injury designation from any platform to the engine's health keys. */
function healthFrom(status) {
  const t = String(status || '').trim().toLowerCase().replace(/_/g, ' ');
  if (!t || t === 'active' || t === 'normal' || t === 'a' || t === 'healthy') return 'healthy';
  if (/^(q|questionable|probable|p|day[- ]?to[- ]?day|dtd|gtd|d)$/.test(t)) return 'minor';
  if (/^(doubtful|out|o|sus|suspension|suspended|covid|cov)$/.test(t)) return 'short';
  if (/^(ir|injury reserve|injured reserve|pup|na|nfi|dnr|il|out for season|ofs)$/.test(t)) return 'long';
  return 'minor';
}

function makePlayer(o) {
  return {
    id: String(o.id), name: o.name || 'Unknown', team: o.team || '', pos: o.pos,
    season: o.season || 0, recent: o.recent || 0, gp: o.gp || 0,
    health: o.health || 'healthy', role: o.role || 'steady', sched: 'neutral',
    injury: o.injury || '', news: o.news || '', flags: o.flags || [], source: o.source || 'league',
    cost: o.cost, slot: o.slot, elig: o.elig || [o.pos], age: o.age || null, yearsExp: o.yearsExp != null ? o.yearsExp : null
  };
}

module.exports = { averages, dataFile, setDataLoader, fillFromData, healthFrom, makePlayer, normName, round2, RECENT_GAMES };

},
"engine.js": function (module, exports, __require, __builtin, __dirname) {
/* Move Check scoring engine. Pure functions shared by index.html (browser) and server/ (Node). */
const SPORTS = {
  fpl: { name: 'Premier League', per: 'gameweek', perShort: 'GW', unit: 'FPL points per gameweek',
    positions: ['GKP', 'DEF', 'MID', 'FWD'], repl: { GKP: 3.6, DEF: 3.8, MID: 4.2, FWD: 3.9 },
    games: { w4: 4, w8: 8, ros: 30 }, miss: { healthy: 0, minor: 0.5, short: 3, long: 12 }, step: 0.1,
    seasonLbl: 'Season avg', recentLbl: 'Last 4 GWs avg' },
  nfl: { name: 'NFL', per: 'week', perShort: 'wk', unit: 'fantasy points per game',
    positions: ['QB', 'RB', 'WR', 'TE', 'K', 'DST'], repl: { QB: 16, RB: 8, WR: 8.5, TE: 6, K: 7, DST: 6.5 },
    games: { w4: 4, w8: 8, ros: 11 }, miss: { healthy: 0, minor: 0.5, short: 3, long: 8 }, step: 0.5,
    seasonLbl: 'Season avg', recentLbl: 'Last 4 games avg' },
  nba: { name: 'NBA', per: 'game', perShort: 'g', unit: 'fantasy points per game',
    positions: ['PG', 'SG', 'SF', 'PF', 'C'], repl: { PG: 24, SG: 24, SF: 24, PF: 24, C: 24 },
    games: { w4: 14, w8: 28, ros: 70 }, miss: { healthy: 0, minor: 2, short: 10, long: 35 }, step: 0.5,
    seasonLbl: 'Season avg', recentLbl: 'Last 10 games avg' },
  epl: { name: 'Premier League', per: 'gameweek', perShort: 'GW', unit: 'league points per gameweek',
    positions: ['GKP', 'DEF', 'MID', 'FWD'], repl: { GKP: 9, DEF: 12, MID: 13, FWD: 30 },
    games: { w4: 4, w8: 8, ros: 30 }, miss: { healthy: 0, minor: 0.5, short: 3, long: 12 }, step: 0.5,
    seasonLbl: 'Season avg', recentLbl: 'Last 4 GWs avg' }
};
const ROLES = { rising: ['Role growing', 1.08, 0], steady: ['Locked-in starter', 1.0, 0], rotation: ['Rotation risk', 0.88, 1], fringe: ['Bench or unclear', 0.68, 2] };
const SCHEDS = { easy: ['Easy run', 1.07], neutral: ['Average run', 1.0], tough: ['Tough run', 0.93] };
const HEALTH = { healthy: ['Healthy', 0], minor: ['Minor knock', 1], short: ['Out 2 to 4 weeks', 2], long: ['Out long-term', 3] };
const COSTS = { free: ['Free claim', 0.05], low: ['Small bid', 0.10], priority: ['Top waiver priority', 0.18], big: ['Big bid', 0.28] };
const TRADE_W = [1, 0.85, 0.7];

const num = (v) => { const n = parseFloat(v); return Number.isFinite(n) && n >= 0 ? n : 0; };
const fmt = (n, d = 1) => (Math.abs(n) < 0.05 && d === 1 ? 0 : n).toFixed(d);
const sgn = (n, d = 1) => (n > 0 ? '+' : n < 0 ? '−' : '') + Math.abs(n).toFixed(d);

function valuePlayer(p, sportKey, ctx) {
  const S = SPORTS[sportKey], G = ctx.G, w = ctx.formW;
  const season = num(p.season), recent = num(p.recent);
  const base = season * (1 - w) + recent * w;
  const ppg = base * ROLES[p.role][1] * SCHEDS[p.sched][1];
  const miss = Math.min(G, S.miss[p.health]);
  const played = G - miss;
  const replPG = num(ctx.repl[p.pos]);
  const vor = (ppg - replPG) * played;
  let risk = ROLES[p.role][2] + HEALTH[p.health][1];
  if (season > 0 && Math.abs(recent - season) / season > 0.35) risk += 1;
  const riskLvl = risk >= 3 ? 2 : risk === 2 ? 1 : 0;
  return { ppg, miss, played, replPG, vor, risk, riskLvl, season, recent };
}

function pname(p, fb) { return (p.name || '').trim() || fb; }

function flags(p, v, n) {
  const out = [];
  if (v.season > 0) {
    const d = (v.recent - v.season) / v.season;
    if (d >= 0.15) out.push(n + ' is running ' + Math.round(d * 100) + '% above their season average lately.');
    else if (d <= -0.15) out.push(n + ' is running ' + Math.round(-d * 100) + '% below their season average lately.');
  }
  if (p.role === 'rising') out.push(n + ' has a growing role, which lifts the projection 8%.');
  if (p.role === 'rotation') out.push(n + ' carries rotation risk, which cuts the projection 12%.');
  if (p.role === 'fringe') out.push(n + ' is on the fringe of the lineup, which cuts the projection 32%.');
  if (p.sched === 'easy') out.push(n + ' has an easy schedule ahead.');
  if (p.sched === 'tough') out.push(n + ' has a tough schedule ahead.');
  if (v.miss > 0) out.push(n + ' is expected to miss about ' + (v.miss % 1 ? v.miss.toFixed(1) : v.miss) + ' games in this window.');
  return out;
}

function compareWaiver(add, drop, costKey, sportKey, ctx) {
  const S = SPORTS[sportKey];
  const a = valuePlayer(add, sportKey, ctx), d = valuePlayer(drop, sportKey, ctx);
  const an = pname(add, 'The add'), dn = pname(drop, 'The drop');
  const edge = a.vor - d.vor, G = ctx.G;
  const bar = COSTS[costKey][1] * Math.max(a.replPG, 0.1) * G;
  let key, label, tone;
  if (edge >= 2 * bar) { key = 'strong'; label = 'Strong add'; tone = 'good'; }
  else if (edge >= bar) { key = 'add'; label = 'Add'; tone = 'good'; }
  else if (edge >= 0) { key = 'close'; label = 'Close call'; tone = 'warn'; }
  else { key = 'pass'; label = 'Pass'; tone = 'bad'; }
  const gauge = Math.max(0, Math.min(100, 50 + (bar > 0 ? edge / (2 * bar) : 0) * 50));
  const reasons = [];
  reasons.push('Over ' + G + ' ' + S.per + 's, ' + an + ' projects at ' + fmt(a.ppg) + ' per ' + S.per + ' against ' + fmt(d.ppg) + ' for ' + dn + '.');
  reasons.push('Net gain over replacement: ' + sgn(edge) + ' points (' + sgn(edge / G, 2) + ' per ' + S.per + '). The bar for this claim is ' + fmt(bar) + '.');
  flags(add, a, an).forEach((t) => reasons.push(t));
  flags(drop, d, dn).forEach((t) => reasons.push(t));
  if (add.pos !== drop.pos) reasons.push('Different positions (' + add.pos + ' for ' + drop.pos + '). Check that your lineup has a slot for ' + an + '.');
  if (a.riskLvl === 2) reasons.push(an + ' is a high-risk add. Consider waiting a week for more clarity.');
  return { a, d, edge, bar, key, label, tone, gauge, reasons: reasons.slice(0, 7) };
}

function sideValue(players, sportKey, ctx) {
  const vs = players.map((p) => ({ p, v: valuePlayer(p, sportKey, ctx) }));
  vs.sort((x, y) => Math.max(0, y.v.vor) - Math.max(0, x.v.vor));
  let total = 0;
  vs.forEach((x, i) => { x.w = TRADE_W[i] || 0.7; x.val = Math.max(0, x.v.vor) * x.w; total += x.val; });
  return { vs, total };
}

function compareTrade(give, get, sportKey, ctx) {
  const S = SPORTS[sportKey], G = ctx.G;
  const gv = sideValue(give, sportKey, ctx), tv = sideValue(get, sportKey, ctx);
  const net = tv.total - gv.total;
  const denom = Math.max(gv.total, tv.total, G * 0.5);
  const pct = net / denom;
  let key, label, tone;
  if (pct >= 0.25) { key = 'steal'; label = 'Take it'; tone = 'good'; }
  else if (pct >= 0.08) { key = 'lean'; label = 'Lean yes'; tone = 'good'; }
  else if (pct > -0.08) { key = 'even'; label = 'Even deal'; tone = 'warn'; }
  else if (pct > -0.25) { key = 'lose'; label = 'Lean no'; tone = 'bad'; }
  else { key = 'hard'; label = 'Decline'; tone = 'bad'; }
  const gauge = Math.max(0, Math.min(100, 50 + (pct / 0.5) * 50));
  const reasons = [];
  reasons.push('You get ' + fmt(tv.total, 0) + ' points of value over replacement and give up ' + fmt(gv.total, 0) + ' over ' + G + ' ' + S.per + 's.');
  if (net < 0 && pct <= -0.08) reasons.push('To even this out, ask for about ' + fmt(-net, 0) + ' more points of value (' + fmt(-net / G, 1) + ' per ' + S.per + ').');
  if (give.length !== get.length) {
    reasons.push(give.length > get.length
      ? 'You send ' + give.length + ' and get ' + get.length + '. The open roster spots fill from waivers at replacement level, which the score already counts.'
      : 'You send ' + give.length + ' and get ' + get.length + '. Make sure you have roster room, and drop your worst player.');
  }
  tv.vs.forEach((x, i) => { const n = pname(x.p, 'Incoming player ' + (i + 1)); flags(x.p, x.v, n).slice(0, 2).forEach((t) => reasons.push(t)); });
  gv.vs.forEach((x, i) => { const n = pname(x.p, 'Outgoing player ' + (i + 1)); flags(x.p, x.v, n).slice(0, 1).forEach((t) => reasons.push(t)); });
  const highIn = tv.vs.filter((x) => x.v.riskLvl === 2).length;
  if (highIn) reasons.push(highIn + ' incoming player' + (highIn > 1 ? 's are' : ' is') + ' high risk. Weigh that before you accept.');
  return { gv, tv, net, pct, key, label, tone, gauge, reasons: reasons.slice(0, 7) };
}

/* Turns three lists (your roster, free agents, another team's roster) into ranked, plain-language moves. Pure functions. */
const usable = (p) => num(p.season) > 0;
const ladder = (names) => names.length > 1 ? names.slice(0, -1).join(', ') + ' and ' + names[names.length - 1] : names[0] || '';
const nm = (p, fb) => pname(p, fb);

function pickupMoves(mine, pool, sportKey, ctx) {
  const S = SPORTS[sportKey], G = ctx.G, pairs = [];
  pool.filter(usable).forEach((f) => mine.filter(usable).forEach((d) => {
    if (f.pos !== d.pos) return;
    const r = compareWaiver(f, d, 'free', sportKey, ctx);
    if (r.edge > 0) pairs.push({ f, d, r });
  }));
  pairs.sort((x, y) => ((y.r.key !== 'close') - (x.r.key !== 'close')) || y.r.edge - x.r.edge);
  const usedF = new Set(), usedD = new Set(), out = [];
  for (const x of pairs) {
    if (usedF.has(x.f) || usedD.has(x.d)) continue;
    if (x.r.key !== 'strong' && x.r.key !== 'add' && out.length) continue;
    if (x.r.key === 'close' && out.length === 0) { x.marginal = true; }
    usedF.add(x.f); usedD.add(x.d);
    const an = nm(x.f, 'The free agent'), dn = nm(x.d, 'your player');
    const sentences = [an + ' projects at ' + fmt(x.r.a.ppg) + ' per ' + S.per + ' against ' + fmt(x.r.d.ppg) + ' for ' + dn + ', so the swap adds about ' + fmt(x.r.edge, 0) + ' points over the next ' + G + ' ' + S.per + 's.'];
    flags(x.f, x.r.a, an).slice(0, 2).forEach((t) => sentences.push(t));
    flags(x.d, x.r.d, nm(x.d, 'Your player')).slice(0, 1).forEach((t) => sentences.push(t));
    if (x.r.a.riskLvl === 2) sentences.push('This is a risky add, so check the latest news before you claim.');
    out.push({ kind: 'pickup', label: x.marginal ? 'Marginal gain' : x.r.label, tone: x.marginal ? 'warn' : x.r.tone, title: 'Pick up ' + an + ', drop ' + dn, pos: x.f.pos, gain: x.r.edge, text: sentences.join(' ') });
    if (out.length >= 4 || x.marginal) break;
  }
  return out;
}

function combos(arr, k) {
  const out = [];
  arr.forEach((a, i) => { if (k === 1) out.push([a]); else for (let j = i + 1; j < arr.length; j++) out.push([a, arr[j]]); });
  return out;
}

function tradeMoves(mine, theirs, sportKey, ctx) {
  const S = SPORTS[sportKey], G = ctx.G, M = mine.filter(usable), T = theirs.filter(usable), cands = [];
  [[1, 1], [2, 1], [1, 2]].forEach(([gk, tk]) => combos(M, gk).forEach((give) => combos(T, tk).forEach((get) => {
    const r = compareTrade(give, get, sportKey, ctx);
    if (r.pct >= 0.03 && r.pct <= 0.2 && r.net >= G * 0.3) cands.push({ give, get, r });
  })));
  cands.sort((x, y) => y.r.net - x.r.net);
  const seen = new Set(), out = [];
  for (const c of cands) {
    if (c.get.some((p) => seen.has(p)) || c.give.some((p) => seen.has(p))) continue;
    c.get.concat(c.give).forEach((p) => seen.add(p));
    const gn = c.give.map((p) => nm(p, 'your ' + p.pos)), tn = c.get.map((p) => nm(p, 'their ' + p.pos));
    const s = ['By these numbers you come out ' + fmt(c.r.net, 0) + ' points ahead over the next ' + G + ' ' + S.per + 's, close enough to even that they could say yes.'];
    c.r.reasons.slice(1).filter((t) => !/^To even/.test(t)).slice(0, 2).forEach((t) => s.push(t));
    out.push({ kind: 'trade', label: 'Worth offering', tone: 'good', title: 'Offer ' + ladder(gn) + ' for ' + ladder(tn), pos: c.get[0].pos, gain: c.r.net, text: s.join(' '), give: c.give, get: c.get });
    if (out.length >= 3) break;
  }
  return out;
}

if (typeof module !== 'undefined') {
  module.exports = { SPORTS, ROLES, SCHEDS, HEALTH, COSTS, TRADE_W, num, fmt, sgn, valuePlayer, flags, compareWaiver, sideValue, compareTrade, pickupMoves, tradeMoves, combos };
}

},
"server/lib/nfl.js": function (module, exports, __require, __builtin, __dirname) {
/* NFL bye weeks, from ESPN's public pro-team schedule (no login needed). Keys use Sleeper's team codes. */
const { getJSON } = __require("server/lib/fetch.js");

const ALIAS = { WSH: 'WAS', JAC: 'JAX' };

async function byeWeeks(season) {
  try {
    const j = await getJSON('https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/' + season + '?view=proTeamSchedules_wl', { ttl: 24 * 3600 * 1000, disk: true });
    const out = {};
    ((j.settings || {}).proTeams || []).forEach((t) => {
      const ab = String(t.abbrev || '').toUpperCase();
      if (t.byeWeek > 0) { out[ALIAS[ab] || ab] = t.byeWeek; out[ab] = t.byeWeek; }
    });
    return out;
  } catch (e) { return {}; }
}

module.exports = { byeWeeks };

},
"server/connectors/espn.js": function (module, exports, __require, __builtin, __dirname) {
/* ESPN Fantasy (NFL "ffl", NBA "fba"). Unofficial v3 API. Public leagues work as is;
   private leagues need the espn_s2 and SWID cookies from a logged-in browser. */
const { getJSON, FetchError } = __require("server/lib/fetch.js");
const { averages, fillFromData, healthFrom, makePlayer } = __require("server/lib/players.js");
const { byeWeeks } = __require("server/lib/nfl.js");

const HOST = 'https://lm-api-reads.fantasy.espn.com/apis/v3/games/';
const GAME = { nfl: 'ffl', nba: 'fba' };
const POS = {
  nfl: { 1: 'QB', 2: 'RB', 3: 'WR', 4: 'TE', 5: 'K', 16: 'DST' },
  nba: { 1: 'PG', 2: 'SG', 3: 'SF', 4: 'PF', 5: 'C' }
};
const SLOTS = {
  nfl: { 0: 'QB', 2: 'RB', 3: 'WRRB_FLEX', 4: 'WR', 5: 'REC_FLEX', 6: 'TE', 7: 'SUPER_FLEX', 16: 'DST', 17: 'K', 23: 'FLEX' },
  nba: { 0: 'PG', 1: 'SG', 2: 'SF', 3: 'PF', 4: 'C', 5: 'G', 6: 'F', 7: 'SG/SF', 8: 'G/F', 9: 'PF/C', 10: 'F/C', 11: 'UTIL' }
};
const BENCH = { nfl: 20, nba: 12 };
const IR = { nfl: 21, nba: 13 };

function headers({ espnS2, swid }, filter) {
  const h = {};
  if (espnS2 && swid) h.Cookie = 'espn_s2=' + espnS2 + '; SWID=' + swid;
  if (filter) h['x-fantasy-filter'] = JSON.stringify(filter);
  return h;
}

/* Weekly (NFL) or per-day (NBA) actual points for this season, oldest first. */
function weeksFrom(player, season) {
  return (player.stats || [])
    .filter((s) => s.seasonId === season && s.statSourceId === 0 && s.statSplitTypeId === 1 && s.scoringPeriodId > 0)
    .sort((a, b) => a.scoringPeriodId - b.scoringPeriodId)
    .map((s) => ({ pts: s.appliedTotal || 0, gp: 1 }));
}

async function load({ leagueId, sport = 'nfl', season, teamId, espnS2, swid }) {
  if (!GAME[sport]) throw new FetchError('ESPN supports nfl or nba', 400);
  season = Number(season) || new Date().getFullYear() + (sport === 'nba' && new Date().getMonth() >= 8 ? 1 : 0);
  const base = HOST + GAME[sport] + '/seasons/' + season + '/segments/0/leagues/' + encodeURIComponent(leagueId);
  const auth = { espnS2, swid };
  let league;
  try {
    league = await getJSON(base + '?view=mTeam&view=mRoster&view=mSettings&view=mStatus', { headers: headers(auth), ttl: 5 * 60 * 1000 });
  } catch (e) {
    if (e.status === 401) throw new FetchError('ESPN says this league is private. Add your espn_s2 and SWID cookies.', 401);
    if (e.status === 404) throw new FetchError('No ESPN ' + sport.toUpperCase() + ' league ' + leagueId + ' for ' + season, 404);
    throw e;
  }

  const proTeams = await getJSON(HOST + GAME[sport] + '/seasons/' + season + '?view=proTeamSchedules_wl', { ttl: 24 * 3600 * 1000, disk: true })
    .then((j) => new Map(((j.settings || {}).proTeams || []).map((t) => [t.id, (t.abbrev || '').toUpperCase()])))
    .catch(() => new Map());

  const rosterIds = [];
  (league.teams || []).forEach((t) => ((t.roster || {}).entries || []).forEach((e) => rosterIds.push(e.playerId)));
  const kona = (filter) => getJSON(base + '?view=kona_player_info', { headers: headers(auth, filter), ttl: 5 * 60 * 1000 })
    .then((j) => j.players || []).catch(() => []);
  const [rosteredInfo, faInfo] = await Promise.all([
    kona({ players: { filterIds: { value: rosterIds }, limit: rosterIds.length + 10 } }),
    kona({ players: { filterStatus: { value: ['FREEAGENT', 'WAIVERS'] }, limit: 250, sortPercOwned: { sortPriority: 1, sortAsc: false } } })
  ]);
  const info = new Map(rosteredInfo.concat(faInfo).map((x) => [x.id, x.player]));

  const build = (pl, slot) => {
    if (!pl) return null;
    const pos = POS[sport][pl.defaultPositionId];
    if (!pos) return null;
    const a = averages(weeksFrom(pl, season), sport);
    const injury = pl.injured || (pl.injuryStatus && pl.injuryStatus !== 'ACTIVE') ? pl.injuryStatus || 'Injured' : '';
    const p = makePlayer({ id: pl.id, name: pl.fullName, team: proTeams.get(pl.proTeamId) || '', pos, season: a.season, recent: a.recent, gp: a.gp, health: healthFrom(injury), injury, slot });
    return fillFromData(p, sport);
  };

  const members = new Map((league.members || []).map((m) => [m.id, m]));
  const swidNorm = String(swid || '').toUpperCase();
  const teams = (league.teams || []).map((t) => {
    const owners = t.owners || (t.primaryOwner ? [t.primaryOwner] : []);
    const owner = members.get(owners[0]) || {};
    const rec = (t.record || {}).overall || {};
    const players = ((t.roster || {}).entries || []).map((e) => {
      const slot = e.lineupSlotId === IR[sport] ? 'IR' : e.lineupSlotId === BENCH[sport] ? 'BN' : 'START';
      return build(info.get(e.playerId) || (e.playerPoolEntry || {}).player, slot);
    }).filter(Boolean);
    return {
      id: String(t.id), name: t.name || ((t.location || '') + ' ' + (t.nickname || '')).trim() || t.abbrev || 'Team ' + t.id,
      owner: owner.displayName || '', isMine: teamId ? String(t.id) === String(teamId) : !!swidNorm && owners.some((o) => String(o).toUpperCase() === swidNorm),
      wins: rec.wins || 0, losses: rec.losses || 0, ties: rec.ties || 0, pointsFor: rec.pointsFor || 0, players
    };
  });

  const freeAgents = faInfo.map((x) => build(x.player, 'FA')).filter((p) => p && p.season > 0);
  const counts = ((league.settings || {}).rosterSettings || {}).lineupSlotCounts || {};
  const slots = [];
  Object.keys(counts).forEach((id) => { const n = SLOTS[sport][id]; for (let i = 0; i < counts[id] && n; i++) slots.push(n); });
  const period = (league.status || {}).latestScoringPeriod || league.scoringPeriodId || 0;
  return {
    platform: 'espn', sport, name: (league.settings || {}).name || 'ESPN league ' + leagueId, season: String(season),
    week: Math.max(0, period - 1), statsThrough: sport === 'nfl' ? 'Week ' + Math.max(0, period - 1) : 'scoring period ' + period,
    scoring: 'league scoring', slots, teams, freeAgents,
    waiver: ((league.settings || {}).acquisitionSettings || {}).isUsingAcquisitionBudget ? 'faab' : 'priority',
    type: ((league.settings || {}).draftSettings || {}).keeperCount > 0 ? 'keeper' : 'redraft',
    byes: sport === 'nfl' ? await byeWeeks(season) : {}, nextWeek: sport === 'nfl' && period ? period : null,
    notes: ['ESPN data comes from an unofficial API and can change without notice.']
  };
}

module.exports = { load, weeksFrom };

},
"server/connectors/fpl.js": function (module, exports, __require, __builtin, __dirname) {
/* Fantasy Premier League (classic). Public API, no login needed for teams, picks and league standings. */
const { getJSON, FetchError } = __require("server/lib/fetch.js");
const { healthFrom, makePlayer, round2 } = __require("server/lib/players.js");

const B = 'https://fantasy.premierleague.com/api';
const POS = { 1: 'GKP', 2: 'DEF', 3: 'MID', 4: 'FWD' };
const MAX_RIVALS = 20;
const FIXTURE_LOOKAHEAD = 6;

function fplHealth(e) {
  const c = e.chance_of_playing_next_round;
  if (e.status === 'a') return 'healthy';
  if (e.status === 'd') return c != null && c >= 75 ? 'minor' : 'short';
  if (e.status === 'u' || e.status === 'n') return 'long';
  if (/unknown return|season|surgery|several months/i.test(e.news || '')) return 'long';
  return healthFrom(e.status === 's' ? 'suspended' : 'out');
}

/* Share of finished gameweeks the player started. FPL's own data, no guessing. */
function fplRole(e, finished) {
  if (!finished) return { role: 'steady' };
  const r = (e.starts || 0) / finished;
  const ppg = parseFloat(e.points_per_game) || 0, form = parseFloat(e.form) || 0;
  if (r < 0.25) return { role: 'fringe', why: 'Started ' + e.starts + ' of ' + finished + ' gameweeks.' };
  if (r < 0.6) return { role: 'rotation', why: 'Started ' + e.starts + ' of ' + finished + ' gameweeks.' };
  if (ppg > 0 && form >= ppg * 1.3 && form >= 5) return { role: 'rising', why: 'Form ' + form + ' against a season average of ' + ppg + '.' };
  return { role: 'steady' };
}

/* Average fixture difficulty (1 easiest to 5 hardest) over the next few gameweeks, per club. */
function fixtureRuns(fixtures, fromEvent) {
  const by = {};
  fixtures.filter((f) => f.event && f.event >= fromEvent && f.event < fromEvent + FIXTURE_LOOKAHEAD).forEach((f) => {
    (by[f.team_h] = by[f.team_h] || []).push(f.team_h_difficulty);
    (by[f.team_a] = by[f.team_a] || []).push(f.team_a_difficulty);
  });
  const out = {};
  Object.keys(by).forEach((t) => {
    const avg = by[t].reduce((a, b) => a + b, 0) / by[t].length;
    out[t] = { avg: round2(avg), n: by[t].length, sched: avg <= 2.6 ? 'easy' : avg >= 3.4 ? 'tough' : 'neutral' };
  });
  return out;
}

async function bootstrap() { return getJSON(B + '/bootstrap-static/', { ttl: 30 * 60 * 1000, disk: true }); }

async function listLeagues(entryId) {
  let entry;
  try { entry = await getJSON(B + '/entry/' + encodeURIComponent(entryId) + '/', { ttl: 10 * 60 * 1000 }); }
  catch (e) { throw e.status === 404 ? new FetchError('No FPL team with ID ' + entryId, 404) : e; }
  const classic = ((entry.leagues || {}).classic || []).slice()
    .sort((a, b) => (a.league_type === 'x' ? 0 : 1) - (b.league_type === 'x' ? 0 : 1));
  return {
    user: { id: String(entry.id), name: entry.name + ' (' + entry.player_first_name + ' ' + entry.player_last_name + ')' },
    leagues: classic.map((l) => ({ id: String(l.id), name: l.name, rank: l.entry_rank, private: l.league_type === 'x' }))
  };
}

async function load({ entryId, leagueId }) {
  const [bs, fixtures, entry] = await Promise.all([
    bootstrap(),
    getJSON(B + '/fixtures/?future=1', { ttl: 30 * 60 * 1000 }),
    getJSON(B + '/entry/' + encodeURIComponent(entryId) + '/', { ttl: 5 * 60 * 1000 }).catch((e) => {
      throw e.status === 404 ? new FetchError('No FPL team with ID ' + entryId, 404) : e;
    })
  ]);
  const gw = entry.current_event || (bs.events.find((e) => e.is_current) || {}).id || 1;
  const finished = bs.events.filter((e) => e.finished).length;
  const nextEvent = (bs.events.find((e) => e.is_next) || {}).id || gw + 1;
  const runs = fixtureRuns(fixtures, nextEvent);
  const clubs = new Map(bs.teams.map((t) => [t.id, t.short_name]));

  const players = new Map();
  bs.elements.forEach((e) => {
    const r = fplRole(e, finished);
    const run = runs[e.team] || { sched: 'neutral' };
    const p = makePlayer({
      id: e.id, name: e.web_name, team: clubs.get(e.team), pos: POS[e.element_type],
      season: parseFloat(e.points_per_game) || 0, recent: parseFloat(e.form) || 0,
      gp: e.minutes > 0 ? Math.round((e.total_points || 0) / (parseFloat(e.points_per_game) || 1)) : 0,
      health: fplHealth(e), role: r.role, injury: e.status === 'a' ? '' : e.status, news: e.news || '',
      flags: r.why ? [r.why] : [], cost: e.now_cost / 10
    });
    p.sched = run.sched;
    p.club = e.team;
    p.fixtures = run.avg;
    p.owned = parseFloat(e.selected_by_percent) || 0;
    players.set(e.id, p);
  });

  let standings = [], leagueName = 'No league picked';
  if (leagueId) {
    const s = await getJSON(B + '/leagues-classic/' + encodeURIComponent(leagueId) + '/standings/', { ttl: 5 * 60 * 1000 });
    leagueName = (s.league || {}).name || leagueName;
    standings = ((s.standings || {}).results || []).slice(0, MAX_RIVALS);
  }
  if (!standings.some((r) => String(r.entry) === String(entryId))) {
    standings.unshift({ entry: Number(entryId), entry_name: entry.name, player_name: entry.player_first_name + ' ' + entry.player_last_name, rank: null, total: entry.summary_overall_points, event_total: entry.summary_event_points });
  }

  const teams = await Promise.all(standings.map(async (r) => {
    const picks = await getJSON(B + '/entry/' + r.entry + '/event/' + gw + '/picks/', { ttl: 10 * 60 * 1000 }).catch(() => null);
    const list = picks ? picks.picks.map((k) => {
      const p = players.get(k.element);
      return p && Object.assign({}, p, { flags: p.flags.slice(), slot: k.position <= 11 ? 'START' : 'BN', captain: k.is_captain });
    }).filter(Boolean) : [];
    const h = (picks && picks.entry_history) || {};
    return {
      id: String(r.entry), name: r.entry_name, owner: r.player_name, isMine: String(r.entry) === String(entryId),
      rank: r.rank, pointsFor: r.total || 0, lastGw: r.event_total || 0, bank: (h.bank || 0) / 10, value: (h.value || 0) / 10,
      chip: picks && picks.active_chip, players: list
    };
  }));

  const mine = teams.find((t) => t.isMine);
  const owned = new Set(mine ? mine.players.map((p) => p.id) : []);
  const freeAgents = Array.from(players.values()).filter((p) => !owned.has(p.id) && p.season > 0);

  return {
    platform: 'fpl', sport: 'fpl', name: leagueName, season: bs.events[0] ? String(new Date(bs.events[0].deadline_time).getFullYear()) : '',
    week: gw, nextEvent, statsThrough: 'Gameweek ' + finished, scoring: 'FPL points',
    slots: ['GKP', 'DEF', 'DEF', 'DEF', 'MID', 'MID', 'FWD', 'FLEX_OUT', 'FLEX_OUT', 'FLEX_OUT', 'FLEX_OUT'],
    teams, freeAgents, bank: mine ? mine.bank : 0,
    notes: ['Transfer prices use current prices. Your real selling price can be lower if a player rose after you bought him.']
  };
}

module.exports = { listLeagues, load, fixtureRuns, fplHealth, fplRole };

},
"server/analyze.js": function (module, exports, __require, __builtin, __dirname) {
/* League-wide analysis. Takes a normalized league from a connector and returns one report:
   power rankings, positional strengths, lineup fixes, pickups (or FPL transfers), trade ideas and alerts.
   Player values come from engine.js, the same math the Move Check page uses. */
const E = __require("engine.js");
const { round2, RECENT_GAMES } = __require("server/lib/players.js");
const { moveScore, toneFor, LABELS } = __require("server/score.js");

const FORM_W = 0.4;
const ELIG = {
  FLEX: ['RB', 'WR', 'TE'], WRRB_FLEX: ['WR', 'RB'], REC_FLEX: ['WR', 'TE'], SUPER_FLEX: ['QB', 'RB', 'WR', 'TE'],
  FM_FLEX: ['FWD', 'MID'], MD_FLEX: ['MID', 'DEF'], FMD_FLEX: ['FWD', 'MID', 'DEF'],
  G: ['PG', 'SG'], F: ['SF', 'PF'], UTIL: ['PG', 'SG', 'SF', 'PF', 'C'], FLEX_OUT: ['DEF', 'MID', 'FWD']
};
const AVAIL = { healthy: 1, minor: 0.85, short: 0, long: 0 };
const FA_PER_POS = 40;
const STREAM = ['K', 'DST']; // streamed off waivers, never worth a trade

const eligFor = (slot) => ELIG[slot] || (slot.indexOf('/') > 0 ? slot.split('/') : [slot]);
const canPlay = (p, slot) => eligFor(slot).some((x) => (p.elig || [p.pos]).indexOf(x) >= 0);

function gamesLeft(L) {
  if (L.sport === 'fpl') return Math.max(1, Math.min(6, 38 - L.week));
  if (L.sport === 'nfl') return Math.max(1, 17 - L.week);
  if (L.sport === 'epl') return Math.max(1, 38 - L.week);
  const frac = L.platform === 'espn' ? L.week / 175 : L.week / 24;
  return Math.max(5, Math.round(82 * (1 - Math.min(1, frac))));
}

/* Replacement level per position: what the best few free agents score. Fixed defaults for FPL or thin pools. */
function replacement(L, adjust = (p) => p) {
  const repl = Object.assign({}, E.SPORTS[L.sport].repl);
  if (L.sport === 'fpl') return repl;
  const minGp = Math.min(3, Math.max(1, L.week - 1));
  E.SPORTS[L.sport].positions.forEach((pos) => {
    const top = L.freeAgents.filter((p) => p.pos === pos && p.health === 'healthy' && (p.source === 'data' || p.gp >= minGp)).map(adjust)
      .map((p) => p.season * (1 - FORM_W) + p.recent * FORM_W).sort((a, b) => b - a).slice(0, 3);
    if (top.length === 3) repl[pos] = round2(top.reduce((a, b) => a + b, 0) / 3);
  });
  return repl;
}

/* Best lineup for one week. Most restrictive slots fill first; injured players count as zero. */
function bestLineup(players, slots, weekly) {
  const order = slots.map((s, i) => ({ s, i })).sort((a, b) => eligFor(a.s).length - eligFor(b.s).length);
  const used = new Set(), out = new Array(slots.length);
  const pool = players.filter((p) => p.slot !== 'IR').slice().sort((a, b) => weekly(b) - weekly(a));
  order.forEach(({ s, i }) => {
    const p = pool.find((x) => !used.has(x.id) && canPlay(x, s));
    if (p) used.add(p.id);
    out[i] = { slot: s === 'FLEX_OUT' ? 'OUT' : s, player: p || null };
  });
  return out;
}

function fplLineup(players, weekly) {
  const by = (pos) => players.filter((p) => p.pos === pos).sort((a, b) => weekly(b) - weekly(a));
  const xi = [by('GKP')[0], ...by('DEF').slice(0, 3), ...by('MID').slice(0, 2), by('FWD')[0]].filter(Boolean);
  const max = { DEF: 5, MID: 5, FWD: 3 };
  const rest = ['DEF', 'MID', 'FWD'].flatMap((pos) => by(pos).filter((p) => xi.indexOf(p) < 0)).sort((a, b) => weekly(b) - weekly(a));
  for (const p of rest) {
    if (xi.length >= 11) break;
    if (xi.filter((x) => x.pos === p.pos).length < max[p.pos]) xi.push(p);
  }
  return xi.map((p) => ({ slot: p.pos, player: p }));
}

/* Pulls small samples toward a typical player at the position: one game's worth of weight on the prior. */
const SHRINK_K = 1;
function shrink(p, prior, recentN) {
  const gp = p.source === 'data' ? 6 : p.gp || 0;
  if (!(prior > 0) || !gp) return p;
  const rg = Math.min(gp, recentN);
  return Object.assign({}, p, {
    season: (p.season * gp + prior * SHRINK_K) / (gp + SHRINK_K),
    recent: (p.recent * rg + prior * SHRINK_K) / (rg + SHRINK_K)
  });
}

/* Young players are protected from drop suggestions in dynasty and keeper leagues. */
const avgAge = (arr) => { const a = arr.filter((p) => p.age); return a.length ? a.reduce((x, p) => x + p.age, 0) / a.length : 0; };
const isYoung = (p) => (p.yearsExp != null && p.yearsExp <= 1) || (p.age && p.age <= 23);

function analyze(L, opts = {}) {
  const sport = L.sport, S = E.SPORTS[sport];
  const recentN = RECENT_GAMES[sport] || 4;
  const ctx = { G: gamesLeft(L), formW: FORM_W, repl: Object.assign({}, S.repl) };
  const shrunk = new Map();
  const sh = (p) => { if (!shrunk.has(p)) shrunk.set(p, shrink(p, S.repl[p.pos], recentN)); return shrunk.get(p); };
  if (sport !== 'fpl') ctx.repl = replacement(L, (p) => sh(p));
  const val = new Map();
  const v = (p) => { if (!val.has(p)) val.set(p, E.valuePlayer(sh(p), sport, ctx)); return val.get(p); };
  const byes = L.byes || {}, next = L.nextWeek;
  const onBye = (p) => !!next && byes[p.team] === next;
  const byeAhead = (p) => (next && byes[p.team] >= next ? 1 : 0);
  const weekly = (p) => (onBye(p) ? 0 : v(p).ppg * (AVAIL[p.health] != null ? AVAIL[p.health] : 1));
  const ros = (p) => v(p).ppg * Math.max(0, v(p).played - byeAhead(p)) / ctx.G;
  const dynasty = L.type === 'dynasty' || L.type === 'keeper';
  const protect = (p) => dynasty && isYoung(p);

  let me = L.teams.find((t) => t.isMine);
  if (!me && opts.teamId) me = L.teams.find((t) => t.id === String(opts.teamId));
  if (!me) throw Object.assign(new Error('Could not find your team in this league. Pick it from the list.'), { status: 400, teams: L.teams.map((t) => ({ id: t.id, name: t.name, owner: t.owner })) });
  L.teams.forEach((t) => { t.isMine = t === me; });

  /* Lineups and power rankings: strength is the best lineup's average weekly points over the window */
  const active = (t) => t.players.filter((p) => p.slot !== 'IR');
  const lineupOf = (players, score) => (sport === 'fpl' ? fplLineup(players, score) : bestLineup(players, L.slots, score));
  const strengthOf = (players) => lineupOf(players, ros).reduce((a, x) => a + (x.player ? ros(x.player) : 0), 0);
  const posSlots = {};
  S.positions.forEach((pos) => { posSlots[pos] = Math.max(1, L.slots.filter((s) => s === pos).length); });
  if (sport === 'fpl') Object.assign(posSlots, { GKP: 1, DEF: 4, MID: 4, FWD: 2 });

  const teamInfo = L.teams.map((t) => {
    const byPos = {};
    S.positions.forEach((pos) => {
      byPos[pos] = active(t).filter((p) => p.pos === pos).map(ros).sort((a, b) => b - a)
        .slice(0, posSlots[pos]).reduce((a, b) => a + b, 0);
    });
    return { t, strength: strengthOf(active(t)), byPos };
  });
  const ranked = teamInfo.slice().sort((a, b) => b.strength - a.strength);
  /* What an average starting slot scores per week in this league; Move Scores are relative to it. */
  const slotBase = teamInfo.reduce((a, x) => a + x.strength, 0) / teamInfo.length / (sport === 'fpl' ? 11 : Math.max(1, L.slots.length));
  const scored = (m, opts) => { const sc = moveScore(Object.assign({ base: slotBase }, opts)); return Object.assign(m, sc, { label: sc.scoreLabel, tone: toneFor(sc.score) }); };
  const powerRankings = ranked.map((x, i) => ({
    rank: i + 1, id: x.t.id, name: x.t.name, owner: x.t.owner, isMine: x.t.isMine,
    record: sport === 'fpl' ? (x.t.rank ? 'League rank ' + x.t.rank : '') : x.t.wins + '-' + x.t.losses + (x.t.ties ? '-' + x.t.ties : ''),
    pointsFor: round2(x.t.pointsFor || 0), strength: round2(x.strength)
  }));

  const mineInfo = teamInfo.find((x) => x.t === me);
  const usedPos = S.positions.filter((pos) => sport === 'fpl' || L.slots.some((s) => eligFor(s).indexOf(pos) >= 0));
  const positions = usedPos.map((pos) => {
    const all = teamInfo.map((x) => x.byPos[pos]);
    const avg = all.reduce((a, b) => a + b, 0) / all.length;
    const rank = all.filter((n) => n > mineInfo.byPos[pos]).length + 1;
    return { pos, mine: round2(mineInfo.byPos[pos]), leagueAvg: round2(avg), rank, of: all.length, diff: round2(mineInfo.byPos[pos] - avg) };
  });
  const weak = positions.filter((p) => p.rank > Math.ceil(p.of / 2) && p.diff < 0).sort((a, b) => a.diff - b.diff).map((p) => p.pos);
  const strong = positions.filter((p) => p.rank <= Math.ceil(p.of / 3) && p.diff > 0).sort((a, b) => b.diff - a.diff).map((p) => p.pos);

  /* Lineup changes for this week (byes and injuries count as zero) */
  const thisWeek = lineupOf(active(me), weekly);
  const best = thisWeek.filter((x) => x.player).map((x) => x.player);
  const current = me.players.filter((p) => p.slot === 'START');
  const ins = best.filter((p) => current.indexOf(p) < 0).sort((a, b) => weekly(b) - weekly(a));
  const left = current.filter((p) => best.indexOf(p) < 0).sort((a, b) => weekly(a) - weekly(b));
  const why0 = (o) => (onBye(o) ? o.name + ' is on bye.' : AVAIL[o.health] === 0 ? o.name + ' is listed ' + (o.injury || 'out') + '.' : o.health === 'minor' ? o.name + ' is ' + (o.injury || 'questionable') + '.' : '');
  const lineupChanges = ins.map((p) => {
    const pick = (test) => { const i = left.findIndex(test); return i >= 0 ? left.splice(i, 1)[0] : null; };
    const o = pick((x) => x.pos === p.pos) || pick((x) => L.slots.some((s) => canPlay(x, s) && canPlay(p, s))) || pick(() => true);
    const gain = weekly(p) - (o ? weekly(o) : 0);
    const why = [];
    if (o && why0(o)) why.push(why0(o));
    why.push(p.name + ' projects ' + E.fmt(weekly(p)) + ' against ' + (o ? E.fmt(weekly(o)) + ' for ' + o.name : 'an empty slot') + '.');
    return scored({ start: p.name, startPos: p.pos, bench: o ? o.name : null, gain: round2(gain), text: why.join(' ') }, { perWeek: gain, certain: true, health: p.health });
  }).filter((c) => c.gain > 0.2).sort((a, b) => b.score - a.score || b.gain - a.gain);

  /* Free-agent pool: positions your lineup can use, enough games to trust */
  const minGp = sport === 'fpl' ? 0 : Math.min(2, Math.max(1, L.week - 1));
  const pool = [];
  usedPos.forEach((pos) => {
    pool.push(...L.freeAgents.filter((p) => p.pos === pos && (p.source === 'data' || p.gp >= minGp)).sort((a, b) => ros(b) - ros(a)).slice(0, FA_PER_POS));
  });

  /* Pickups: only adds that improve your best lineup over the window. FPL uses transfers instead. */
  let pickups;
  const myActive = active(me);
  const myBase = strengthOf(myActive);
  if (sport === 'fpl') pickups = fplTransfers(me, pool, L.bank || 0, ctx, v).map((m) => scored(m, { perWeek: m.gain / ctx.G, sampleGames: m.gp, health: m.health }));
  else {
    const starters = new Set(lineupOf(myActive, ros).filter((x) => x.player).map((x) => x.player));
    const drops = myActive.filter((p) => !starters.has(p) && !protect(p)).sort((a, b) => ros(a) - ros(b)).slice(0, 4);
    const cands = [];
    pool.filter((f) => f.health === 'healthy' || f.health === 'minor').forEach((f) => {
      drops.forEach((d) => {
        const gain = strengthOf(myActive.filter((p) => p !== d).concat([f])) - myBase;
        if (gain >= 0.5) cands.push({ f, d, gain });
      });
    });
    cands.sort((a, b) => b.gain - a.gain);
    const usedF = new Set(), usedD = new Set(), usedPos = {};
    pickups = [];
    for (const c of cands) {
      if (usedF.has(c.f) || usedD.has(c.d) || (usedPos[c.f.pos] || 0) >= (STREAM.indexOf(c.f.pos) >= 0 ? 1 : 2)) continue;
      usedF.add(c.f); usedD.add(c.d); usedPos[c.f.pos] = (usedPos[c.f.pos] || 0) + 1;
      const s = [c.f.name + ' (' + c.f.pos + ', ' + c.f.team + ') would start for you, adding about ' + E.fmt(c.gain) + ' points a week (' + E.fmt(c.gain * ctx.G, 0) + ' over the next ' + ctx.G + ' weeks).'];
      s.push(c.f.name + ' averages ' + E.fmt(c.f.season) + ' over ' + c.f.gp + ' games, ' + E.fmt(c.f.recent) + ' lately.');
      s.push(c.d.name + ' is your least useful bench player (' + E.fmt(v(c.d).ppg) + ' a game).');
      if (c.f.gp <= 2) s.push('Small sample, so check the role news first.');
      pickups.push(scored({ kind: 'pickup', title: 'Pick up ' + c.f.name + ', drop ' + c.d.name, pos: c.f.pos, gain: c.gain * ctx.G, perWeek: round2(c.gain), text: s.join(' ') }, { perWeek: c.gain, sampleGames: c.f.gp, health: c.f.health }));
      if (pickups.length >= 4) break;
    }
  }

  /* Trades: your lineup must improve; theirs must not get much worse, and the talent swap must look fair to them */
  let trades = [];
  if (sport !== 'fpl') {
    const tradable = (p) => STREAM.indexOf(p.pos) < 0;
    const mineTop = myActive.filter(tradable).sort((a, b) => ros(b) - ros(a)).slice(0, 16);
    const stars = myActive.slice().sort((a, b) => v(b).vor - v(a).vor).slice(0, 3);
    teamInfo.filter((x) => x.t !== me).forEach((x) => {
      const theirActive = active(x.t);
      const theirBase = x.strength;
      const theirTop = theirActive.filter(tradable).sort((a, b) => ros(b) - ros(a)).slice(0, 14);
      const useful = theirTop.filter((p) => strengthOf(myActive.concat([p])) - myBase > 0.3);
      if (!useful.length) return;
      const shapes = [];
      mineTop.forEach((g) => useful.forEach((t) => shapes.push([[g], [t]])));
      E.combos(mineTop, 2).forEach((gg) => useful.forEach((t) => shapes.push([gg, [t]])));
      mineTop.forEach((g) => useful.forEach((t) => theirTop.forEach((t2) => { if (t2 !== t && (useful.indexOf(t2) < 0 || t2.id > t.id)) shapes.push([[g], [t, t2]]); })));
      const found = [];
      shapes.forEach(([give, get]) => {
        const myGain = strengthOf(myActive.filter((p) => give.indexOf(p) < 0).concat(get)) - myBase;
        if (myGain < 1) return;
        const theirGain = strengthOf(theirActive.filter((p) => get.indexOf(p) < 0).concat(give)) - theirBase;
        if (theirGain < -1) return;
        if (dynasty && avgAge(get) - avgAge(give) >= 5) return;
        const fair = E.compareTrade(give.map(sh), get.map(sh), sport, ctx).pct;
        if (fair > 0.35) return;
        found.push({ give, get, myGain, theirGain, fair, score: myGain + Math.min(theirGain, 2) * 0.75 - Math.max(0, fair - 0.1) * 6 });
      });
      found.sort((a, b) => b.score - a.score);
      const seen = new Set();
      found.filter((c) => {
        const kg = 'g' + c.give.map((p) => p.id).join(','), kt = 't' + c.get.map((p) => p.id).join(',');
        if (seen.has(kg) || seen.has(kt)) return false;
        seen.add(kg); seen.add(kt); return true;
      }).slice(0, 2).forEach((c) => {
        const names = (arr) => arr.map((p) => p.name + (dynasty && p.age ? ' (' + p.age + ')' : '')).join(' and ');
        const s = ['Your best lineup gains about ' + E.fmt(c.myGain) + ' points a week (' + E.fmt(c.myGain * ctx.G, 0) + ' over ' + ctx.G + ' weeks).'];
        s.push(c.theirGain >= 0.3 ? 'Their lineup also improves by ' + E.fmt(c.theirGain) + ' a week, so it is a real win-win pitch.'
          : c.theirGain > -0.3 ? 'Their lineup stays about the same, so they are trading depth they do not start.'
          : 'Their lineup drops ' + E.fmt(-c.theirGain) + ' a week, so expect some pushback.');
        const theirWeak = positions.filter((q) => x.byPos[q.pos] < q.leagueAvg).map((q) => q.pos);
        const fills = c.give.filter((p) => theirWeak.indexOf(p.pos) >= 0).map((p) => p.pos);
        if (fills.length) s.push(x.t.name + ' is below average at ' + Array.from(new Set(fills)).join(' and ') + ', which you are sending.');
        if (dynasty) {
          const ga = avgAge(c.give), ta = avgAge(c.get);
          if (ga && ta && ta - ga >= 3) s.push('Dynasty check: you are getting older (' + E.fmt(ta, 0) + ' vs ' + E.fmt(ga, 0) + ' on average). Good for this year, weaker later.');
          if (c.give.some(isYoung)) s.push('Dynasty check: you are giving up a young player, so weigh their future value.');
        }
        trades.push(scored({ kind: 'trade',
          title: 'Offer ' + names(c.give) + ' for ' + names(c.get), pos: c.get[0].pos, gain: c.myGain * ctx.G, perWeek: round2(c.myGain), theirPerWeek: round2(c.theirGain),
          give: c.give.map((p) => p.name), get: c.get.map((p) => p.name), partner: x.t.name, partnerId: x.t.id, rank: c.score, text: s.join(' ') },
          { perWeek: c.myGain, theirPerWeek: c.theirGain, givesYoung: dynasty && c.give.some(isYoung), givesStar: c.give.some((p) => stars.indexOf(p) >= 0) }));
      });
    });
    trades.sort((a, b) => b.rank - a.rank);
    const uses = new Map();
    trades = trades.filter((m) => {
      if (m.give.some((p) => (uses.get(p) || 0) >= 2)) return false;
      m.give.forEach((p) => uses.set(p, (uses.get(p) || 0) + 1));
      return true;
    }).slice(0, 6);
  }

  /* FPL: captain and rival ownership */
  let fpl = null;
  if (sport === 'fpl') {
    const xi = thisWeek.map((x) => x.player).sort((a, b) => weekly(b) - weekly(a));
    const rivals = L.teams.filter((t) => t !== me && t.players.length);
    const count = new Map();
    rivals.forEach((t) => t.players.forEach((p) => count.set(p.id, (count.get(p.id) || 0) + 1)));
    const myIds = new Set(me.players.map((p) => p.id));
    const share = (p) => (rivals.length ? (count.get(p.id) || 0) / rivals.length : 0);
    const seen = new Map();
    rivals.forEach((t) => t.players.forEach((p) => seen.set(p.id, p)));
    fpl = {
      captain: xi.slice(0, 2).map((p) => ({ name: p.name, team: p.team, weekly: round2(weekly(p)), fixtures: p.fixtures })),
      bank: L.bank, rivals: rivals.length,
      threats: Array.from(seen.values()).filter((p) => !myIds.has(p.id) && share(p) >= 0.4)
        .sort((a, b) => share(b) * weekly(b) - share(a) * weekly(a)).slice(0, 5)
        .map((p) => ({ name: p.name, team: p.team, pos: p.pos, cost: p.cost, ownedByRivals: Math.round(share(p) * 100), weekly: round2(weekly(p)) })),
      differentials: me.players.filter((p) => share(p) <= 0.2 && p.slot === 'START')
        .map((p) => ({ name: p.name, team: p.team, pos: p.pos, ownedByRivals: Math.round(share(p) * 100), weekly: round2(weekly(p)) }))
    };
  }

  /* Alerts */
  const alerts = [];
  me.players.forEach((p) => {
    if (p.slot === 'START' && onBye(p)) alerts.push(p.name + ' is in your lineup but ' + p.team + ' are on bye in week ' + next + '.');
    else if (p.slot === 'START' && AVAIL[p.health] === 0) alerts.push(p.name + ' is in your lineup but listed ' + (p.injury || 'out') + (p.news ? ' (' + p.news + ')' : '') + '.');
    else if (p.slot === 'START' && p.health === 'minor') alerts.push(p.name + ' is ' + (p.injury || 'questionable') + (p.news ? ' (' + p.news + ')' : '') + '. Check before kickoff.');
    if (p.slot === 'START' && !p.gp && p.source !== 'data') alerts.push('No games logged for ' + p.name + ' yet, so these numbers undervalue that player.');
  });
  if (sport === 'nfl' && next) {
    const upcoming = {};
    myActive.forEach((p) => { if (byes[p.team] > next && byes[p.team] <= next + 3 && best.indexOf(p) >= 0) (upcoming[byes[p.team]] = upcoming[byes[p.team]] || []).push(p.name); });
    Object.keys(upcoming).forEach((w) => { if (upcoming[w].length >= 2) alerts.push('Bye crunch in week ' + w + ': ' + upcoming[w].join(', ') + ' are all off. Plan cover now.'); });
  }
  if (sport === 'fpl' && fpl.captain[0]) alerts.push('Captain pick by these numbers: ' + fpl.captain[0].name + (fpl.captain[1] ? ', then ' + fpl.captain[1].name : '') + '.');

  const roster = me.players.map((p) => ({
    name: p.name, team: p.team, pos: p.pos, slot: p.slot, season: p.season, recent: p.recent, gp: p.gp,
    health: p.health, injury: p.injury, news: p.news, role: p.role, sched: p.sched, cost: p.cost, age: p.age, bye: byes[p.team] || null,
    ppg: round2(v(p).ppg), weekly: round2(weekly(p)), vor: round2(v(p).vor), risk: v(p).riskLvl, flags: p.flags
  })).sort((a, b) => b.vor - a.vor);

  const topFree = pool.slice().sort((a, b) => v(b).vor - v(a).vor).slice(0, 12)
    .map((p) => ({ name: p.name, team: p.team, pos: p.pos, ppg: round2(v(p).ppg), season: p.season, recent: p.recent, gp: p.gp, health: p.health, cost: p.cost, age: p.age }));

  return {
    league: { platform: L.platform, sport, sportName: S.name, name: L.name, season: L.season, statsThrough: L.statsThrough, scoring: L.scoring, teams: L.teams.length, waiver: L.waiver, type: L.type || 'redraft', nextWeek: next || null, notes: L.notes || [] },
    me: { id: me.id, name: me.name, owner: me.owner },
    teams: L.teams.map((t) => ({ id: t.id, name: t.name, owner: t.owner })),
    window: { games: ctx.G, per: S.per, replacement: ctx.repl },
    powerRankings, positions, weak, strong,
    lineup: { best: thisWeek.map((x) => ({ slot: x.slot, name: x.player ? x.player.name : null, pos: x.player ? x.player.pos : null, weekly: x.player ? round2(weekly(x.player)) : 0, bye: x.player ? onBye(x.player) : false })), changes: lineupChanges },
    pickups: pickups.map((m) => Object.assign({}, m, { gain: round2(m.gain) })).sort((a, b) => b.score - a.score),
    trades: trades.map((m) => Object.assign({}, m, { gain: round2(m.gain) })).sort((a, b) => b.score - a.score),
    moveScale: { base: round2(slotBase), labels: LABELS.slice(1) },
    fpl, alerts, roster, topFree
  };
}

/* FPL transfers: same position, affordable with the bank, at most 3 players per club. */
function fplTransfers(me, pool, bank, ctx, v) {
  const clubCount = {};
  me.players.forEach((p) => { clubCount[p.club] = (clubCount[p.club] || 0) + 1; });
  const cands = [];
  me.players.forEach((d) => {
    pool.forEach((f) => {
      if (f.pos !== d.pos || f.cost > d.cost + bank + 1e-9) return;
      if (f.club !== d.club && (clubCount[f.club] || 0) >= 3) return;
      const r = E.compareWaiver(f, d, 'free', 'fpl', ctx);
      if (r.edge > 0 && (r.key === 'strong' || r.key === 'add')) cands.push({ f, d, r });
    });
  });
  cands.sort((a, b) => b.r.edge - a.r.edge);
  const usedF = new Set(), usedD = new Set(), out = [];
  for (const c of cands) {
    if (usedF.has(c.f.id) || usedD.has(c.d.id)) continue;
    usedF.add(c.f.id); usedD.add(c.d.id);
    const spend = round2(c.f.cost - c.d.cost);
    const s = [c.f.name + ' projects ' + E.fmt(c.r.a.ppg) + ' a gameweek against ' + E.fmt(c.r.d.ppg) + ' for ' + c.d.name + ', about ' + E.fmt(c.r.edge, 0) + ' points over the next ' + ctx.G + ' gameweeks.'];
    s.push(spend > 0 ? 'Costs £' + spend.toFixed(1) + 'm of your £' + bank.toFixed(1) + 'm bank.' : 'Frees up £' + (-spend).toFixed(1) + 'm.');
    if (c.f.sched === 'easy') s.push(c.f.team + ' have an easy run (average difficulty ' + c.f.fixtures + ').');
    if (c.d.sched === 'tough') s.push(c.d.team + ' have a tough run (average difficulty ' + c.d.fixtures + ').');
    if (c.r.edge >= 4 + c.r.bar) s.push('Worth it even as a −4 hit.');
    E.flags(c.d, c.r.d, c.d.name).filter((t) => /below|miss|rotation|fringe|tough/.test(t)).slice(0, 1).forEach((t) => s.push(t));
    out.push({ kind: 'transfer', title: 'Sell ' + c.d.name + ', buy ' + c.f.name, pos: c.f.pos, gain: c.r.edge, cost: c.f.cost, gp: c.f.gp, health: c.f.health, text: s.join(' ') });
    if (out.length >= 3) break;
  }
  return out;
}

module.exports = { analyze, bestLineup, fplLineup, fplTransfers, gamesLeft, replacement, canPlay, shrink };

},
"server/score.js": function (module, exports, __require, __builtin, __dirname) {
/* Move Score: every suggested move gets a 1-30 score with its own label.
   Base: weekly lineup gain as a share of an average starter in this league, then
   confidence adjustments (sample size, injury, how likely the other manager says yes, dynasty cost). */

const LABELS = [null,
  'Never do this', 'Hurts your team', 'Clear downgrade', 'Downgrade', 'Slight downgrade',
  'Not worth the move', 'A wash at best', 'Coin flip, lean no', 'Coin flip', 'Marginal',
  'Depth only', 'Small edge', 'Minor upgrade', 'Worth a look', 'Solid idea',
  'Good move', 'Good move, act soon', 'Strong move', 'Strong, make it a priority', 'Clear upgrade',
  'Clear upgrade, do it this week', 'Big upgrade', 'Big upgrade, top priority', 'Major upgrade', 'Major upgrade, do not wait',
  'Impact move', 'Impact move, act today', 'League-winning move', 'Must do', 'Must do now'];

/* perWeek: lineup points gained per week. base: points an average starting slot scores per week. */
function moveScore({ perWeek, base, certain = false, sampleGames = null, health = 'healthy', theirPerWeek = null, givesYoung = false, givesStar = false }) {
  const pct = base > 0 ? perWeek / base : 0;
  let s = 8 + 30 * pct;
  const why = [];
  if (certain) { s += 2; why.push('no cost to make'); }
  if (sampleGames != null && sampleGames <= 2) { s -= 3; why.push('only ' + sampleGames + (sampleGames === 1 ? ' game' : ' games') + ' played'); }
  if (health === 'minor') { s -= 2; why.push('injury doubt'); }
  if (theirPerWeek != null && theirPerWeek < -0.5) { s -= 2; why.push('hard to get accepted'); }
  if (theirPerWeek != null && theirPerWeek >= 0.3) { s += 1; why.push('helps them too'); }
  if (givesYoung) { s -= 2; why.push('costs a young player'); }
  if (givesStar) { s -= 3; why.push('gives up one of your three best players'); }
  const score = Math.max(1, Math.min(30, Math.round(s)));
  return { score, scoreLabel: LABELS[score], scoreWhy: why };
}

const toneFor = (score) => (score >= 18 ? 'good' : score >= 10 ? 'warn' : 'bad');

module.exports = { moveScore, toneFor, LABELS };

},
"server/notes.js": function (module, exports, __require, __builtin, __dirname) {
/* Coach notes written from a report's Move Scores, so every user gets a plain-language plan with no AI needed. */

const fmt = (n) => (Math.round(n * 10) / 10).toFixed(1);
const lead = (m) => '**' + m.score + '/30 · ' + m.label + ':** ';
const why = (m) => (m.scoreWhy && m.scoreWhy.length && m.score < 18 ? ' (' + m.scoreWhy.join(', ') + ')' : '');
const lower = (s) => s.charAt(0).toLowerCase() + s.slice(1);

function writeNotes(r) {
  const L = r.league, soccer = L.sport === 'epl' || L.sport === 'fpl';
  const out = [];
  const week = L.nextWeek ? (soccer ? 'Gameweek ' : 'Week ') + L.nextWeek : 'next ' + (soccer ? 'gameweek' : 'week');

  out.push('### This week (' + week + ')');
  const changes = r.lineup.changes.slice(0, 6);
  changes.forEach((c) => out.push('- ' + lead(c) + 'start ' + c.start + (c.bench ? ' over ' + c.bench : '') + ' (+' + fmt(c.gain) + ').'));
  const notices = r.alerts.filter((a) => !/^Captain pick/.test(a)).slice(0, 4);
  notices.forEach((a) => out.push('- ' + a));
  if (r.fpl && r.fpl.captain[0]) out.push('- Captain ' + r.fpl.captain[0].name + (r.fpl.captain[1] ? ', vice-captain ' + r.fpl.captain[1].name : '') + '.');
  if (!changes.length && !notices.length) out.push('- Your best lineup is already set.');

  out.push('', '### ' + (L.sport === 'fpl' ? 'Transfers' : 'Waivers'));
  const adds = r.pickups.slice(0, 3);
  adds.forEach((m) => {
    const perWeek = m.perWeek != null ? m.perWeek : m.gain / Math.max(1, r.window.games);
    out.push('- ' + lead(m) + lower(m.title) + ' (+' + fmt(perWeek) + ' a ' + r.window.per + ')' + why(m) + '.');
  });
  if (!adds.length) out.push('- No ' + (L.sport === 'fpl' ? 'transfer' : 'free agent') + ' clearly beats a player you have.');

  if (L.sport !== 'fpl') {
    out.push('', '### Trades');
    const good = r.trades.filter((m) => m.score >= 10).slice(0, 2);
    good.forEach((m) => out.push('- ' + lead(m) + lower(m.title) + ' with ' + m.partner + why(m) + '.'));
    if (!good.length) out.push('- No trade scores 10 or higher. Hold.');
  }

  if (r.weak.length || r.strong.length) {
    out.push('', '### Longer term');
    const mine = r.powerRankings.find((p) => p.isMine);
    out.push('- ' + (mine ? 'Ranked ' + mine.rank + ' of ' + r.powerRankings.length + ' by projected lineup. ' : '') +
      (r.weak.length ? 'Thin at ' + r.weak.join(' and ') + '. ' : '') + (r.strong.length ? 'Deep at ' + r.strong.join(' and ') + ', your trade currency.' : ''));
  }

  out.push('', '*Move Scores run 1–30; the key is at the bottom of the page.*');
  return out.join('\n');
}

module.exports = { writeNotes };

}
};
var cache = {};
function __builtin() { return null; }
function __require(id) {
  if (cache[id]) return cache[id].exports;
  var module = cache[id] = { exports: {} };
  defs[id](module, module.exports, __require, __builtin, "");
  return module.exports;
}
__require("web/entry.js");
})();
