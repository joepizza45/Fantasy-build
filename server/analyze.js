/* League-wide analysis. Takes a normalized league from a connector and returns one report:
   power rankings, positional strengths, lineup fixes, pickups (or FPL transfers), trade ideas and alerts.
   Player values come from engine.js, the same math the Move Check page uses. */
const E = require('../engine');
const { round2 } = require('./lib/players');

const FORM_W = 0.4;
const ELIG = {
  FLEX: ['RB', 'WR', 'TE'], WRRB_FLEX: ['WR', 'RB'], REC_FLEX: ['WR', 'TE'], SUPER_FLEX: ['QB', 'RB', 'WR', 'TE'],
  G: ['PG', 'SG'], F: ['SF', 'PF'], UTIL: ['PG', 'SG', 'SF', 'PF', 'C'], FLEX_OUT: ['DEF', 'MID', 'FWD']
};
const AVAIL = { healthy: 1, minor: 0.85, short: 0, long: 0 };
const FA_PER_POS = 40;

const eligFor = (slot) => ELIG[slot] || (slot.indexOf('/') > 0 ? slot.split('/') : [slot]);
const canPlay = (p, slot) => eligFor(slot).some((x) => (p.elig || [p.pos]).indexOf(x) >= 0);

function gamesLeft(L) {
  if (L.sport === 'fpl') return Math.max(1, Math.min(6, 38 - L.week));
  if (L.sport === 'nfl') return Math.max(1, 17 - L.week);
  const frac = L.platform === 'espn' ? L.week / 175 : L.week / 24;
  return Math.max(5, Math.round(82 * (1 - Math.min(1, frac))));
}

