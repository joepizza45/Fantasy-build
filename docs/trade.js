/* Fantasy Coach web bundle. Built by scripts/build-web.js; edit the sources, not this file. */
(function () {
var defs = {
"web/trade-entry.js": function (module, exports, __require, __builtin, __dirname) {
/* Browser entry for the trade analyzer, loaded by every Fantasy Coach page as trade.js. */
window.FantasyTrade = __require("server/trade.js");

},
"server/trade.js": function (module, exports, __require, __builtin, __dirname) {
/* Trade analyzer: scores any trade between you and one other team, using the league's own numbers
   (the report's tradeModel). Runs on the server and in the browser. */
const { bestLineup, fplLineup } = __require("server/lineup.js");
const { moveScore, toneFor } = __require("server/score.js");

const r1 = (n) => (Math.round(n * 10) / 10).toFixed(1);
const names = (ps) => ps.map((p) => p.name).join(', ') || 'nothing';

function strength(model, players) {
  const ros = (p) => p.ros;
  const lu = model.sport === 'fpl' ? fplLineup(players, ros) : bestLineup(players, model.slots, ros);
  return { total: lu.reduce((a, x) => a + (x.player ? x.player.ros : 0), 0), starters: new Set(lu.filter((x) => x.player).map((x) => x.player.id)) };
}

function evaluateTrade(model, { partnerId, giveIds = [], getIds = [] }) {
  const me = model.teams.find((t) => t.id === model.myId);
  const them = model.teams.find((t) => t.id === String(partnerId));
  if (!me || !them) throw new Error('Pick a team to trade with');
  const give = me.players.filter((p) => giveIds.indexOf(p.id) >= 0);
  const get = them.players.filter((p) => getIds.indexOf(p.id) >= 0);
  if (!give.length || !get.length) return null;

  const active = (ps) => ps.filter((p) => p.slot !== 'IR');
  const myBefore = strength(model, active(me.players));
  const myAfter = strength(model, active(me.players.filter((p) => give.indexOf(p) < 0).concat(get)));
  const theirBefore = strength(model, active(them.players));
  const theirAfter = strength(model, active(them.players.filter((p) => get.indexOf(p) < 0).concat(give)));
  const myGain = myAfter.total - myBefore.total, theirGain = theirAfter.total - theirBefore.total;

  const value = (ps) => ps.reduce((a, p) => a + Math.max(0, p.vor), 0);
  const giveValue = value(give), getValue = value(get);
  const stars = me.players.slice().sort((a, b) => b.vor - a.vor).slice(0, 3);
  const sc = moveScore({
    perWeek: myGain, base: model.slotBase, theirPerWeek: theirGain,
    givesYoung: model.dynasty && give.some((p) => p.young), givesStar: give.some((p) => stars.indexOf(p) >= 0)
  });

  const valueRatio = Math.max(giveValue, getValue) > 0 ? giveValue / Math.max(getValue, 0.01) : 1;
  const accept = theirGain >= 0.3 || (theirGain > -0.5 && valueRatio >= 0.95) ? 'Likely'
    : theirGain > -1.5 && valueRatio >= 0.75 ? 'Possible' : 'Unlikely';

  const reasons = [];
  reasons.push('Your best lineup ' + (myGain >= 0 ? 'gains ' : 'loses ') + r1(Math.abs(myGain)) + ' points a ' + model.per + ' (' + r1(Math.abs(myGain * model.G)) + ' over the next ' + model.G + ' ' + model.per + 's).');
  const newStarters = get.filter((p) => myAfter.starters.has(p.id)).map((p) => p.name);
  const lostStarters = give.filter((p) => myBefore.starters.has(p.id)).map((p) => p.name);
  if (newStarters.length) reasons.push(newStarters.join(' and ') + ' would start' + ' for you.');
  else reasons.push('None of the players you get would crack your starting lineup.');
  if (lostStarters.length) reasons.push('You lose ' + lostStarters.length + ' current starter' + (lostStarters.length > 1 ? 's' : '') + ': ' + lostStarters.join(', ') + '.');
  reasons.push(them.name + "'s lineup " + (theirGain >= 0 ? 'gains ' : 'loses ') + r1(Math.abs(theirGain)) + ' a ' + model.per + '. Chance they accept: ' + accept.toLowerCase() + '.');
  reasons.push('By value over replacement you give ' + Math.round(giveValue) + ' and get ' + Math.round(getValue) + '.');
  get.filter((p) => p.health !== 'healthy').forEach((p) => reasons.push(p.name + ' is listed ' + (p.injury || p.health) + '.'));
  if (model.dynasty) {
    const age = (ps) => { const a = ps.filter((p) => p.age); return a.length ? a.reduce((x, p) => x + p.age, 0) / a.length : 0; };
    const ga = age(give), ta = age(get);
    if (ga && ta && Math.abs(ta - ga) >= 2) reasons.push('Dynasty: you get ' + (ta > ga ? 'older' : 'younger') + ' (' + r1(ta) + ' against ' + r1(ga) + ' on average).');
    give.filter((p) => p.young).forEach((p) => reasons.push('Dynasty: ' + p.name + ' is young, so weigh future value.'));
  }
  if (get.length !== give.length) {
    const diff = get.length - give.length;
    reasons.push(diff > 0 ? 'You take on ' + diff + ' extra player' + (diff > 1 ? 's' : '') + ', so you will need to drop someone.' : 'You open ' + (-diff) + ' roster spot' + (-diff > 1 ? 's' : '') + ' for a waiver pickup.');
  }
  if (sc.scoreWhy.length) reasons.push('Score adjustments: ' + sc.scoreWhy.join(', ') + '.');

  return Object.assign({
    title: 'Give ' + names(give) + ', get ' + names(get), partner: them.name, giveIds: give.map((p) => p.id), getIds: get.map((p) => p.id),
    myGain: Math.round(myGain * 100) / 100, theirGain: Math.round(theirGain * 100) / 100, accept,
    giveValue: Math.round(giveValue), getValue: Math.round(getValue), tone: toneFor(sc.score), reasons
  }, sc, { label: sc.scoreLabel });
}

/* Trade finder. With players picked on one side only, tries every 1- and 2-player package from the
   other side and returns the best-scoring deals that gain at least half a point a week and have a fair chance of acceptance. */
const STREAM = ['K', 'DST'];
const pairs = (arr) => { const out = arr.map((a) => [a]); arr.forEach((a, i) => arr.slice(i + 1).forEach((b) => out.push([a, b]))); return out; };

function findOffers(model, { partnerId, giveIds = [], getIds = [] }, limit = 5) {
  const me = model.teams.find((t) => t.id === model.myId), them = model.teams.find((t) => t.id === String(partnerId));
  if (!me || !them || (!giveIds.length) === (!getIds.length)) return [];
  const pool = (t, taken) => t.players.filter((p) => p.slot !== 'IR' && STREAM.indexOf(p.pos) < 0 && taken.indexOf(p.id) < 0)
    .sort((a, b) => b.vor - a.vor).slice(0, 12);
  const searchMine = !giveIds.length;
  const options = pairs(searchMine ? pool(me, []) : pool(them, getIds));
  const rank = { Likely: 2, Possible: 1, Unlikely: 0 };
  return options.map((pkg) => evaluateTrade(model, {
    partnerId, giveIds: searchMine ? pkg.map((p) => p.id) : giveIds, getIds: searchMine ? getIds : pkg.map((p) => p.id)
  })).filter((r) => r && r.myGain >= 0.5 && r.accept !== 'Unlikely')
    .sort((a, b) => b.score - a.score || rank[b.accept] - rank[a.accept] || b.myGain - a.myGain)
    .slice(0, limit);
}

module.exports = { evaluateTrade, findOffers };

},
"server/lineup.js": function (module, exports, __require, __builtin, __dirname) {
/* Lineup helpers shared by the analysis and the trade analyzer: which players fit which slots,
   and the best lineup a roster can field. */
const ELIG = {
  FLEX: ['RB', 'WR', 'TE'], WRRB_FLEX: ['WR', 'RB'], REC_FLEX: ['WR', 'TE'], SUPER_FLEX: ['QB', 'RB', 'WR', 'TE'],
  FM_FLEX: ['FWD', 'MID'], MD_FLEX: ['MID', 'DEF'], FMD_FLEX: ['FWD', 'MID', 'DEF'],
  G: ['PG', 'SG'], F: ['SF', 'PF'], UTIL: ['PG', 'SG', 'SF', 'PF', 'C'], FLEX_OUT: ['DEF', 'MID', 'FWD']
};
const eligFor = (slot) => ELIG[slot] || (slot.indexOf('/') > 0 ? slot.split('/') : [slot]);
const canPlay = (p, slot) => eligFor(slot).some((x) => (p.elig || [p.pos]).indexOf(x) >= 0);

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

module.exports = { ELIG, eligFor, canPlay, bestLineup, fplLineup };

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
__require("web/trade-entry.js");
})();
