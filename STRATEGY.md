# ICT AutoPilot — Strategy Constitution

This file is the authoritative description of the trading methodology
encoded in `index.html`. The dashboard's runtime logic must align with
this document. When the dashboard and this file disagree, the dashboard
is wrong and needs to be updated to match.

If you ever wire a Claude Code agent on top of this repo, point it at
this file as the strategy constitution.

---

## 1. Mandate

Trade ICT (Inner Circle Trader) confluence setups on liquid crypto
(Binance) and selected futures (GOLD, SILVER, US100). The goal is
risk-defined scalps inside specific intraday windows. **Confirmation,
not prediction.** No anticipating moves before structure confirms.

Time zone: **GST / UTC+4 (Dubai), no DST.**

## 2. Sessions

Only trade in these GST windows:

| Session            | Start | End   | Type   | Notes                              |
| ------------------ | ----- | ----- | ------ | ---------------------------------- |
| London Kill Zone   | 08:00 | 10:00 | active | Strongest FVG/OB setups            |
| NY AM Kill Zone    | 13:00 | 15:00 | active | Bread-and-butter scalps            |
| ICT Macro AM       | 18:50 | 19:00 | macro  | 10-min high-volatility window      |
| ⛔ Dead Zone        | 19:00 | 22:00 | dead   | **No new trades. No exceptions.**  |
| Silver Bullet PM   | 22:50 | 23:30 | macro  | Final scalp window                 |

Outside these windows: stand aside.

## 3. Signal Ladder

`getSignal(asset, gst)` returns one of seven states. Order of precedence:

1. **`invalid`** — `invalidationPrice` has been crossed. Setup is dead.
   Manual reset required (clear or change `invalidationPrice`).
2. **`blackout`** — within ±30 min of a high/critical macro event
   (FOMC, CPI, NFP, PCE). Algo-driven volatility, not ICT structure.
3. **`enter`** — price within **0.05%** of entry. **Fires regardless of
   score, session, or MTF — this is your trade signal.**
4. **`armed`** — price within **0.15%** of entry, ICT score ≥ 9, in a
   Kill Zone (active or macro), MTF score ≥ 2/3.
5. **`watch`** — price within **0.5%** of entry, ICT score ≥ 7.
6. **`skip`** — score < 4 OR Dead Zone. Stand aside.
7. **`wait`** — default; no clear setup yet.

Distance percentages are absolute: `|price − entry| / entry`.

## 4. ICT Scoring (10 triggers)

`asset.checks` is a 10-element binary array indexed against
`CHECK_LABELS`:

```
['HTF Bias','Kill Zone','FVG','OB','CHoCH','MSS','Displacement',
 'Liquidity Sweep','PO3','Macro']
```

A score is the count of `1`s. **CHoCH is non-negotiable** — no
1-minute Change-of-Character confirmation, no trade, regardless of
how perfect everything else looks.

## 5. Confidence (0–99)

`getConfidencePct` returns an integer:

```
scoreComp     = (score / 10) * 60       max 60
+ CHoCH bonus = +5 if 1m CHoCH detected
+ MTF tier    = +5 (3/3) | +3 (2/3) | -2 (1/3) | -5 (0/3)
proxComp      = 25 (≤0.05%) | 20 (≤0.15%) | 12 (≤0.5%) | 5 (≤1%) | 0
sessComp      = 15 in active KZ or macro | 0 otherwise (incl. Dead Zone)
```

Floored at 0, capped at 99.

## 6. Multi-Timeframe Alignment

`getMTFAligned` reads bias from `mtfCache` for H1 / H4 / D1. Bias of
each TF is `bull` if its last completed candle closed above its open,
`bear` otherwise. We compare against the asset's declared bias.

- **3/3 aligned** = strongest setup (ARM and trade with confidence)
- **2/3 aligned** = the gate to ARM (good enough)
- **1/3 or 0/3** = misaligned, do not ARM

MTF cache is refreshed every 5 min in normal operation. **On
escalation to ARMED or ENTER**, if the cache is older than 60s the
dashboard force-refetches before firing the alert. Stale MTF must not
trigger an alarm.

## 7. Risk & Position Sizing

| Grade | Risk per trade |
| ----- | -------------- |
| A+    | 2%             |
| A     | 1.5%           |
| B     | 1%             |

**Minimum R:R = 1:3.** R:R below 2:1 = hard warning. R:R between 2:1
and 3:1 = caution; only acceptable on A+ setups. R:R ≥ 3:1 = no
warning.

## 8. Hard Guardrails

Independent of any signal logic, the dashboard refuses to fire
escalation alerts when any of these are true:

- **Stale data:** ≥ 2 consecutive Binance sync failures
- **Macro blackout:** within ±30 min of a high/critical macro event
- **Daily loss limit hit:** today's realized R-PnL ≤ -3R
- **Max trades per session:** ≥ 3 ENTER/ARMED alerts already fired
  in the current Kill Zone or Macro window
- **Revenge cooldown:** the same symbol resolved a LOSS in the last
  30 min — suppress new ENTER/ARMED on that symbol

These are NOT advisory. They are circuit breakers.

## 9. Outcome Resolution

For every fired ENTER, the dashboard logs a journal entry and
schedules outcome checks at 30 / 60 / 240 / 480 minutes after the
call. At each check, it pulls the 1m kline range from entry-time to
check-time and walks every candle's high/low for TP/SL touches:

- **First-touch wins.** Earliest candle to wick TP or SL determines
  the outcome.
- **Both touched in the same candle = LOSS** (conservative — wicks
  are ambiguous).
- **No touch by 480 min = BE.**

Non-Binance assets (GOLD, SILVER, US100) have no auto-resolution and
require manual outcome marking.

## 10. Daily Routines

| Trigger                          | What runs                                                 |
| -------------------------------- | --------------------------------------------------------- |
| Page load / tab return           | Sync prices, refetch MTF, prime alerts (no spam)          |
| Every 30s                        | Polling sync (fallback when WebSocket is down)            |
| Every live tick (~1 Hz)          | Re-evaluate signals, fire alarms, update sparkline        |
| Every 5 min                      | Refresh MTF, news, fear/greed, funding rates              |
| ICT Macro AM open (18:50 GST)    | Snap full session-summary; reset session trade counter    |
| Each KZ open (08:00 / 13:00)     | Reset session trade counter, log session start            |
| Each KZ close                    | Toast summary: trades fired this session, win-rate so far |
| GST midnight (00:00)             | Reset daily PnL, archive today's trades, render EOD recap |

## 11. Backtester

`runBacktest` and `runBacktestAll` replay the last N hours of 1m
Binance data through the live `getSignal` ladder. Defaults:

- **Slippage** 0.05% per side (5 bps)
- **Fee** 0.04% per side (Binance taker)

R-multiples are net of both costs. The numbers shown in the modal are
what the account would have actually done, not perfect-fill fantasy.

## 12. What This Is Not

- **Not autonomous execution.** The dashboard alerts; the trader
  manually places the order. There is no Alpaca / Binance trade-API
  call from this code. Adding one is out of scope.
- **Not a stocks bot.** Asset universe is crypto + a few futures.
- **Not an LLM-in-the-loop system.** All logic is rule-based. Adding
  Claude or any other LLM is not currently planned.

## 13. Test Coverage

Every rule in this document has at least one unit test in `tests/`.
When you change a rule here, update the corresponding test or add a
new one. **The test suite is the executable form of this constitution.**
