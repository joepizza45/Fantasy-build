/* JSON fetch with a timeout, an in-memory cache and an optional on-disk cache for large, slow-changing files. */
const IN_BROWSER = typeof window !== 'undefined';
const fs = IN_BROWSER ? null : require('fs');
const path = IN_BROWSER ? null : require('path');

const CACHE_DIR = path ? path.join(__dirname, '..', '..', '.cache') : null;
const mem = new Map();

class FetchError extends Error {
  constructor(message, status, url) { super(message); this.status = status; this.url = url; }
}

async function getJSON(url, { headers = {}, ttl = 5 * 60 * 1000, disk = false, timeout = 30000 } = {}) {
  const key = url + '|' + JSON.stringify(headers);
  const hit = mem.get(key);
  if (hit && Date.now() - hit.at < ttl) return hit.data;

  const file = disk && fs ? path.join(CACHE_DIR, url.replace(/[^a-z0-9]+/gi, '_').slice(-180) + '.json') : null;
  if (file) {
    try {
      const st = fs.statSync(file);
      if (Date.now() - st.mtimeMs < ttl) {
        const data = JSON.parse(fs.readFileSync(file, 'utf8'));
        mem.set(key, { at: st.mtimeMs, data });
        return data;
      }
    } catch (e) { /* no usable cache file */ }
  }

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeout);
  let res;
  try {
    res = await fetch(url, { headers: IN_BROWSER ? headers : { 'User-Agent': 'FantasyCoach/1.0', Accept: 'application/json', ...headers }, signal: ctl.signal });
  } catch (e) {
    throw new FetchError(e.name === 'AbortError' ? 'Timed out reaching ' + new URL(url).host : 'Could not reach ' + new URL(url).host + ' (' + e.message + ')', 0, url);
  } finally { clearTimeout(timer); }
  if (!res.ok) throw new FetchError(new URL(url).host + ' answered ' + res.status, res.status, url);
  const data = await res.json();
  mem.set(key, { at: Date.now(), data });
  if (file) {
    try { fs.mkdirSync(CACHE_DIR, { recursive: true }); fs.writeFileSync(file, JSON.stringify(data)); } catch (e) { /* cache is optional */ }
  }
  return data;
}

module.exports = { getJSON, FetchError };
