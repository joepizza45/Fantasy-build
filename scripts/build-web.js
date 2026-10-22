/* Builds the static Fantasy Coach site into docs/ for GitHub Pages. No dependencies.
   Bundles web/entry.js and the CommonJS modules it requires into docs/app.js. */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'docs');
const BUILTINS = ['fs', 'path', 'http'];

function bundle(entry) {
  const mods = new Map();
  const visit = (file) => {
    if (mods.has(file)) return;
    mods.set(file, null);
    let src = fs.readFileSync(file, 'utf8');
    src = src.replace(/require\((['"])([^'"]+)\1\)/g, (all, q, spec) => {
      if (BUILTINS.indexOf(spec) >= 0) return '__builtin(' + JSON.stringify(spec) + ')';
      let target = path.resolve(path.dirname(file), spec);
      if (!fs.existsSync(target) && fs.existsSync(target + '.js')) target += '.js';
      visit(target);
      return '__require(' + JSON.stringify(path.relative(ROOT, target)) + ')';
    });
    mods.set(file, src);
  };
  visit(entry);
  const defs = Array.from(mods.entries()).map(([file, src]) =>
    JSON.stringify(path.relative(ROOT, file)) + ': function (module, exports, __require, __builtin, __dirname) {\n' + src + '\n}').join(',\n');
  return '/* Fantasy Coach web bundle. Built by scripts/build-web.js; edit the sources, not this file. */\n(function () {\n' +
    'var defs = {\n' + defs + '\n};\nvar cache = {};\n' +
    'function __builtin() { return null; }\n' +
    'function __require(id) {\n  if (cache[id]) return cache[id].exports;\n  var module = cache[id] = { exports: {} };\n' +
    '  defs[id](module, module.exports, __require, __builtin, "");\n  return module.exports;\n}\n' +
    '__require(' + JSON.stringify(path.relative(ROOT, entry)) + ');\n})();\n';
}

/* trade.html is coach.html in trade mode: same code and look, its own headline, only the trade tools. */
function tradePage(html) {
  const swap = (from, to) => { if (html.indexOf(from) < 0) throw new Error('trade page: missing ' + from.slice(0, 40)); html = html.replace(from, to); };
  swap('<title>Fantasy Coach</title>', '<title>Fantasy Coach Trade Analyzer</title>');
  swap('<body>', '<body data-page="trade">');
  swap('Sleeper · ESPN · FPL &nbsp;/&nbsp; NFL · NBA · Premier League</p>', 'Fantasy Coach &nbsp;/&nbsp; Sleeper · ESPN</p>');
  swap('<h1>Fantasy<br><span class="o">Coach</span></h1>', '<h1>Trade<br><span class="o">Analyzer</span></h1>');
  html = html.replace(/<p class="sub">[^<]*<\/p>/, '<p class="sub">Load your league, pick a trade partner and see exactly how any deal changes both lineups. Tick only the players you want, or only the ones you would sell, and the trade finder builds the other side.</p>');
  swap('<p class="links"><a href="trade.html">Trade analyzer</a></p>', '<p class="links"><a href="index.html">Back to Fantasy Coach</a></p>');
  return html;
}

function build() {
  fs.mkdirSync(path.join(OUT, 'data'), { recursive: true });
  fs.writeFileSync(path.join(OUT, 'app.js'), bundle(path.join(ROOT, 'web', 'entry.js')));
  fs.writeFileSync(path.join(OUT, 'trade.js'), bundle(path.join(ROOT, 'web', 'trade-entry.js')));
  const coach = fs.readFileSync(path.join(ROOT, 'coach.html'), 'utf8');
  if (coach.indexOf('<script>') < 0) throw new Error('coach.html has no inline script');
  const web = coach.replace('<script>', '<script src="app.js"></script>\n<script>');
  fs.writeFileSync(path.join(OUT, 'index.html'), web);
  fs.writeFileSync(path.join(OUT, 'trade.html'), tradePage(web));
  ['manual.html', 'engine.js'].forEach((f) => { try { fs.unlinkSync(path.join(OUT, f)); } catch (e) { /* already gone */ } });
  fs.readdirSync(path.join(ROOT, 'data')).filter((f) => f.endsWith('.json'))
    .forEach((f) => fs.copyFileSync(path.join(ROOT, 'data', f), path.join(OUT, 'data', f)));
  fs.writeFileSync(path.join(OUT, '.nojekyll'), '');
  console.log('Built docs/: index.html, trade.html, app.js, trade.js and data/');
}

if (require.main === module) build();
module.exports = { bundle, build, tradePage };
