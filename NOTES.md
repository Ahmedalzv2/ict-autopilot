# Project Notes — Session Context

This file lets a fresh session rehydrate full context without re-reading
the entire git history. It's the answer to "what did we decide and why."

For trading rules see `STRATEGY.md`. For executable verification see
`tests/`. This file is the **decision log + style guide**.

---

## 1. What this project is

`index.html` is a single-file ICT (Inner Circle Trader) trading
dashboard that the user (Ahmed) keeps open in a browser. It alerts on
ICT setups, journals trades, runs backtests, and surfaces market
context. The user trades manually on the alerts.

Everything is in one `<script>` tag inside `index.html`. There is no
build step, no module bundler, no `node_modules` for runtime.

## 2. Tech constraints

- **No npm registry access** — the host blocks `registry.npmjs.org`. We
  cannot `npm install` anything. All test infra is **stdlib-only**:
  Node 22 `node:test` + `node:vm` + a hand-rolled DOM stub.
- **Browser-resident** — the dashboard runs in a regular browser tab.
  No server, no cron, no VPS.
- **Static deploy** — the file is served as static HTML. No backend.

## 3. Test architecture

- Runner: Node 22 `node:test` (zero deps).
- Loader: `tests/harness.mjs` — reads `index.html`, extracts the inline
  `<script>`, executes it in a `node:vm` context with stubbed
  `document`/`localStorage`/`fetch`/`setTimeout`/`AudioContext`/etc.
  Function declarations and `let`/`const` bindings are exposed to tests
  via an injected export bag at the end of the script (`globalThis.__app`).
- Cross-realm gotcha: arrays/objects from the vm have a different
  `Array.prototype` than the test process. Use `[...arr]` to spread
  into the test realm before `assert.deepEqual`.
- Time control: `gstDate(h, m, s)` builds a local-time Date whose
  `.getHours()` etc. return the GST clock values you want. The harness
  forces `process.env.TZ = 'UTC'` at load.
- 262 tests, 0 fail, 0 todo as of the last commit. **Run with `npm test`** —
  the script is `TZ=UTC node --test --test-reporter=spec 'tests/*.test.mjs'`.

## 4. Rules-of-thumb the user has set (or implied)

- **Direct, no fluff.** Short answers preferred. Match the user's
  level of detail.
- **Honesty over enthusiasm.** When something can't be done (X API
  paywall, can't watch YouTube videos, npm registry blocked), say so
  immediately. Don't pretend.
- **No emojis** in commits, code comments, or assistant text unless the
  user puts emojis in first.
- **Comment why, not what.** Comments explain non-obvious WHY.
  Well-named code carries the WHAT.
- **Tests first when adding logic.** Every new pure function should
  have a unit test. Pure helpers extracted from impure ones for that
  reason.
- **Keep changes surgical.** Don't refactor the dashboard's HTML for a
  feature add. Mount UI via JS at init time (e.g. backtest button,
  daily-PnL pill). The user is iterating on the file fast — invasive
  HTML edits create merge pain.

## 5. Build history (chronological, what shipped per commit)

1. **Test scaffolding** — Node 22 native test runner + vm harness;
   first batch of session/format/signal/journal/concepts tests.
2. **Auto-analysis on every tick + alarms + news → analysis** — removed
   the 5x renderAnalysis throttle, re-enabled the Web Audio beep,
   first-sync alert suppression, news headlines tagged per asset and
   surfaced in `analyzeAsset`.
3. **Trader-safety pass** — wick-aware outcome resolution (was
   silently distorting win-rate by only checking close-at-targetTs),
   stale-data banner, R:R warnings, confidence floor at 0,
   `CHECK_LABELS` length fix (dropped "Premium/Discount").
4. **Tier 1: invalidation + cooldown + funding** — structured
   `invalidationPrice` per asset → new `'invalid'` signal state;
   per-symbol/tier alert cooldowns; funding rate ICT-contrarian read
   surfaced in `analyzeAsset`. Confidence math aligned with `getSignal`
   thresholds; Dead Zone session credit dropped to 0.
5. **Tier 2: macro blackout + fresh-MTF on escalation** — new
   `'blackout'` state covering ±30 min around high-impact macro
   events; `checkArmedAlerts` is now async and force-fetches MTF
   before firing ARMED/ENTER on stale cache.
