import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadApp } from './harness.mjs';

// Kline shape used by the engine: [openTime, open, high, low, close, volume, closeTime]
function k(openTime, open, high, low, close, closeTime) {
  return [openTime, String(open), String(high), String(low), String(close), '0', closeTime ?? openTime + 60_000];
}

describe('simulateTradeOutcome — wick-aware exit detection', () => {
  const { app } = loadApp();

  test('LONG: TP wick on first future bar → win with R multiple', () => {
    const out = app.simulateTradeOutcome('long', 100, 99, 105, [
      k(0, 100, 105.5, 99.5, 102), // wick to 105.5 hits TP
    ]);
    assert.equal(out.outcome, 'win');
    assert.equal(out.barsHeld, 1);
    assert.ok(Math.abs(out.rMultiple - 5) < 1e-9, `expected R=5, got ${out.rMultiple}`);
  });

  test('LONG: SL wick → loss with R = -1', () => {
    const out = app.simulateTradeOutcome('long', 100, 99, 105, [
      k(0, 100, 100.5, 98.5, 99.7), // wick to 98.5 hits SL
    ]);
    assert.equal(out.outcome, 'loss');
    assert.equal(out.rMultiple, -1);
  });

  test('SHORT: TP below entry, low ≤ TP → win', () => {
    const out = app.simulateTradeOutcome('short', 86, 87, 80, [
      k(0, 86, 86.2, 79.8, 81),
    ]);
    assert.equal(out.outcome, 'win');
  });

  test('Both TP and SL hit in same candle → conservative loss', () => {
    const out = app.simulateTradeOutcome('long', 100, 99, 105, [
      k(0, 100, 105.5, 98.5, 100),
    ]);
    assert.equal(out.outcome, 'loss');
  });

  test('Neither hit within range → break-even with R = 0', () => {
    const out = app.simulateTradeOutcome('long', 100, 99, 105, [
      k(0, 100, 100.4, 99.7, 100.1),
      k(60_000, 100.1, 100.3, 99.8, 100.0),
    ], /* maxBars */ 2);
    assert.equal(out.outcome, 'be');
    assert.equal(out.rMultiple, 0);
  });

  test('First-touch wins: TP candle 1, SL candle 2 → win', () => {
    const out = app.simulateTradeOutcome('long', 100, 99, 105, [
      k(0, 100, 105.5, 99.5, 102),  // TP first
      k(60_000, 102, 102.5, 98.5, 99), // SL later, ignored
    ]);
    assert.equal(out.outcome, 'win');
    assert.equal(out.barsHeld, 1);
  });
});

describe('reconstructMTFAt — historical bias replay', () => {
  const { app } = loadApp();

  // Build a tiny H1 series: bullish then bearish then bullish.
  // closeTime is openTime + 1h.
  const H1 = [
    k(1_000_000,       100, 101, 99,  101, 1_000_000 + 3600_000),  // bull
    k(1_000_000 + 1*3600_000, 101, 102, 99,  100, 1_000_000 + 2*3600_000), // bear
    k(1_000_000 + 2*3600_000, 100, 103, 99,  102, 1_000_000 + 3*3600_000), // bull
  ];

  test('returns last completed candle before ts', () => {
    // ts is 30 min into the 2nd candle (still incomplete) — last complete is the 1st (bull)
    const ts = 1_000_000 + 3600_000 + 30 * 60_000;
    const m = app.reconstructMTFAt(H1, [], [], ts);
    assert.equal(m.h1, 'bull');
  });

  test('exactly at closeTime of 2nd candle → 2nd is the latest complete', () => {
    const ts = 1_000_000 + 2 * 3600_000;
    const m = app.reconstructMTFAt(H1, [], [], ts);
    assert.equal(m.h1, 'bear');
  });

  test('before any candle → null', () => {
    const m = app.reconstructMTFAt(H1, [], [], 0);
    assert.equal(m.h1, null);
  });

  test('after all candles → returns the last one', () => {
    const m = app.reconstructMTFAt(H1, [], [], 999_999_999_999);
    assert.equal(m.h1, 'bull');
  });
});

describe('summarizeBacktest — stats math', () => {
  const { app } = loadApp();

  test('mixed trades give a correct win rate and totalR', () => {
    const trades = [
      { outcome: 'win',  rMultiple: 5 },
      { outcome: 'win',  rMultiple: 3 },
      { outcome: 'loss', rMultiple: -1 },
      { outcome: 'be',   rMultiple: 0 },
    ];
    const s = app.summarizeBacktest(trades);
    assert.equal(s.total, 4);
    assert.equal(s.wins, 2);
    assert.equal(s.losses, 1);
    assert.equal(s.breakEvens, 1);
    assert.equal(s.winRate, 0.5);
    assert.equal(s.totalR, 7);
    assert.equal(s.avgR, 1.75);
  });

  test('empty trades → zeroed stats (no NaN)', () => {
    const s = app.summarizeBacktest([]);
    assert.equal(s.total, 0);
    assert.equal(s.winRate, 0);
    assert.equal(s.avgR, 0);
  });
});

