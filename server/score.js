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