/* Replacement level per position: what the best few free agents score. Fixed defaults for FPL or thin pools. */
function replacement(L) {
  const repl = Object.assign({}, E.SPORTS[L.sport].repl);
  if (L.sport === 'fpl') return repl;
  E.SPORTS[L.sport].positions.forEach((pos) => {
    const top = L.freeAgents.filter((p) => p.pos === pos && p.health === 'healthy')
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

function analyze(L, opts = {}) {
  const sport = L.sport, S = E.SPORTS[sport];
  const ctx = { G: gamesLeft(L), formW: FORM_W, repl: replacement(L) };
  const val = new Map();
  const v = (p) => { if (!val.has(p)) val.set(p, E.valuePlayer(p, sport, ctx)); return val.get(p); };
  const weekly = (p) => v(p).ppg * (AVAIL[p.health] != null ? AVAIL[p.health] : 1);
  const ros = (p) => v(p).ppg * (v(p).played / ctx.G);

  let me = L.teams.find((t) => t.isMine);
  if (!me && opts.teamId) me = L.teams.find((t) => t.id === String(opts.teamId));
  if (!me) throw Object.assign(new Error('Could not find your team in this league. Pick it from the list.'), { status: 400, teams: L.teams.map((t) => ({ id: t.id, name: t.name, owner: t.owner })) });
  me.isMine = true;

  /* Lineups and power rankings */
  const lineupOf = (t) => (sport === 'fpl' ? fplLineup(t.players, weekly) : bestLineup(t.players, L.slots, weekly));
  const posSlots = {};
  S.positions.forEach((pos) => { posSlots[pos] = Math.max(1, L.slots.filter((s) => s === pos).length); });
  if (sport === 'fpl') Object.assign(posSlots, { GKP: 1, DEF: 4, MID: 4, FWD: 2 });

  const teamInfo = L.teams.map((t) => {
    const lu = lineupOf(t);
    const strength = lu.reduce((a, x) => a + (x.player ? ros(x.player) : 0), 0);
    const byPos = {};
    S.positions.forEach((pos) => {
      byPos[pos] = t.players.filter((p) => p.pos === pos && p.slot !== 'IR').map(ros).sort((a, b) => b - a)
        .slice(0, posSlots[pos]).reduce((a, b) => a + b, 0);
    });
    return { t, lu, strength, byPos };
  });
  const ranked = teamInfo.slice().sort((a, b) => b.strength - a.strength);
  const powerRankings = ranked.map((x, i) => ({
    rank: i + 1, id: x.t.id, name: x.t.name, owner: x.t.owner, isMine: x.t.isMine,
    record: sport === 'fpl' ? (x.t.rank ? 'League rank ' + x.t.rank : '') : x.t.wins + '-' + x.t.losses + (x.t.ties ? '-' + x.t.ties : ''),
    pointsFor: round2(x.t.pointsFor || 0), strength: round2(x.strength)
  }));

  const mineInfo = teamInfo.find((x) => x.t === me);
  const positions = S.positions.filter((pos) => sport !== 'nfl' || L.slots.indexOf(pos) >= 0 || pos === 'RB' || pos === 'WR').map((pos) => {
    const all = teamInfo.map((x) => x.byPos[pos]);
    const avg = all.reduce((a, b) => a + b, 0) / all.length;
    const rank = all.filter((n) => n > mineInfo.byPos[pos]).length + 1;
    return { pos, mine: round2(mineInfo.byPos[pos]), leagueAvg: round2(avg), rank, of: all.length, diff: round2(mineInfo.byPos[pos] - avg) };
  });
  const weak = positions.filter((p) => p.rank > Math.ceil(p.of / 2) && p.diff < 0).sort((a, b) => a.diff - b.diff).map((p) => p.pos);
  const strong = positions.filter((p) => p.rank <= Math.ceil(p.of / 3) && p.diff > 0).sort((a, b) => b.diff - a.diff).map((p) => p.pos);

  /* Lineup changes for my team */
  const best = mineInfo.lu.filter((x) => x.player).map((x) => x.player);
  const current = me.players.filter((p) => p.slot === 'START');
  const ins = best.filter((p) => current.indexOf(p) < 0).sort((a, b) => weekly(b) - weekly(a));
  const outs = current.filter((p) => best.indexOf(p) < 0).sort((a, b) => weekly(a) - weekly(b));
  const left = outs.slice();
  const lineupChanges = ins.map((p) => {
    const pick = (test) => { const i = left.findIndex(test); return i >= 0 ? left.splice(i, 1)[0] : null; };
    const o = pick((x) => x.pos === p.pos) || pick((x) => L.slots.some((s) => canPlay(x, s) && canPlay(p, s))) || pick(() => true);
    const gain = weekly(p) - (o ? weekly(o) : 0);
    const why = [];
    if (o && AVAIL[o.health] === 0) why.push(o.name + ' is listed ' + (o.injury || 'out') + '.');
    else if (o && o.health === 'minor') why.push(o.name + ' is ' + (o.injury || 'questionable') + '.');
    why.push(p.name + ' projects ' + E.fmt(weekly(p)) + ' against ' + (o ? E.fmt(weekly(o)) + ' for ' + o.name : 'an empty slot') + '.');
    return { start: p.name, startPos: p.pos, bench: o ? o.name : null, gain: round2(gain), text: why.join(' ') };
  }).filter((c) => c.gain > 0.2).sort((a, b) => b.gain - a.gain);

  /* Pickups or transfers */
  const pool = [];
  S.positions.forEach((pos) => {
    pool.push(...L.freeAgents.filter((p) => p.pos === pos).sort((a, b) => ros(b) - ros(a)).slice(0, FA_PER_POS));
  });
  const pickups = sport === 'fpl' ? fplTransfers(me, pool, L.bank || 0, ctx, v) : E.pickupMoves(me.players.filter((p) => p.slot !== 'IR'), pool, sport, ctx);

  /* Trades */
  let trades = [];
  if (sport !== 'fpl') {
    const myTradable = me.players.filter((p) => p.slot !== 'IR');
    teamInfo.filter((x) => x.t !== me).forEach((x) => {
      const theirWeak = positions.filter((q) => x.byPos[q.pos] < q.leagueAvg).map((q) => q.pos);
      E.tradeMoves(myTradable, x.t.players.filter((p) => p.slot !== 'IR'), sport, ctx).slice(0, 2).forEach((m) => {
        const fitsMe = weak.indexOf(m.pos) >= 0;
        const helpsThem = m.give.some((p) => theirWeak.indexOf(p.pos) >= 0);
        const extra = [];
        if (fitsMe) extra.push('It fills your thinnest spot (' + m.pos + ').');
        if (helpsThem) extra.push(x.t.name + ' is thin where you are giving, so they have a reason to say yes.');
        trades.push(Object.assign({}, m, { give: m.give.map((p) => p.name), get: m.get.map((p) => p.name), partner: x.t.name, partnerId: x.t.id, fit: (fitsMe ? 2 : 0) + (helpsThem ? 1 : 0), text: m.text + (extra.length ? ' ' + extra.join(' ') : '') }));
      });
    });
    trades.sort((a, b) => b.fit - a.fit || b.gain - a.gain);
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
    const xi = mineInfo.lu.map((x) => x.player).sort((a, b) => weekly(b) - weekly(a));
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
    if (p.slot === 'START' && AVAIL[p.health] === 0) alerts.push(p.name + ' is in your lineup but listed ' + (p.injury || 'out') + (p.news ? ' (' + p.news + ')' : '') + '.');
    else if (p.slot === 'START' && p.health === 'minor') alerts.push(p.name + ' is ' + (p.injury || 'questionable') + (p.news ? ' (' + p.news + ')' : '') + '. Check before kickoff.');
    if (p.slot === 'START' && !p.gp && p.source !== 'data') alerts.push('No games logged for ' + p.name + ' yet, so these numbers undervalue that player.');
  });
  if (sport === 'fpl' && fpl.captain[0]) alerts.push('Captain pick by these numbers: ' + fpl.captain[0].name + (fpl.captain[1] ? ', then ' + fpl.captain[1].name : '') + '.');

  const roster = me.players.map((p) => ({
    name: p.name, team: p.team, pos: p.pos, slot: p.slot, season: p.season, recent: p.recent, gp: p.gp,
    health: p.health, injury: p.injury, news: p.news, role: p.role, sched: p.sched, cost: p.cost,
    ppg: round2(v(p).ppg), weekly: round2(weekly(p)), vor: round2(v(p).vor), risk: v(p).riskLvl, flags: p.flags
  })).sort((a, b) => b.vor - a.vor);

  const topFree = pool.slice().sort((a, b) => v(b).vor - v(a).vor).slice(0, 12)
    .map((p) => ({ name: p.name, team: p.team, pos: p.pos, ppg: round2(v(p).ppg), season: p.season, recent: p.recent, health: p.health, cost: p.cost }));

  return {
    league: { platform: L.platform, sport, sportName: S.name, name: L.name, season: L.season, statsThrough: L.statsThrough, scoring: L.scoring, teams: L.teams.length, waiver: L.waiver, notes: L.notes || [] },
    me: { id: me.id, name: me.name, owner: me.owner },
    teams: L.teams.map((t) => ({ id: t.id, name: t.name, owner: t.owner })),
    window: { games: ctx.G, per: S.per, replacement: ctx.repl },
    powerRankings, positions, weak, strong,
    lineup: { best: mineInfo.lu.map((x) => ({ slot: x.slot, name: x.player ? x.player.name : null, pos: x.player ? x.player.pos : null, weekly: x.player ? round2(weekly(x.player)) : 0 })), changes: lineupChanges },
    pickups: pickups.map((m) => Object.assign({}, m, { gain: round2(m.gain) })),
    trades: trades.map((m) => Object.assign({}, m, { gain: round2(m.gain) })),
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
    out.push({ kind: 'transfer', label: c.r.label, tone: c.r.tone, title: 'Sell ' + c.d.name + ', buy ' + c.f.name, pos: c.f.pos, gain: c.r.edge, cost: c.f.cost, text: s.join(' ') });
    if (out.length >= 3) break;
  }
  return out;
}

module.exports = { analyze, bestLineup, fplLineup, fplTransfers, gamesLeft, replacement, canPlay };
