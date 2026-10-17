/* Helpers that turn platform data into the engine's player shape:
   { id, name, team, pos, season, recent, gp, health, role, sched, injury, news, flags } */
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', '..', 'data');
const RECENT_GAMES = { nfl: 4, nba: 10, fpl: 4 };

const normName = (s) => String(s || '').toLowerCase()
  .normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/\b(jr|sr|ii|iii|iv|v)\b\.?/g, '').replace(/[^a-z0-9]+/g, ' ').trim();

const round2 = (n) => Math.round(n * 100) / 100;

/* weeks: [{ pts, gp }] oldest first. Season = points per game; recent = per game over the last N games. */
function averages(weeks, sport) {
  const played = weeks.filter((w) => w.gp > 0);
  const gp = played.reduce((a, w) => a + w.gp, 0);
  if (!gp) return { season: 0, recent: 0, gp: 0 };
  const total = played.reduce((a, w) => a + w.pts, 0);
  const want = RECENT_GAMES[sport] || 4;
  let rp = 0, rg = 0;
  for (let i = played.length - 1; i >= 0 && rg < want; i--) { rp += played[i].pts; rg += played[i].gp; }
  return { season: round2(Math.max(0, total / gp)), recent: round2(Math.max(0, rp / rg)), gp };
}

const dataCache = {};
function dataFile(sport) {
  if (sport in dataCache) return dataCache[sport];
  let out = null;
  try {
    const j = JSON.parse(fs.readFileSync(path.join(DATA_DIR, sport + '.json'), 'utf8'));
    const by = new Map();
    (j.players || []).forEach((p) => { if (p && p.name) by.set(normName(p.name) + '|' + (p.pos || ''), p); if (p && p.name && !by.has(normName(p.name))) by.set(normName(p.name), p); });
    out = { fetched: String(j.fetched_at || '').slice(0, 10), through: j.through || '', by, players: j.players || [] };
  } catch (e) { out = null; }
  dataCache[sport] = out;
  return out;
}

/* Fill a player with no games this season from data/<sport>.json, when the repo has a matching entry. */
function fillFromData(p, sport) {
  if (p.gp > 0) return p;
  const d = dataFile(sport);
  const m = d && (d.by.get(normName(p.name) + '|' + p.pos) || d.by.get(normName(p.name)));
  if (!m || !Number.isFinite(m.season)) return p;
  p.season = Math.max(0, m.season);
  p.recent = Number.isFinite(m.recent) ? Math.max(0, m.recent) : p.season;
  if (p.health === 'healthy' && m.health) p.health = m.health;
  if (p.role === 'steady' && m.role) p.role = m.role;
  if (!p.news && m.news) p.news = m.news;
  p.source = 'data';
  p.flags.push('Numbers from data/' + sport + '.json (' + (d.through || d.fetched) + '), not from your league.');
  return p;
}

/* Maps an injury designation from any platform to the engine's health keys. */
function healthFrom(status) {
  const t = String(status || '').trim().toLowerCase().replace(/_/g, ' ');
  if (!t || t === 'active' || t === 'normal' || t === 'a' || t === 'healthy') return 'healthy';
  if (/^(q|questionable|probable|p|day[- ]?to[- ]?day|dtd|gtd|d)$/.test(t)) return 'minor';
  if (/^(doubtful|out|o|sus|suspension|suspended|covid|cov)$/.test(t)) return 'short';
  if (/^(ir|injury reserve|injured reserve|pup|na|nfi|dnr|il|out for season|ofs)$/.test(t)) return 'long';
  return 'minor';
}

function makePlayer(o) {
  return {
    id: String(o.id), name: o.name || 'Unknown', team: o.team || '', pos: o.pos,
    season: o.season || 0, recent: o.recent || 0, gp: o.gp || 0,
    health: o.health || 'healthy', role: o.role || 'steady', sched: 'neutral',
    injury: o.injury || '', news: o.news || '', flags: o.flags || [], source: o.source || 'league',
    cost: o.cost, slot: o.slot, elig: o.elig || [o.pos]
  };
}

module.exports = { averages, dataFile, fillFromData, healthFrom, makePlayer, normName, round2, RECENT_GAMES };
