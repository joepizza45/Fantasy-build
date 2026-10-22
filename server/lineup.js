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
