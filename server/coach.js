/* AI coach. Sends the computed report to an OpenAI-compatible chat endpoint (OmniRoute by default)
   and asks for advice grounded in those numbers. */

const config = () => ({
  url: (process.env.OMNIROUTE_URL || 'http://localhost:20128/v1').replace(/\/+$/, ''),
  key: process.env.OMNIROUTE_API_KEY || '',
  model: process.env.OMNIROUTE_MODEL || 'auto'
});

/* Keeps the prompt small: only what the advice needs. */
function brief(report) {
  const r = report;
  return {
    league: r.league, me: r.me, window: r.window,
    powerRankings: r.powerRankings.slice(0, 16),
    positions: r.positions, weakPositions: r.weak, strongPositions: r.strong,
    lineupChanges: r.lineup.changes,
    bestLineup: r.lineup.best,
    pickupsOrTransfers: r.pickups.map((m) => ({ title: m.title, label: m.label, gain: Math.round(m.gain), text: m.text })),
    trades: r.trades.map((m) => ({ title: m.title, partner: m.partner, gain: Math.round(m.gain), text: m.text })),
    fpl: r.fpl, alerts: r.alerts,
    myRoster: r.roster.slice(0, 30).map((p) => ({ name: p.name, team: p.team, pos: p.pos, slot: p.slot, age: p.age, bye: p.bye, season: p.season, recent: p.recent, games: p.gp, health: p.health, injury: p.injury, news: p.news, role: p.role, ppg: p.ppg, vor: p.vor, cost: p.cost })),
    bestFreeAgents: r.topFree
  };
}

function system(report) {
  const L = report.league;
  return [
    'You are a sharp, practical fantasy ' + L.sportName + ' advisor. The user manages "' + report.me.name + '" in "' + L.name + '" on ' + L.platform + '.',
    'You get a JSON analysis made from the league\'s live data: projections per ' + report.window.per + ', value over replacement for the next ' + report.window.games + ' ' + report.window.per + 's, positional ranks, and moves that a scoring model already checked.',
    (L.type === 'dynasty' || L.type === 'keeper' ? 'This is a ' + L.type + ' league: weigh age and long-term value in trades and drops, not just this season.\n' : '') +
    (L.nextWeek ? 'The next games are week ' + L.nextWeek + '. "bye" on a player is that player\'s bye week; mention upcoming bye crunches.\n' : '') +
    'Rules: use only players, teams and numbers that appear in the JSON. Never invent stats, injuries or news. If something is uncertain or the data is thin, say so in a few words.',
    'Lead with the most important action. Be specific: name players, give the numbers that justify each move, and say who to target in trades and why that manager might accept.',
    'Use short Markdown: a heading per section (This week, Waivers' + (L.sport === 'fpl' ? ' and transfers' : '') + ', Trades, Longer term), bullet points, under 300 words unless the user asks for more.'
  ].join('\n');
}

async function chat(report, messages, { signal } = {}) {
  const c = config();
  const body = {
    model: c.model,
    temperature: 0.4,
    max_tokens: Number(process.env.OMNIROUTE_MAX_TOKENS) || 4000,
    messages: [
      { role: 'system', content: system(report) },
      { role: 'user', content: 'League analysis JSON:\n' + JSON.stringify(brief(report)) },
      ...(messages && messages.length ? messages : [{ role: 'user', content: 'Give me my tips and moves for this week.' }])
    ]
  };
  let res;
  try {
    res = await fetch(c.url + '/chat/completions', {
      method: 'POST', signal,
      headers: { 'Content-Type': 'application/json', ...(c.key ? { Authorization: 'Bearer ' + c.key } : {}) },
      body: JSON.stringify(body)
    });
  } catch (e) {
    throw Object.assign(new Error('Could not reach the AI gateway at ' + c.url + '. Start OmniRoute (npm install -g omniroute, then run omniroute) or set OMNIROUTE_URL.'), { status: 502 });
  }
  const text = await res.text();
  let j = null;
  try { j = JSON.parse(text); } catch (e) { /* not JSON */ }
  if (!res.ok) {
    const msg = (j && j.error && (j.error.message || j.error)) || text.slice(0, 300);
    const hint = res.status === 401 ? ' Set OMNIROUTE_API_KEY to a key from the OmniRoute dashboard (Endpoints).' : '';
    throw Object.assign(new Error('AI gateway answered ' + res.status + ': ' + msg + hint), { status: 502 });
  }
  const content = j && j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
  if (!content) {
    const cut = j && j.choices && j.choices[0] && j.choices[0].finish_reason === 'length';
    throw Object.assign(new Error(cut ? 'The model used its whole reply budget before answering. Raise OMNIROUTE_MAX_TOKENS or pick a non-reasoning model.' : 'The AI gateway returned no text.'), { status: 502 });
  }
  return { text: content, model: j.model || c.model };
}

async function status() {
  const c = config();
  try {
    const res = await fetch(c.url + '/models', { headers: c.key ? { Authorization: 'Bearer ' + c.key } : {}, signal: AbortSignal.timeout(4000) });
    return { url: c.url, model: c.model, keySet: !!c.key, reachable: true, ok: res.ok, status: res.status };
  } catch (e) {
    return { url: c.url, model: c.model, keySet: !!c.key, reachable: false };
  }
}

module.exports = { chat, status, brief, system, config };