describe('runBacktestSync — full pipeline (no network)', () => {
  test('produces a trade when 1m bars cross entry inside an active session', () => {
    const { app, sandbox } = loadApp();
    const asset = {
      symbol: 'TEST', bias: 'BULLISH',
      entry: 100, sl: 99, tp: 105, tp1: 105, grade: 'a',
      checks: [1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
    };

    // Build 1m bars during the London KZ on a fixed UTC date that maps to
    // 9:00 GST (5:00 UTC). 10 bars: first bar prices stretch toward entry,
    // some bars sit AT entry (triggering ENTER), a TP wick later.
    const baseUtcMs = Date.UTC(2024, 5, 15, 5, 0, 0); // 09:00 GST
    const bars = [];
    for (let i = 0; i < 10; i++) {
      const t = baseUtcMs + i * 60_000;
      // Bar 4 closes exactly at entry (triggers ENTER), bar 7 wicks TP.
      const close = i === 4 ? 100 : i === 7 ? 102 : 100 - i * 0.05;
      const high = i === 7 ? 105.5 : close + 0.1;
      const low = close - 0.1;
      bars.push(k(t, close, high, low, close, t + 60_000));
    }

    // H1/H4/D1: a single completed bull candle far in the past so MTF aligns.
    const farPast = baseUtcMs - 24 * 3600_000;
    const H1 = [k(farPast, 99, 102, 99, 101, farPast + 3600_000)]; // bull
    const H4 = [k(farPast, 99, 102, 99, 101, farPast + 4 * 3600_000)];
    const D1 = [k(farPast, 99, 102, 99, 101, farPast + 86_400_000)];

    const trades = app.runBacktestSync(asset, bars, H1, H4, D1, app.getSignal, { cooldownBars: 0 });
    assert.ok(trades.length >= 1, `expected at least 1 trade, got ${trades.length}`);
    const t = trades[0];
    assert.equal(t.symbol, 'TEST');
    assert.equal(t.direction, 'long');
    assert.equal(t.outcome, 'win'); // bar 7 wicks 105.5 → TP=105 hit
  });

  test('cooldown prevents back-to-back simulated entries on the same level', () => {
    const { app } = loadApp();
    const asset = {
      symbol: 'TEST', bias: 'BULLISH',
      entry: 100, sl: 99, tp: 105, tp1: 105, grade: 'a',
      checks: [1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
    };
    const baseUtcMs = Date.UTC(2024, 5, 15, 5, 0, 0);
    // Many bars all sitting AT entry → without cooldown every bar would fire.
    const bars = Array.from({ length: 10 }, (_, i) =>
      k(baseUtcMs + i * 60_000, 100, 100.5, 99.5, 100, baseUtcMs + (i + 1) * 60_000)
    );
    const farPast = baseUtcMs - 24 * 3600_000;
    const H1 = [k(farPast, 99, 102, 99, 101, farPast + 3600_000)];
    const H4 = [k(farPast, 99, 102, 99, 101, farPast + 4 * 3600_000)];
    const D1 = [k(farPast, 99, 102, 99, 101, farPast + 86_400_000)];

    const trades = app.runBacktestSync(asset, bars, H1, H4, D1, app.getSignal, { cooldownBars: 30 });
    assert.equal(trades.length, 1, 'cooldown should collapse repeated entries to one');
  });
});

describe('runBacktest async wrapper (mocked Binance)', () => {
  test('integrates fetch → engine → stats', async () => {
    // Each fetch call returns 1 candle; the wrapper makes 4 calls (1m/1h/4h/1d).
    let call = 0;
    const klineByInterval = {
      '1m': [k(Date.now() - 60_000, 100, 100.5, 99.5, 100, Date.now())],
      '1h': [k(Date.now() - 3600_000, 99, 101, 99, 100, Date.now())],
      '4h': [k(Date.now() - 4*3600_000, 99, 101, 99, 100, Date.now())],
      '1d': [k(Date.now() - 86_400_000, 99, 101, 99, 100, Date.now())],
    };
    const ctx = loadApp({
      fetch: async (url) => {
        call++;
        const u = String(url);
        const interval = (u.match(/interval=(\w+)/) || [])[1];
        return { ok: true, json: async () => klineByInterval[interval] || [] };
      },
    });

    const out = await ctx.app.runBacktest({ symbol: 'BTC', hours: 1 });
    assert.equal(out.symbol, 'BTC');
    assert.equal(out.hours, 1);
    assert.ok(Array.isArray(out.trades));
    assert.ok(call >= 4, 'should fetch 1m + 3 MTF intervals');
  });

  test('non-Binance asset (GOLD) → throws explanatory error', async () => {
    const { app } = loadApp();
    await assert.rejects(() => app.runBacktest({ symbol: 'GOLD' }), /no Binance data/i);
  });

  test('unknown symbol → throws', async () => {
    const { app } = loadApp();
    await assert.rejects(() => app.runBacktest({ symbol: 'NONEXISTENT' }), /Unknown asset/);
  });
});
