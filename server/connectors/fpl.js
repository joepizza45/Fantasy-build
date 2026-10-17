/* Fantasy Premier League (classic). Public API, no login needed for teams, picks and league standings. */
const { getJSON, FetchError } = require('../lib/fetch');
const { healthFrom, makePlayer, round2 } = require('../lib/players');

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
