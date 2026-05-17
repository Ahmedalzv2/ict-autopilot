# Backtest fixtures

Committed kline snapshots for `tests/backtest-scalp.mjs`. Lets sandboxed
sessions (Claude Code on the web, CI, anywhere MEXC is unreachable) run
backtests deterministically — no network call needed.

## Dump fresh data (once, on a machine that can reach MEXC)

```sh
npm run dump-fixtures                       # all assets, 90d, Min5
npm run dump-fixtures -- --days=30 --interval=Min1   # 1m for shorter windows
npm run dump-fixtures -- --assets=SILVER,GOLD        # subset
npm run dump-fixtures -- --force            # overwrite existing
```

Commit the resulting `{ASSET}-{days}d-{interval}.json` files and push.

## Replay anywhere

`tests/backtest-scalp.mjs` auto-discovers fixtures here — no flag needed:

```sh
node tests/backtest-scalp.mjs --asset=SILVER --days=90 --tf=1h --mexc-interval=Min5
```

Override the resolution with `--cache=path/to/snapshot.json` if you want
to test against a specific file.

## File format

Flat array — no `fetchedAt` wrapper, so diffs are clean when re-dumping:

```json
[
  { "t": 1700000000000, "o": 75.5, "h": 75.6, "l": 75.4, "c": 75.55, "v": 120 },
  ...
]
```
