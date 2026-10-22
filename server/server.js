/* Fantasy Coach server. No dependencies: node server/server.js, then open http://localhost:8787 */
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
loadEnv(path.join(ROOT, '.env'));

const { leagues, analyzeLeague } = require('./api');
const coach = require('./coach');

const PORT = Number(process.env.PORT) || 8787;
const HOST = process.env.HOST || '127.0.0.1';
let tradeBundle = null;
const tradeJs = () => tradeBundle || (tradeBundle = require('../scripts/build-web').bundle(path.join(ROOT, 'web', 'trade-entry.js')));
const STATIC = { '/': 'coach.html', '/coach.html': 'coach.html', '/index.html': 'coach.html' };
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8' };
const MAX_BODY = 2 * 1024 * 1024;

function loadEnv(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) { return; }
  text.split(/\r?\n/).forEach((line) => {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/i);
    if (m && !line.trim().startsWith('#') && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  });
}

const send = (res, status, body) => {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
};

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > MAX_BODY) { reject(Object.assign(new Error('Request too large'), { status: 413 })); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch (e) { reject(Object.assign(new Error('Body is not JSON'), { status: 400 })); } });
    req.on('error', reject);
  });
}

async function route(req, res) {
  const url = new URL(req.url, 'http://localhost');
  if (req.method === 'GET' && url.pathname === '/trade.js') { res.writeHead(200, { 'Content-Type': TYPES['.js'], 'Cache-Control': 'no-cache' }); return res.end(tradeJs()); }
  if (req.method === 'GET' && url.pathname === '/trade.html') {
    res.writeHead(200, { 'Content-Type': TYPES['.html'], 'Cache-Control': 'no-cache' });
    return res.end(require('../scripts/build-web').tradePage(fs.readFileSync(path.join(ROOT, 'coach.html'), 'utf8')));
  }
  if (req.method === 'GET' && STATIC[url.pathname]) return serveFile(res, STATIC[url.pathname]);
  if (req.method === 'GET' && /^\/data\/[a-z]+\.json$/.test(url.pathname)) return serveFile(res, url.pathname.slice(1));
  if (req.method === 'GET' && url.pathname === '/api/status') return send(res, 200, { coach: await coach.status() });
  if (req.method !== 'POST') return send(res, 404, { error: 'Not found' });

  const b = await readBody(req);
  if (url.pathname === '/api/leagues') return send(res, 200, await leagues(b));
  if (url.pathname === '/api/analyze') {
    return send(res, 200, await analyzeLeague(b));
  }
  if (url.pathname === '/api/coach') {
    if (!b.report || !b.report.league) throw Object.assign(new Error('Run an analysis first'), { status: 400 });
    const messages = (Array.isArray(b.messages) ? b.messages : []).slice(-12)
      .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
      .map((m) => ({ role: m.role, content: m.content.slice(0, 4000) }));
    return send(res, 200, await coach.chat(b.report, messages));
  }
  return send(res, 404, { error: 'Not found' });
}

function serveFile(res, rel) {
  fs.readFile(path.join(ROOT, rel), (err, buf) => {
    if (err) return send(res, 404, { error: 'Not found' });
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(rel)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(buf);
  });
}

const server = http.createServer((req, res) => {
  route(req, res).catch((e) => {
    const status = e.status >= 400 && e.status < 500 ? e.status : e.status >= 500 || e.status === 0 ? 502 : 500;
    if (status >= 500) console.error(e);
    send(res, status, { error: e.message || 'Something went wrong', teams: e.teams });
  });
});

if (require.main === module) {
  server.listen(PORT, HOST, () => console.log('Fantasy Coach on http://' + (HOST === '0.0.0.0' ? 'localhost' : HOST) + ':' + PORT));
}

module.exports = { server, route };
