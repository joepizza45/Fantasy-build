/* ESPN Fantasy (NFL "ffl", NBA "fba"). Unofficial v3 API. Public leagues work as is;
   private leagues need the espn_s2 and SWID cookies from a logged-in browser. */
const { getJSON, FetchError } = require('../lib/fetch');
const { averages, fillFromData, healthFrom, makePlayer } = require('../lib/players');

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
    notes: ['ESPN data comes from an unofficial API and can change without notice.']
  };
}

module.exports = { load, weeksFrom };