6. **Live WebSocket prices + signal sparkline + Wake Lock** — Binance
   miniTicker stream with auto-reconnect; per-asset 24h state-change
   sparkline persisted to localStorage; Wake Lock keeps the tab alive
   when minimized.
7. **Backtester** — replays last N hours of 1m klines through
   `getSignal` to produce simulated trades + win/loss/be stats.
   Engine is pure-and-tested; async wrapper hits Binance.
8. **Multi-asset backtest + UI button + MTF 2/3 confidence credit** —
   `runBacktestAll` runs all Binance assets; floating "Backtest"
   button mounts a results modal; MTF score 2/3 now grants +3
   confidence (previously 0).
9. **Slippage + fees in backtest** — default 5bps slippage + 4bps fee
   per side, applied to both entry and exit. R-multiples are now
   honest (BE outcome pays round-trip fees, conservative loss-on-both-hit).
10. **Strategy constitution + hard guardrails** — `STRATEGY.md` is
    the authoritative methodology doc. Daily loss limit (-3R), max
    trades per session (3), revenge cooldown (30 min after a loss on
    the same symbol). Daily-PnL pill in the top bar.
11. **Real CHoCH detection** — fractal swing detection +
    `detectCHoCH`, fetches every 30s, gates ARMED behind
    `supportsBias`, +5/-3 confidence grading, fresh-CHoCH on
    escalation in parallel with MTF refresh.

## 6. Active circuit breakers (in order of precedence)

In `checkArmedAlerts`, alerts are suppressed when ANY of these is true:

1. `!firstSyncDone` (initial scan only primes the map, no alerts)
2. `consecutiveSyncFails >= 2` (stale Binance data)
3. `getDailyR(journal, today) <= -3R` (daily loss limit)
4. Per-symbol revenge cooldown for ENTER/ARMED (30m after a LOSS)
5. Per-session trade quota for ENTER/ARMED (3 per Kill Zone)
6. Per-tier oscillation cooldown (10m WATCH / 3m ARMED / 0 ENTER)

Plus precedence inside `getSignal`:

1. `isInvalidated(asset)` → `'invalid'` (terminal until manual reset)
2. `getMacroBlackout(gst)` → `'blackout'` (auto-clears 30m past event)
3. ENTER (≤ 0.05% from entry) — overrides everything below
4. ARMED — needs proximity ≤ 0.15% + score ≥ 9 + KZ + MTF ≥ 2/3 +
   CHoCH supports bias (or pending)
5. WATCH — proximity ≤ 0.5% + score ≥ 7
6. SKIP — score < 4 OR Dead Zone
7. WAIT — default

## 7. The "no" list (decisions deliberately NOT taken)

- **Alpaca / stocks API** — wrong asset class. User trades crypto on
  Binance/MEXC.
- **Perplexity API** — paid LLM research is overkill while CoinGecko +
  Reddit suffice.
- **Cloud cron / VPS / autonomous trade execution** — major risk and
  architecture pivot, needs explicit signoff. Dashboard alerts; user
  trades manually.
- **Real X / Twitter integration** — paywalled at $200/mo since 2023.
  Reddit r/CryptoCurrency hot posts cover ~80% of the same ground for
  free. The adapter shape (`{title, url, source, ts}`) makes a future
  swap easy.
- **JSDOM / external test deps** — npm registry blocked; stdlib-only.
- **Beat-S&P-500 mandate** — not the user's goal.
- **CHoCH and Premium/Discount as 11th check** — `Premium/Discount`
  was dropped from `CHECK_LABELS` because no asset tracked it. To add
  it back, extend every `asset.checks` to length 11 AND restore the
  label.

## 8. Files and what's in them

- `index.html` (~199k chars) — the entire dashboard. Inline `<style>`
  + `<script>`. Single-page, no externals beyond Google Fonts CSS.
- `STRATEGY.md` — the trading methodology constitution.
- `NOTES.md` — this file.
- `package.json` — `"test"` and `"test:watch"` scripts. `"type": "module"`.
- `tests/harness.mjs` — vm-based loader, `gstDate` helper, export list.
- `tests/sessions.test.mjs` — GST sessions, `getCurrentSession`,
  `getNextKillZone`, `getGST`.
