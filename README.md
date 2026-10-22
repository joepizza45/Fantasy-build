# Fantasy Coach

Lineup, waiver and trade advice for your fantasy league. Every move gets a **Move Score from 1 to 30**, and each number has its own label, from 1 "Never do this" to 30 "Must do now".

Works with **Sleeper** (NFL, NBA, Premier League), **ESPN** (NFL, NBA) and **Fantasy Premier League**.

## Use it

### 1. In your browser: nothing to install

Open **https://joepizza45.github.io/Fantasy-build/**, choose your app, enter your Sleeper username or ESPN league ID, and press **Analyze**. Everything runs in your browser, and nothing is sent anywhere except the fantasy app's own servers.

- **Sleeper:** any league, public by default.
- **ESPN:** public leagues. For a private league, the league manager can turn on **Make League Viewable to Public** in the league settings, or you can use the self-hosted version.
- **FPL:** blocks web pages from reading its data, so it needs the self-hosted version.

**Host the site yourself, for free:** in your copy of this repo on GitHub, go to **Settings → Pages**, set **Source** to **Deploy from a branch**, and pick your branch and the `/docs` folder. GitHub shows the site's address once it's live. After changing the code, run `npm run build` to refresh `docs/`.

### 2. Self-hosted: every app, plus an AI chat

Needs Node 18 or newer. There are no packages to install.

```bash
cp .env.example .env      # optional: AI chat settings
npm start                 # http://localhost:8787
```

This adds FPL, private ESPN leagues (with the `espn_s2` and `SWID` cookies from a logged-in browser; they stay on your machine) and an optional AI chat through any OpenAI-compatible gateway, such as [OmniRoute](https://github.com/diegosouzapw/OmniRoute). Set `OMNIROUTE_URL`, `OMNIROUTE_API_KEY` and `OMNIROUTE_MODEL` in `.env`.

### 3. A daily report page for your own leagues

Copy `leagues.example.json` to `leagues.json`, fill in your usernames and IDs, then:

```bash
npm run snapshot -- --config leagues.json --out report.html
```

That writes one self-contained page with a tab per league and coach notes. Run it on a schedule to keep it current. `--notes-dir notes/` swaps in your own notes from `notes/<key>.md`.

## What you get

- **Coach notes:** a short plan for the week, every move led by its Move Score.
- **Heads up:** injured or doubtful starters, players on bye this week, and bye crunches coming up.
- **Lineup this week:** who to start over whom.
- **Waiver pickups / FPL transfers:** free agents who would start for you. FPL transfers respect your bank, the three-per-club rule and the next six gameweeks of fixtures.
- **Trade ideas:** offers that improve your lineup without gutting theirs.
- **Trade Analyzer page** (`trade.html`): load your league, pick any team and any players on each side, and get a Move Score, both lineups before and after, the chance they accept, value on each side, injuries and, in dynasty, ages. Tick only the players you want, or only the ones you'd sell, and the **trade finder** builds the best other side. Suggested trades open in it with one tap. The same analyzer also sits on every league report.
- **Where you stand, power rankings, your roster:** strength by position against the league, every team ranked by its best projected lineup.
- **FPL mini-league:** players your rivals own that you don't, and your differentials.

## The Move Score

A move's score starts from how many points a week it adds to your best lineup, compared with an average starter in your league. Then:

| Adjustment | Points |
| --- | --- |
| Lineup change with no cost | +2 |
| Trade that also improves their lineup | +1 |
| Player has played 2 games or fewer | −3 |
| Injury doubt | −2 |
| Trade that hurts their lineup (hard to get accepted) | −2 |
| Dynasty or keeper: gives up a young player | −2 |
| Gives up one of your three best players | −3 |

The result is capped at 1 to 30. The full key of 30 labels is in `server/score.js` and at the bottom of every report.

## How the numbers work

- Points use your league's own scoring settings (Sleeper) or the app's computed points (ESPN, FPL).
- Each player's projection blends season average and recent form, pulls small samples toward a typical player at the position, and adjusts for role (NFL snap share, FPL starts) and health.
- Replacement level is what the best free agents at each position actually score in your league.
- NFL bye weeks come from ESPN's public schedule.
- Dynasty and keeper leagues protect young players from drop suggestions and reject trades that make you much older.

## Code map

```
coach.html              Fantasy Coach page (web app and self-hosted); trade.html is built from it in trade mode
engine.js               player valuation shared by every page
server/api.js           find leagues, analyze a league (shared by server and browser)
server/analyze.js       lineups, rankings, pickups, trades, FPL transfers
server/score.js         the 1-30 Move Score and its labels
server/notes.js         coach notes written from the scores
server/trade.js         trade analyzer: scores any trade from the report's tradeModel
server/lineup.js        best-lineup helpers shared by analysis and trades
server/connectors/      sleeper.js, espn.js, fpl.js -> one league shape
server/server.js        self-hosted HTTP server
server/coach.js         optional AI chat (OpenAI-compatible)
web/entry.js            browser entry for the web app
scripts/build-web.js    builds the web app into docs/
scripts/snapshot.js     standalone multi-league report page
scripts/daily.js        daily job: page, automatic notes and email text in one command
tests/                  node --test
```

## Known limits

- ESPN uses an unofficial API that can change without notice, and private leagues haven't been tested live.
- Yahoo isn't supported; its API needs a registered OAuth app.
- FPL selling prices can be lower than current prices; free transfers and chips aren't read.
- Trade ideas weigh points and lineup fit, not every manager's needs. Treat them as offers to explore.

## Tests

```bash
npm test
```
