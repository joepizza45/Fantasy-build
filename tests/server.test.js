/* Run with: node --test tests/ */
const test = require('node:test');
const assert = require('node:assert/strict');
const { averages, healthFrom, makePlayer } = require('../server/lib/players');
const { points, snapRole } = require('../server/connectors/sleeper');
const { weeksFrom } = require('../server/connectors/espn');
const { fixtureRuns, fplHealth } = require('../server/connectors/fpl');
const { analyze, bestLineup, fplLineup, fplTransfers } = require('../server/analyze');
const E = require('../engine');

const P = (o) => Object.assign(makePlayer(Object.assign({ gp: 5, season: 10, recent: 10 }, o)), { club: o.club });

test('averages: per game, recent window counts games not weeks', () => {
  const a = averages([{ pts: 20, gp: 1 }, { pts: 0, gp: 0 }, { pts: 10, gp: 1 }, { pts: 30, gp: 1 }], 'nfl');
  assert.equal(a.gp, 3); assert.equal(a.season, 20); assert.equal(a.recent, 20);
  const nba = averages([{ pts: 90, gp: 3 }, { pts: 120, gp: 4 }, { pts: 60, gp: 2 }, { pts: 40, gp: 1 }], 'nba');
  assert.equal(nba.season, 31); assert.equal(nba.recent, 31);
  assert.deepEqual(averages([], 'nfl'), { season: 0, recent: 0, gp: 0 });
});

test('healthFrom maps platform designations', () => {
  assert.equal(healthFrom(''), 'healthy'); assert.equal(healthFrom('ACTIVE'), 'healthy');
  assert.equal(healthFrom('Questionable'), 'minor'); assert.equal(healthFrom('DAY_TO_DAY'), 'minor');
  assert.equal(healthFrom('Out'), 'short'); assert.equal(healthFrom('Sus'), 'short');
  assert.equal(healthFrom('IR'), 'long'); assert.equal(healthFrom('INJURY_RESERVE'), 'long');
});

test('sleeper points use league scoring, fall back to Sleeper totals', () => {
  assert.equal(points({ rec: 6, rec_yd: 124, rec_td: 2 }, { rec: 1, rec_yd: 0.1, rec_td: 6 }, 'nfl'), 30.4);
  assert.equal(points({ pts_half_ppr: 12.5, pts_ppr: 15 }, { rec: 0.5, idp_tkl: 1 }, 'nfl'), 12.5);
});

test('snapRole flags low and rising snap shares', () => {
  const w = (s) => ({ gp: 1, snaps: s, tmSnaps: 100 });
  assert.equal(snapRole([w(20), w(25), w(22)]).role, 'fringe');
  assert.equal(snapRole([w(30), w(30), w(70), w(75), w(80)]).role, 'rising');
  assert.equal(snapRole([w(80), w(85)]), null);
});

test('espn weeksFrom keeps only this season actual weekly lines', () => {
  const stats = [
    { seasonId: 2026, statSourceId: 0, statSplitTypeId: 1, scoringPeriodId: 2, appliedTotal: 20 },
    { seasonId: 2026, statSourceId: 0, statSplitTypeId: 1, scoringPeriodId: 1, appliedTotal: 10 },
    { seasonId: 2026, statSourceId: 1, statSplitTypeId: 1, scoringPeriodId: 3, appliedTotal: 99 },
    { seasonId: 2025, statSourceId: 0, statSplitTypeId: 1, scoringPeriodId: 1, appliedTotal: 99 },
    { seasonId: 2026, statSourceId: 0, statSplitTypeId: 0, scoringPeriodId: 0, appliedTotal: 99 }
  ];
  assert.deepEqual(weeksFrom({ stats }, 2026), [{ pts: 10, gp: 1 }, { pts: 20, gp: 1 }]);
});

test('fpl fixture runs and health', () => {
  const runs = fixtureRuns([{ event: 8, team_h: 1, team_a: 2, team_h_difficulty: 2, team_a_difficulty: 4 }, { event: 20, team_h: 1, team_a: 2, team_h_difficulty: 5, team_a_difficulty: 5 }], 8);
  assert.equal(runs[1].sched, 'easy'); assert.equal(runs[2].sched, 'tough');
  assert.equal(fplHealth({ status: 'd', chance_of_playing_next_round: 75 }), 'minor');
  assert.equal(fplHealth({ status: 'i', news: 'Knee injury - Unknown return date' }), 'long');
});

