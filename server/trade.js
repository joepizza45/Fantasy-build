/* Trade analyzer: scores any trade between you and one other team, using the league's own numbers
   (the report's tradeModel). Runs on the server and in the browser. */
const { bestLineup, fplLineup } = require('./lineup');
const { moveScore, toneFor } = require('./score');

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
