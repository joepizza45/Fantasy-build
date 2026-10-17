/* NFL bye weeks, from ESPN's public pro-team schedule (no login needed). Keys use Sleeper's team codes. */
const { getJSON } = require('./fetch');

const ALIAS = { WSH: 'WAS', JAC: 'JAX' };

async function byeWeeks(season) {
  try {
    const j = await getJSON('https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/' + season + '?view=proTeamSchedules_wl', { ttl: 24 * 3600 * 1000, disk: true });
    const out = {};
    ((j.settings || {}).proTeams || []).forEach((t) => {
      const ab = String(t.abbrev || '').toUpperCase();
      if (t.byeWeek > 0) { out[ALIAS[ab] || ab] = t.byeWeek; out[ab] = t.byeWeek; }
    });
    return out;
  } catch (e) { return {}; }
}

module.exports = { byeWeeks };
