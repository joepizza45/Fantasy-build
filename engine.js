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
    seasonLbl: 'Season avg', recentLbl: 'Last 10 games avg' }
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