- `tests/format.test.mjs` — `fmtTime`, `fmt12hm`, `fmtCountdown`.
- `tests/signal.test.mjs` — `getSignal` ladder, `getMTFAligned`,
  `getConfidencePct`, `analyzeAsset` narrative.
- `tests/journal.test.mjs` — localStorage round-trip, wick-aware
  outcome resolution, `setManualOutcome`.
- `tests/concepts.test.mjs` — invariants on `ASSETS` data shape.
- `tests/alerts.test.mjs` — `checkArmedAlerts` edge-triggered
  escalation + cooldowns.
- `tests/news.test.mjs` — `tagHeadline`, `getNewsContext`,
  `analyzeAsset` headline integration.
- `tests/safety.test.mjs` — confidence floor, R:R warnings,
  stale-data alert suppression.
- `tests/methodology.test.mjs` — invalidation, alert cooldown tiers,
  funding-rate context.
- `tests/macro.test.mjs` — `getMacroBlackout`, `getSignal` precedence
  with blackout vs invalidation.
- `tests/mtf-fresh.test.mjs` — `isMTFStale` + fresh-MTF refetch on
  escalation.
- `tests/live-stream.test.mjs` — `parseTickerMessage`,
  `recordSignalState`, `renderSparkline`.
- `tests/backtest.test.mjs` — `simulateTradeOutcome`,
  `reconstructMTFAt`, `summarizeBacktest`, `runBacktestSync`,
  `runBacktest`, `runBacktestAll`, MTF tier credit.
- `tests/guardrails.test.mjs` — daily loss limit, session quota,
  revenge cooldown, integration with `checkArmedAlerts`.
- `tests/choch.test.mjs` — `findSwings`, `detectCHoCH`,
  `getCHoCHStatus`, signal gate, confidence grading, staleness.

## 9. Open queue (not yet built)

In rough priority order from the trader's perspective:

1. **Persist guardrail state to localStorage** — `lastAlertMs`,
   `prevSignalMap`, `lastLossMs`, `sessionTradeCounts` are all
   in-memory, lost on refresh. Real safety gap: refresh erases the
   daily-loss-limit memory and the revenge cooldown memory.
2. **EOD recap modal** at GST 23:59 — today's trades + win-rate +
   total R + sessions hit/missed.
3. **Sentiment scoring** on news/Reddit headlines — keyword polarity
   ±5 confidence, behind a toggle so it can be A/B'd via backtest.
4. **Performance audit** — WebSocket ticks driving renderSignals +
   renderAnalysis + checkArmedAlerts every second is a lot of DOM work.
5. **Backtest comparison mode** — two configs side-by-side so the
   user can A/B "with cooldown vs without" etc.
6. **Weekly review** at Friday 23:59 GST — 7-day aggregate stats and
   suggested rule adjustments.

## 10. Style conventions in the codebase

- WHY-comments on non-obvious branches; never explain WHAT well-named
  code already says.
- Pure helpers extracted with `function foo(...)` so vm exports work
  via the export bag (`function` decls hoist to global; `const`
  bindings are captured at the bottom of the script).
- New UI elements added via `mountX()` JS calls in `window.onload`,
  not via direct HTML edits, to avoid disturbing the layout.
- Default exports for DevTools (`window.ictBacktest`, etc.) avoid
  names that collide with internal function declarations (function
  decls in non-module scripts attach to globalThis, so
  `window.runBacktest = X` would clobber the inner `runBacktest`).
- Cross-realm assertions: spread into the test realm before
  `assert.deepEqual`.
- `let`-declared module state (e.g. `journal`, `mtfCache`,
  `chochCache`) needs both a getter AND setter on the export bag if
  tests want to mutate it.

## 11. How to add a new feature without breaking things

1. Read `STRATEGY.md` to confirm the feature is in scope.
2. Find a similar existing helper to model after.
3. Extract the pure logic from any DOM/network code so it's testable.
4. Add to `tests/harness.mjs` `EXPORTS` list AND, if it's mutable
   `let` state, add a getter/setter pair on the export bag.
5. Write tests first.
6. Wire into the impure caller.
7. Sanity-check the script still parses:
   `node -e "..." | grep "parses OK"` (the snippet is well-known).
8. Run `npm test`.
9. Commit with a HEREDOC message ending in the session URL.
