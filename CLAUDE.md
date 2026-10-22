# Fantasy Coach

Fantasy league advice (Sleeper, ESPN, FPL) with a 1–30 Move Score on every move. Node 18+, no dependencies.

- `npm test` runs the tests (`node --test`). Run them before pushing.
- `npm run build` rebuilds the website in `docs/` (GitHub Pages). Run it after any change to `coach.html`, `server/` or `web/`, and commit `docs/`.
- `scripts/daily.js` does the daily refresh in one command and prints `{subject, body, failed}`.
- Node needs `NODE_USE_ENV_PROXY=1 NODE_EXTRA_CA_CERTS=/root/.ccr/ca-bundle.crt` in cloud sessions to reach the fantasy APIs.

Where things are: `server/analyze.js` (analysis), `server/score.js` (Move Score), `server/trade.js` (trade analyzer and finder), `server/connectors/` (Sleeper, ESPN, FPL), `coach.html` (the page; `trade.html` is generated from it), `scripts/` (build, snapshot, daily).

Don't read `docs/` (generated), `data/*.json` (large) or `.cache/`.
