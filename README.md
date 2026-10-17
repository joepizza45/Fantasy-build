# Move Check

Ranked fantasy pickups and trade offers for Fantasy Premier League, NFL and NBA.
One file, no build step: open `index.html` in a browser.

## How it works
- Players are grouped as your roster, free agents, or another team's roster.
- Each player gets a projection from season average and recent form, adjusted for role and health.
- Pickups: a free agent that beats a rostered player at the same position by a clear margin.
- Trades: offers where you come out ahead but the gap is small enough to be accepted.
- Logic lives in three plain functions in `index.html`: `valuePlayer`, `compareWaiver`, `compareTrade`.

## Known limits
- Screenshot reading uses `window.claude.use('sample')`, which only exists inside a Claude artifact. Outside one, the page hides it and you add players by hand.
- No live data. Numbers come from what the user enters.
- Replacement levels per position are rough starting guesses (`SPORTS` in `index.html`).

## Next steps for Claude Code
1. Replace the screenshot reader with a call to the Anthropic API from a small server.
2. Add a data source: the public FPL API for Premier League, and a stats API for NFL and NBA.
3. Add tests for `valuePlayer`, `compareWaiver` and `compareTrade`.
