/* League-wide analysis. Takes a normalized league from a connector and returns one report:
   power rankings, positional strengths, lineup fixes, pickups (or FPL transfers), trade ideas and alerts.
   Player values come from engine.js, the same math the Move Check page uses. */
const E = require('../engine');
const { round2, RECENT_GAMES } = require('./lib/players');

const FORM_W = 0.4;
const ELIG = {
  FLEX: ['RB', 'WR', 'TE'], WRRB_FLEX: ['WR', 'RB'], REC_FLEX: ['WR', 'TE'], SUPER_FLEX: ['QB', 'RB', 'WR', 'TE'],
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
    return { start: p.name, startPos: p.pos, bench: o ? o.name : null, gain: round2(gain), text: why.join(' ') };
  }).filter((c) => c.gain > 0.2).sort((a, b) => b.gain - a.gain);

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
  if (sport === 'fpl') pickups = fplTransfers(me, pool, L.bank || 0, ctx, v);
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
      pickups.push({ kind: 'pickup', label: c.gain >= 2 ? 'Strong add' : 'Add', tone: 'good', title: 'Pick up ' + c.f.name + ', drop ' + c.d.name, pos: c.f.pos, gain: c.gain * ctx.G, perWeek: round2(c.gain), text: s.join(' ') });
      if (pickups.length >= 4) break;
    }
  }

  /* Trades: your lineup must improve; theirs must not get much worse, and the talent swap must look fair to them */
  let trades = [];
  if (sport !== 'fpl') {
    const tradable = (p) => STREAM.indexOf(p.pos) < 0;
    const mineTop = myActive.filter(tradable).sort((a, b) => ros(b) - ros(a)).slice(0, 16);
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
        trades.push({ kind: 'trade', label: c.theirGain >= 0.3 ? 'Win-win' : 'Worth offering', tone: 'good',
          title: 'Offer ' + names(c.give) + ' for ' + names(c.get), pos: c.get[0].pos, gain: c.myGain * ctx.G, perWeek: round2(c.myGain), theirPerWeek: round2(c.theirGain),
          give: c.give.map((p) => p.name), get: c.get.map((p) => p.name), partner: x.t.name, partnerId: x.t.id, score: c.score, text: s.join(' ') });
      });
    });
    trades.sort((a, b) => b.score - a.score);
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

module.exports = { analyze, bestLineup, fplLineup, fplTransfers, gamesLeft, replacement, canPlay, shrink };
