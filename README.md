# Move Check

Fantasy pickups, trades and lineup advice for Fantasy Premier League, NFL and NBA.

Two ways to use it:

- **League Coach** (`coach.html` plus a small server) connects to your league on **Sleeper**, **ESPN** or **FPL**. It pulls every roster, sizes up your team against the rest of the league, and gives you lineup fixes, waiver pickups or FPL transfers, and trade ideas. An AI coach, reached through [OmniRoute](https://github.com/diegosouzapw/OmniRoute), turns those numbers into plain advice and answers follow-up questions.
- **Manual Move Check** (`index.html`): one page with no build step. Type in or screenshot your players and compare moves by hand.

## Run the League Coach

Needs Node 18 or newer. There are no packages to install.

```bash
cp .env.example .env      # optional: add your OmniRoute key
npm start                 # or: node server/server.js
```

Open http://localhost:8787 and pick your app:

| App | What you enter | Notes |
| --- | --- | --- |
| Sleeper (NFL, NBA, Premier League) | Your username, then pick the league. Or paste a league ID. | Public API, no login needed. Points use your league's own scoring settings. |
| ESPN (NFL, NBA) | League ID from the league URL, plus your team ID if it isn't found automatically | Private leagues need the `espn_s2` and `SWID` cookies from a logged-in browser. They go to your local server only and are never saved. |
| FPL | Your team ID (the number in your Points page URL), then a mini-league | Public API. Transfers use current prices, not your exact selling price. |

### What you get

- **Heads up**: injured or doubtful players in your lineup, and players with no games logged.
- **Lineup this week**: who to start over whom, with the projected gain. For FPL, the best XI in a legal formation and a captain pick.
- **Waiver pickups / transfers**: free agents who clearly beat a player you have at the same position. FPL transfers respect your bank and the three-per-club rule, and factor in the next six gameweeks of fixtures.
- **Trade ideas**: offers across every team in the league where you come out ahead but the gap is small enough that they might say yes. Trades that fill your thinnest position and give the other manager what they lack are ranked first.
- **Where you stand**: your strength at each position against the league average.
- **Power rankings**: every team ranked by its best projected lineup.
- **FPL mini-league**: players your rivals own that you don't, and your differentials.
- **AI coach**: a short written plan, plus a box for questions like "who should I target for a WR?".

### Connect the AI coach (OmniRoute)

OmniRoute is a local gateway that speaks the OpenAI API and routes requests to the providers you connect, including free tiers.

1. Install and start it: `npm install -g omniroute`, then `omniroute`. The dashboard is at http://localhost:20128.
2. In the dashboard, connect at least one provider under **Providers**, then copy an API key from **Endpoints**.
3. Put the key in `.env` as `OMNIROUTE_API_KEY`. Keep `OMNIROUTE_MODEL=auto`, or name a specific `provider/model`.

Any OpenAI-compatible endpoint also works: point `OMNIROUTE_URL` at it. Without a gateway, everything except the AI coach still works.

The coach gets only the computed analysis (rosters, projections and the moves already checked by the scoring model), and it is told not to invent stats or news.

## Standalone report page

`npm run snapshot -- --config leagues.json --out report.html` writes one self-contained page, with a tab per league in `leagues.json` and no server needed. Add `--notes-dir notes/` to include written coach notes from `notes/<key>.md`. One league also works without a config: `npm run snapshot -- --platform sleeper --username <you> --sport epl --out report.html`. A scheduled task can run this and republish the page so it stays current.

## How the numbers work

- Logic lives in `engine.js`, which the page and the server share: `valuePlayer`, `compareWaiver`, `compareTrade`, `pickupMoves`, `tradeMoves`.
- Each player gets a projection from their season average and recent form (last 4 games for NFL and FPL, last 10 for NBA), adjusted for role and health. Value is points above replacement over the rest of the window.
- In a connected league, replacement level is what the best free agents at each position actually score. In FPL, and in the manual page, it uses the defaults in `SPORTS`.
- Roles come from real usage: NFL snap share on Sleeper, and starts per gameweek in FPL. Health comes from each app's injury designations.
- When a player has no games this season (for example the NBA before opening night), the server falls back to the matching entry in `data/<sport>.json` and says so.

## Code map

```
engine.js               shared scoring engine (browser + Node)
index.html              manual Move Check page
coach.html              League Coach page
server/server.js        HTTP server and API: /api/leagues, /api/analyze, /api/coach, /api/status
server/analyze.js       league-wide analysis: lineups, rankings, pickups, trades, FPL transfers
server/coach.js         AI coach client (OpenAI-compatible, OmniRoute by default)
server/connectors/      sleeper.js, espn.js, fpl.js -> one normalized league shape
server/lib/             fetch with caching, player helpers
tests/                  node --test
data/                   player data files used by the manual page and as a fallback
```

## Known limits

- **ESPN** uses an unofficial API that can change without notice. It is written to the documented response shape but has not been tested against a live private league.
- **Yahoo** is not supported yet. Its API needs a registered OAuth app.
- FPL selling prices can be lower than current prices. Free transfers and chips aren't read, since that needs a login.
- Trade suggestions value points, not roster construction or league-specific bye weeks. Treat them as offers to explore, not verdicts.
- The manual page's screenshot reader uses `window.claude.use('sample')`, which only exists inside a Claude artifact.

## Tests

```bash
npm test
```
