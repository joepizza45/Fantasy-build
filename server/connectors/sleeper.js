/* Sleeper (NFL and NBA). Public read-only API, no login: https://docs.sleeper.com */
const { getJSON, FetchError } = require('../lib/fetch');
const { averages, fillFromData, healthFrom, makePlayer } = require('../lib/players');
const { SPORTS } = require('../../engine');
const { byeWeeks } = require('../lib/nfl');

const B = 'https://api.sleeper.app/v1';
const HOUR = 3600 * 1000;
const SEASON_WEEKS = { nfl: 18, nba: 25 };
const SKILL = ['RB', 'WR', 'TE'];
const BENCH_SLOTS = ['BN', 'IR', 'TAXI'];

const toPos = (sport, raw) => {
  let p = String(raw || '').toUpperCase();
  if (sport === 'nfl' && p === 'DEF') p = 'DST';
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
  const st = await getJSON(B + '/state/' + sport, { ttl: 10 * 60 * 1000 });
  const season = st.league_season || st.season;
  let leagues = await getJSON(B + '/user/' + u.user_id + '/leagues/' + sport + '/' + season, { ttl: 10 * 60 * 1000 });
  if (!leagues || !leagues.length) leagues = await getJSON(B + '/user/' + u.user_id + '/leagues/' + sport + '/' + st.previous_season, { ttl: HOUR });
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
  const sport = league.sport === 'nba' ? 'nba' : 'nfl';
  const [rosters, users, st, db] = await Promise.all([
    getJSON(B + '/league/' + leagueId + '/rosters', { ttl: 5 * 60 * 1000 }),
    getJSON(B + '/league/' + leagueId + '/users', { ttl: HOUR }),
    getJSON(B + '/state/' + sport, { ttl: 10 * 60 * 1000 }),
    getJSON(B + '/players/' + sport, { ttl: 24 * HOUR, disk: true, timeout: 120000 })
  ]);

  const season = String(league.season);
  const current = String(st.league_season || st.season) === season;
  let lastWeek = SEASON_WEEKS[sport];
  if (current) lastWeek = st.season_type === 'regular' ? Math.max(0, (st.week || 1) - 1) : st.season_type === 'pre' ? 0 : SEASON_WEEKS[sport];
  const weeks = [];
  for (let w = 1; w <= lastWeek; w++) weeks.push(w);
  const weekStats = await Promise.all(weeks.map((w) =>
    getJSON(B + '/stats/' + sport + '/regular/' + season + '/' + w, { ttl: w < lastWeek ? 24 * HOUR : HOUR, disk: true, timeout: 60000 }).catch(() => ({}))));

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
    const p = makePlayer({ id, name, team: d.team || 'FA', pos, elig: elig.length ? elig : [pos], age: d.age, yearsExp: d.years_exp, season: a.season, recent: a.recent, gp: a.gp, health: healthFrom(injury), role, injury, news, flags, slot });
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
  const slots = (league.roster_positions || []).filter((s) => BENCH_SLOTS.indexOf(s) < 0).map((s) => (s === 'DEF' ? 'DST' : s));
  const recLabel = sport === 'nfl' ? ({ 1: 'PPR', 0.5: 'Half PPR', 0: 'Standard' }[scoring.rec || 0] || scoring.rec + ' per catch') : 'league points';
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
