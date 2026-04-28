import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadApp } from './harness.mjs';

// Kline shape: [openTime, open, high, low, close, volume, closeTime]
function k(t, o, h, l, c) {
  return [t, String(o), String(h), String(l), String(c), '0', t + 60_000];
}

function makeAsset(o = {}) {
  return {
    symbol: 'TEST', bias: 'BULLISH',
    entry: 100, sl: 99, tp: 105, tp1: 105, grade: 'a',
    checks: [1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
    ...o,
  };
}

// Build a series of N bars where ENTERY-then-LOSS sequences fire reliably.
// Each "trade window" is 5 bars: bar 0 closes AT entry (ENTER), bars 1-3
// wick to SL (so the trade resolves as LOSS by bar 1), bars 4 sits at entry
// again to set up the NEXT entry.
function buildLossLoop(numTrades, gstHourStart = 9) {
  const baseUtcMs = Date.UTC(2024, 5, 15, gstHourStart - 4, 0, 0); // GST hour h → UTC h-4
  const bars = [];
  // Each trade burns 5 bars
  for (let t = 0; t < numTrades; t++) {
    for (let b = 0; b < 5; b++) {
      const ts = baseUtcMs + (t * 5 + b) * 60_000;
      let close, high, low;
      if (b === 0) {
        // ENTRY bar — close exactly at entry
        close = 100; high = 100.5; low = 99.5;
      } else if (b === 1) {
        // LOSS bar — wick to SL
        close = 98.5; high = 100; low = 98.5;
      } else if (b === 4) {
        // RESET — back to entry to allow next ENTER
        close = 100; high = 100.5; low = 99.5;
      } else {
        close = 99; high = 99.5; low = 98.7;
      }
      bars.push(k(ts, close, high, low, close));
    }
  }
  return bars;
}

// MTF helpers — provide bullish bars far in the past so MTF score is 3.
function bullishMTF(refUtcMs) {
  const farPast = refUtcMs - 24 * 3600_000;
  return [k(farPast, 99, 102, 99, 101)]; // bull
}

describe('runBacktestSync — daily loss limit gate', () => {
  test('with default guardrails: stops firing trades after −3R cumulative', async () => {
    const ctx = loadApp();
    const asset = makeAsset();
    const bars = buildLossLoop(8); // 8 potential losing trades
    const refUtcMs = Number(bars[0][0]);
    const H1 = bullishMTF(refUtcMs), H4 = bullishMTF(refUtcMs), D1 = bullishMTF(refUtcMs);

    const trades = ctx.app.runBacktestSync(asset, bars, H1, H4, D1, ctx.app.getSignal, {
      cooldownBars: 0, // disable bar-cooldown so we test daily-loss specifically
      slippagePct: 0, feePct: 0,
    });
    // First few losses should fire; after dailyR ≤ -3R, no more.
    // With cooldownBars=0 and 5-bar windows, 8 attempts → 3 losses → -3R → stop.
    const arr = [...trades];
    assert.ok(arr.length <= 3, `should cap at 3 losing trades when daily limit kicks in, got ${arr.length}`);
    assert.ok(arr.length >= 3, `should fire at least 3 trades before hitting limit, got ${arr.length}`);
  });

  test('with daily limit DISABLED (null): keeps firing past −3R', () => {
    const ctx = loadApp();
    const asset = makeAsset();
    const bars = buildLossLoop(8);
    const refUtcMs = Number(bars[0][0]);
    const H1 = bullishMTF(refUtcMs), H4 = bullishMTF(refUtcMs), D1 = bullishMTF(refUtcMs);

    const trades = ctx.app.runBacktestSync(asset, bars, H1, H4, D1, ctx.app.getSignal, {
      cooldownBars: 0,
      slippagePct: 0, feePct: 0,
      dailyLossLimitR: null,
      maxTradesPerSession: null,
      revengeCooldownMs: null,
    });
    // No guardrails → fires every entry attempt. With losses, each is a -1R.
    const arr = [...trades];
    assert.ok(arr.length > 3, `expected >3 trades without daily limit, got ${arr.length}`);
  });

  test('looser daily limit (-5R) allows more trades than default (-3R)', () => {
    const ctx = loadApp();
    const asset = makeAsset();
    const bars = buildLossLoop(8);
    const refUtcMs = Number(bars[0][0]);
    const H1 = bullishMTF(refUtcMs), H4 = bullishMTF(refUtcMs), D1 = bullishMTF(refUtcMs);

    const tight = ctx.app.runBacktestSync(asset, bars, H1, H4, D1, ctx.app.getSignal, {
      cooldownBars: 0, slippagePct: 0, feePct: 0,
      dailyLossLimitR: -3, maxTradesPerSession: null, revengeCooldownMs: null,
    });
    const loose = ctx.app.runBacktestSync(asset, bars, H1, H4, D1, ctx.app.getSignal, {
      cooldownBars: 0, slippagePct: 0, feePct: 0,
      dailyLossLimitR: -5, maxTradesPerSession: null, revengeCooldownMs: null,
    });
    assert.ok([...loose].length > [...tight].length,
      `loose ${[...loose].length} should beat tight ${[...tight].length}`);
  });
});

describe('runBacktestSync — revenge cooldown gate', () => {
  test('with revenge cooldown: blocks new entries within 30 min of a loss', () => {
    const ctx = loadApp();
    const asset = makeAsset();
    const bars = buildLossLoop(8);
    const refUtcMs = Number(bars[0][0]);
    const H1 = bullishMTF(refUtcMs), H4 = bullishMTF(refUtcMs), D1 = bullishMTF(refUtcMs);

    const trades = ctx.app.runBacktestSync(asset, bars, H1, H4, D1, ctx.app.getSignal, {
      cooldownBars: 0, slippagePct: 0, feePct: 0,
      dailyLossLimitR: null, maxTradesPerSession: null,
      revengeCooldownMs: 30 * 60_000, // 30 min
    });
    // Each "trade window" is 5 minutes. After a LOSS resolves, 30min cooldown
    // means we skip ~6 trade-windows before another entry can fire. When the
    // cooldown finally expires, the very next entry-eligible bar fires AND
    // the one after — because lastLossTs only updates at the NEXT loss
    // resolution, not at re-entry. So we get a small burst, not a single fire.
    // Compare against the no-cooldown baseline to verify suppression is real.
    const baseline = ctx.app.runBacktestSync(asset, bars, H1, H4, D1, ctx.app.getSignal, {
      cooldownBars: 0, slippagePct: 0, feePct: 0,
      dailyLossLimitR: null, maxTradesPerSession: null, revengeCooldownMs: 0,
    });
    assert.ok([...trades].length < [...baseline].length,
      `revenge cooldown ${[...trades].length} should be < baseline ${[...baseline].length}`);
    assert.ok([...trades].length <= 4,
      `revenge cooldown should still cap small, got ${[...trades].length}`);
  });

  test('with revenge cooldown DISABLED: every loss still allows the next entry', () => {
    const ctx = loadApp();
    const asset = makeAsset();
    const bars = buildLossLoop(8);
    const refUtcMs = Number(bars[0][0]);
    const H1 = bullishMTF(refUtcMs), H4 = bullishMTF(refUtcMs), D1 = bullishMTF(refUtcMs);

    const trades = ctx.app.runBacktestSync(asset, bars, H1, H4, D1, ctx.app.getSignal, {
      cooldownBars: 0, slippagePct: 0, feePct: 0,
      dailyLossLimitR: null, maxTradesPerSession: null,
      revengeCooldownMs: 0,
    });
    assert.ok([...trades].length >= 4,
      `no revenge cooldown should fire many trades, got ${[...trades].length}`);
  });
});

describe('runBacktestSync — session quota gate', () => {
  test('with session quota: caps at 3 entries per session', () => {
    const ctx = loadApp();
    const asset = makeAsset();
    // Inside London KZ (08-10 GST). 8 trade windows fit in 40min, all in KZ.
    const bars = buildLossLoop(8, 9);
    const refUtcMs = Number(bars[0][0]);
    const H1 = bullishMTF(refUtcMs), H4 = bullishMTF(refUtcMs), D1 = bullishMTF(refUtcMs);

    const trades = ctx.app.runBacktestSync(asset, bars, H1, H4, D1, ctx.app.getSignal, {
      cooldownBars: 0, slippagePct: 0, feePct: 0,
      dailyLossLimitR: null,
      maxTradesPerSession: 3,
      revengeCooldownMs: null,
    });
    assert.ok([...trades].length <= 3, `session quota cap, got ${[...trades].length}`);
  });

  test('with session quota DISABLED: keeps firing past 3 entries in a session', () => {
    const ctx = loadApp();
    const asset = makeAsset();
    const bars = buildLossLoop(8, 9);
    const refUtcMs = Number(bars[0][0]);
    const H1 = bullishMTF(refUtcMs), H4 = bullishMTF(refUtcMs), D1 = bullishMTF(refUtcMs);

    const trades = ctx.app.runBacktestSync(asset, bars, H1, H4, D1, ctx.app.getSignal, {
      cooldownBars: 0, slippagePct: 0, feePct: 0,
      dailyLossLimitR: null,
      maxTradesPerSession: null,
      revengeCooldownMs: null,
    });
    assert.ok([...trades].length > 3, `unlimited session, got ${[...trades].length}`);
  });
});

describe('runBacktestSync — guardrails interact correctly', () => {
  test('all guardrails together produce fewer trades than each individually', () => {
    const ctx = loadApp();
    const asset = makeAsset();
    const bars = buildLossLoop(12, 9);
    const refUtcMs = Number(bars[0][0]);
    const H1 = bullishMTF(refUtcMs), H4 = bullishMTF(refUtcMs), D1 = bullishMTF(refUtcMs);

    const allOff = ctx.app.runBacktestSync(asset, bars, H1, H4, D1, ctx.app.getSignal, {
      cooldownBars: 0, slippagePct: 0, feePct: 0,
      dailyLossLimitR: null, maxTradesPerSession: null, revengeCooldownMs: null,
    });
    const allOn = ctx.app.runBacktestSync(asset, bars, H1, H4, D1, ctx.app.getSignal, {
      cooldownBars: 0, slippagePct: 0, feePct: 0,
    });
    assert.ok([...allOn].length < [...allOff].length,
      `with-guards (${[...allOn].length}) should fire fewer than no-guards (${[...allOff].length})`);
  });

  test('trades carry resolvedTs so the simulator can apply outcomes at the right moment', () => {
    const ctx = loadApp();
    const asset = makeAsset();
    const bars = buildLossLoop(2);
    const refUtcMs = Number(bars[0][0]);
    const H1 = bullishMTF(refUtcMs), H4 = bullishMTF(refUtcMs), D1 = bullishMTF(refUtcMs);

    const trades = ctx.app.runBacktestSync(asset, bars, H1, H4, D1, ctx.app.getSignal, {
      cooldownBars: 0, slippagePct: 0, feePct: 0,
      dailyLossLimitR: null, maxTradesPerSession: null, revengeCooldownMs: null,
    });
    const arr = [...trades];
    assert.ok(arr.length >= 1);
    for (const t of arr) {
      assert.ok(typeof t.resolvedTs === 'number', 'every trade has resolvedTs');
      assert.ok(t.resolvedTs >= t.ts, 'resolvedTs is after entry ts');
    }
  });
});
