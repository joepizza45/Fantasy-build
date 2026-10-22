/* Coach notes written from a report's Move Scores, so every user gets a plain-language plan with no AI needed. */

const fmt = (n) => (Math.round(n * 10) / 10).toFixed(1);
const lead = (m) => '**' + m.score + '/30 · ' + m.label + ':** ';
const why = (m) => (m.scoreWhy && m.scoreWhy.length && m.score < 18 ? ' (' + m.scoreWhy.join(', ') + ')' : '');
const lower = (s) => s.charAt(0).toLowerCase() + s.slice(1);

function writeNotes(r) {
  const L = r.league, soccer = L.sport === 'epl' || L.sport === 'fpl';
  const out = [];
  const week = L.nextWeek ? (soccer ? 'Gameweek ' : 'Week ') + L.nextWeek : 'next ' + (soccer ? 'gameweek' : 'week');

  out.push('### This week (' + week + ')');
  const changes = r.lineup.changes.slice(0, 6);
  changes.forEach((c) => out.push('- ' + lead(c) + 'start ' + c.start + (c.bench ? ' over ' + c.bench : '') + ' (+' + fmt(c.gain) + ').'));
  const notices = r.alerts.filter((a) => !/^Captain pick/.test(a)).slice(0, 4);
  notices.forEach((a) => out.push('- ' + a));
  if (r.fpl && r.fpl.captain[0]) out.push('- Captain ' + r.fpl.captain[0].name + (r.fpl.captain[1] ? ', vice-captain ' + r.fpl.captain[1].name : '') + '.');
  if (!changes.length && !notices.length) out.push('- Your best lineup is already set.');

  out.push('', '### ' + (L.sport === 'fpl' ? 'Transfers' : 'Waivers'));
  const adds = r.pickups.slice(0, 3);
  adds.forEach((m) => {
    const perWeek = m.perWeek != null ? m.perWeek : m.gain / Math.max(1, r.window.games);
    out.push('- ' + lead(m) + lower(m.title) + ' (+' + fmt(perWeek) + ' a ' + r.window.per + ')' + why(m) + '.');
  });
  if (!adds.length) out.push('- No ' + (L.sport === 'fpl' ? 'transfer' : 'free agent') + ' clearly beats a player you have.');

  if (L.sport !== 'fpl') {
    out.push('', '### Trades');
    const good = r.trades.filter((m) => m.score >= 10).slice(0, 2);
    good.forEach((m) => out.push('- ' + lead(m) + lower(m.title) + ' with ' + m.partner + why(m) + '.'));
    if (!good.length) out.push('- No trade scores 10 or higher. Hold.');
  }

  if (r.weak.length || r.strong.length) {
    out.push('', '### Longer term');
    const mine = r.powerRankings.find((p) => p.isMine);
    out.push('- ' + (mine ? 'Ranked ' + mine.rank + ' of ' + r.powerRankings.length + ' by projected lineup. ' : '') +
      (r.weak.length ? 'Thin at ' + r.weak.join(' and ') + '. ' : '') + (r.strong.length ? 'Deep at ' + r.strong.join(' and ') + ', your trade currency.' : ''));
  }

  out.push('', '*Move Scores run 1–30; the key is at the bottom of the page.*');
  return out.join('\n');
}

module.exports = { writeNotes };