test('bestLineup fills restrictive slots first and skips injured players', () => {
  const rb1 = P({ id: 1, pos: 'RB', season: 15 }), rb2 = P({ id: 2, pos: 'RB', season: 12 }), wr = P({ id: 3, pos: 'WR', season: 14 });
  const hurt = P({ id: 4, pos: 'WR', season: 30, health: 'short' }), te = P({ id: 5, pos: 'TE', season: 6 });
  const weekly = (p) => (p.health === 'short' ? 0 : p.season);
  const lu = bestLineup([rb1, rb2, wr, hurt, te], ['FLEX', 'RB', 'WR', 'TE'], weekly);
  assert.deepEqual(lu.map((x) => x.player && x.player.id), ['2', '1', '3', '5']);
});

test('fplLineup keeps a legal formation', () => {
  const mk = (pos, n, pts) => Array.from({ length: n }, (_, i) => P({ id: pos + i, pos, season: pts - i }));
  const squad = [...mk('GKP', 2, 4), ...mk('DEF', 5, 3), ...mk('MID', 5, 9), ...mk('FWD', 3, 8)];
  const xi = fplLineup(squad, (p) => p.season).map((x) => x.player.pos);
  const n = (pos) => xi.filter((x) => x === pos).length;
  assert.equal(xi.length, 11); assert.equal(n('GKP'), 1); assert.ok(n('DEF') >= 3); assert.ok(n('MID') <= 5); assert.ok(n('FWD') <= 3);
});

test('fplTransfers respects bank and the three-per-club rule', () => {
  const ctx = { G: 6, formW: 0.4, repl: E.SPORTS.fpl.repl };
  const mine = [P({ id: 'a', pos: 'MID', season: 2, recent: 2, cost: 5, club: 1 }), P({ id: 'b', pos: 'MID', season: 5, cost: 6, club: 5 }), P({ id: 'c', pos: 'DEF', season: 4, cost: 4.5, club: 2 }), P({ id: 'e', pos: 'GKP', season: 4, cost: 4.5, club: 2 }), P({ id: 'd', pos: 'DEF', season: 4, cost: 4.5, club: 2 })];
  const pool = [P({ id: 'x', pos: 'MID', season: 9, recent: 9, cost: 9, club: 3 }), P({ id: 'y', pos: 'MID', season: 7, recent: 7, cost: 5.5, club: 2 }), P({ id: 'z', pos: 'MID', season: 6, recent: 6, cost: 5.4, club: 4 })];
  const v = (p) => E.valuePlayer(p, 'fpl', ctx);
  const out = fplTransfers({ players: mine }, pool, 0.5, ctx, v);
  assert.equal(out[0].title, 'Sell ' + mine[0].name + ', buy ' + pool[2].name);
  assert.ok(!out.some((m) => m.cost === 9), 'unaffordable player suggested');
  assert.ok(!out.some((m) => m.cost === 5.5), 'fourth player from one club suggested');
});

