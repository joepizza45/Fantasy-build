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

function build() {
  fs.mkdirSync(path.join(OUT, 'data'), { recursive: true });
  fs.writeFileSync(path.join(OUT, 'app.js'), bundle(path.join(ROOT, 'web', 'entry.js')));
  fs.writeFileSync(path.join(OUT, 'trade.js'), bundle(path.join(ROOT, 'web', 'trade-entry.js')));
  const coach = fs.readFileSync(path.join(ROOT, 'coach.html'), 'utf8');
  if (coach.indexOf('<script>') < 0) throw new Error('coach.html has no inline script');
  fs.writeFileSync(path.join(OUT, 'index.html'), coach.replace('<script>', '<script src="app.js"></script>\n<script>'));
  // On the site the coach is the home page and the hand-compare page is manual.html.
  fs.writeFileSync(path.join(OUT, 'manual.html'), fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8').replace('href="coach.html"', 'href="index.html"'));
  fs.copyFileSync(path.join(ROOT, 'engine.js'), path.join(OUT, 'engine.js'));
  fs.readdirSync(path.join(ROOT, 'data')).filter((f) => f.endsWith('.json'))
    .forEach((f) => fs.copyFileSync(path.join(ROOT, 'data', f), path.join(OUT, 'data', f)));
  fs.writeFileSync(path.join(OUT, '.nojekyll'), '');
  console.log('Built docs/: index.html, manual.html, app.js, trade.js, engine.js and data/');
}

if (require.main === module) build();
module.exports = { bundle, build };