test('analyze produces a full report from a small league', () => {
  const team = (id, mine, base) => ({ id, name: 'T' + id, owner: 'o' + id, isMine: mine, wins: 1, losses: 1, ties: 0, pointsFor: 100,
    players: ['QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'RB', 'WR'].map((pos, i) => P({ id: id + '-' + i, name: 'P' + id + i, pos, season: base + i, recent: base + i + (mine ? -2 : 2), slot: i < 6 ? 'START' : 'BN' })) });
  const L = { platform: 'sleeper', sport: 'nfl', name: 'Test', season: '2026', week: 5, statsThrough: 'Week 5', scoring: 'PPR',
    slots: ['QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'FLEX'], teams: [team('1', true, 8), team('2', false, 9), team('3', false, 10)],
    freeAgents: ['QB', 'RB', 'WR', 'TE'].flatMap((pos) => [1, 2, 3, 4].map((i) => P({ id: 'fa' + pos + i, name: 'FA ' + pos + i, pos, season: 5 + i * 3, recent: 6 + i * 3 }))) };
  const r = analyze(L);
  assert.equal(r.me.id, '1'); assert.equal(r.window.games, 12);
  assert.equal(r.powerRankings.length, 3);
  assert.ok(r.positions.find((p) => p.pos === 'QB'));
  assert.ok(r.lineup.best.every((x) => x.name));
  assert.ok(Array.isArray(r.pickups) && Array.isArray(r.trades));
  r.trades.forEach((t) => { assert.ok(Array.isArray(t.give) && typeof t.give[0] === 'string'); });
  assert.doesNotThrow(() => JSON.stringify(r));
  assert.throws(() => analyze(Object.assign({}, L, { teams: L.teams.map((t) => Object.assign({}, t, { isMine: false })) })), /Could not find your team/);
});

test('shrink pulls small samples harder than large ones', () => {
  const { shrink } = require('../server/analyze');
  const one = shrink(P({ pos: 'QB', season: 30, recent: 30, gp: 1 }), 16, 4);
  const five = shrink(P({ pos: 'QB', season: 30, recent: 30, gp: 5 }), 16, 4);
  assert.equal(one.season, 23); assert.ok(five.season > 27 && five.season < 30);
  assert.equal(shrink(P({ season: 10, gp: 0, source: 'data' }), 8, 4).season > 9.5, true);
  assert.equal(shrink(P({ season: 0, recent: 0, gp: 0 }), 8, 4).season, 0);
});

test('moveScore maps gains to labeled 1-30 scores', () => {
  const { moveScore, LABELS } = require('../server/score');
  assert.equal(LABELS.length, 31);
  const big = moveScore({ perWeek: 20, base: 15 }), none = moveScore({ perWeek: -20, base: 15 });
  assert.equal(big.score, 30); assert.equal(big.scoreLabel, 'Must do now');
  assert.equal(none.score, 1); assert.equal(none.scoreLabel, 'Never do this');
  const mid = moveScore({ perWeek: 3, base: 15 }), risky = moveScore({ perWeek: 3, base: 15, sampleGames: 1, givesStar: true });
  assert.equal(mid.score, 14); assert.equal(risky.score, 8); assert.deepEqual(risky.scoreWhy, ['only 1 game played', 'gives up one of your three best players']);
});

test('writeNotes leads every move with its Move Score', () => {
  const { writeNotes } = require('../server/notes');
  const move = (score, label, title) => ({ score, label, title, perWeek: 3, scoreWhy: [] });
  const r = {
    league: { sport: 'nfl', nextWeek: 7 }, window: { games: 10, per: 'week' },
    lineup: { changes: [Object.assign(move(30, 'Must do now'), { start: 'A', bench: 'B', gain: 12 })] },
    alerts: ['X is on bye.'], pickups: [move(16, 'Good move', 'Pick up C, drop D')],
    trades: [move(8, 'Coin flip, lean no', 'Offer E for F')], fpl: null,
    weak: ['RB'], strong: [], powerRankings: [{ isMine: true, rank: 3 }]
  };
  const n = writeNotes(r);
  assert.match(n, /\*\*30\/30 · Must do now:\*\* start A over B \(\+12\.0\)/);
  assert.match(n, /\*\*16\/30 · Good move:\*\* pick up C, drop D/);
  assert.match(n, /No trade scores 10 or higher/);
  assert.match(n, /X is on bye/);
});

test('web bundle builds and exposes the browser API', () => {
  const { bundle } = require('../scripts/build-web');
  const path = require('path');
  const code = bundle(path.join(__dirname, '..', 'web', 'entry.js'));
  const window = {};
  new Function('window', 'fetch', code)(window, () => Promise.reject(new Error('offline')));
  assert.deepEqual(Object.keys(window.FantasyCoach), ['leagues', 'analyze']);
  return window.FantasyCoach.leagues({ platform: 'fpl', entryId: '1' }).then(() => assert.fail('FPL should be refused'), (e) => assert.match(e.message, /self-hosted/));
});

test('evaluateTrade scores a trade from both lineups', () => {
  const { evaluateTrade } = require('../server/trade');
  const pl = (id, pos, ros, extra) => Object.assign({ id, name: id, pos, elig: [pos], ros, vor: ros * 5, health: 'healthy', slot: 'START', young: false }, extra);
  const model = {
    sport: 'nfl', slots: ['RB', 'WR'], G: 10, per: 'week', slotBase: 12, dynasty: false, myId: 'me',
    teams: [
      { id: 'me', name: 'Mine', players: [pl('rb1', 'RB', 8), pl('wr1', 'WR', 16), pl('wr2', 'WR', 14, { slot: 'BN' })] },
      { id: 'them', name: 'Theirs', players: [pl('rb2', 'RB', 15), pl('wr3', 'WR', 6)] }
    ]
  };
  const r = evaluateTrade(model, { partnerId: 'them', giveIds: ['wr2'], getIds: ['rb2'] });
  assert.equal(r.myGain, 7);
  assert.equal(r.theirGain, -7, 'they lose their only RB');
  assert.equal(r.accept, 'Unlikely');
  assert.ok(r.score >= 20 && r.score < 26, 'big gain, minus 2 for being hard to get accepted: ' + r.score);
  assert.ok(r.scoreWhy.indexOf('hard to get accepted') >= 0);
  assert.match(r.reasons.join(' '), /rb2 would start for you/);
  assert.equal(evaluateTrade(model, { partnerId: 'them', giveIds: [], getIds: ['rb2'] }), null);
});
