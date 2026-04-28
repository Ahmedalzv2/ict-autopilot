import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadApp } from './harness.mjs';

// Kline shape used by the engine: [openTime, open, high, low, close, volume, closeTime]
function k(openTime, open, high, low, close, closeTime) {
  return [openTime, String(open), String(high), String(low), String(close), '0', closeTime ?? openTime + 60_000];
}

describe('simulateTradeOutcome — wick-aware exit detection (perfect-fill mode)', () => {
  const { app } = loadApp();
  // These tests pass slippagePct=0 + feePct=0 so we can assert exact R math
  // independent of cost model. The cost model has its own dedicated suite below.
  const PERFECT = { slippagePct: 0, feePct: 0 };

  test('LONG: TP wick on first future bar → win with R = 5 at perfect fill', () => {
    const out = app.simulateTradeOutcome('long', 100, 99, 105, [
      k(0, 100, 105.5, 99.5, 102),
    ], PERFECT);
    assert.equal(out.outcome, 'win');
    assert.equal(out.barsHeld, 1);
    assert.ok(Math.abs(out.rMultiple - 5) < 1e-9, `expected R=5, got ${out.rMultiple}`);
  });

  test('LONG: SL wick → loss with R = -1 at perfect fill', () => {
    const out = app.simulateTradeOutcome('long', 100, 99, 105, [
      k(0, 100, 100.5, 98.5, 99.7),
    ], PERFECT);
    assert.equal(out.outcome, 'loss');
    assert.ok(Math.abs(out.rMultiple - (-1)) < 1e-9);
  });

  test('SHORT: TP below entry, low ≤ TP → win', () => {
    const out = app.simulateTradeOutcome('short', 86, 87, 80, [
      k(0, 86, 86.2, 79.8, 81),
    ], PERFECT);
    assert.equal(out.outcome, 'win');
  });

  test('Both TP and SL hit in same candle → conservative loss', () => {
    const out = app.simulateTradeOutcome('long', 100, 99, 105, [
      k(0, 100, 105.5, 98.5, 100),
    ], PERFECT);
    assert.equal(out.outcome, 'loss');
  });

  test('Neither hit within range → break-even with R = 0 at perfect fill', () => {
    const out = app.simulateTradeOutcome('long', 100, 99, 105, [
      k(0, 100, 100.4, 99.7, 100.1),
      k(60_000, 100.1, 100.3, 99.8, 100.0),
    ], { ...PERFECT, maxBars: 2 });
    assert.equal(out.outcome, 'be');
    assert.equal(out.rMultiple, 0);
  });

  test('First-touch wins: TP candle 1, SL candle 2 → win', () => {
    const out = app.simulateTradeOutcome('long', 100, 99, 105, [
      k(0, 100, 105.5, 99.5, 102),
      k(60_000, 102, 102.5, 98.5, 99),
    ], PERFECT);
    assert.equal(out.outcome, 'win');
    assert.equal(out.barsHeld, 1);
  });
});

describe('simulateTradeOutcome — slippage & fees (realistic-fill costs)', () => {
  const { app } = loadApp();
  const SLIP = 0.0005, FEE = 0.0004;

  test('LONG winner: 5R nominal degrades to ~4.82R after 5bps slip + 4bps fee per side', () => {
    const out = app.simulateTradeOutcome('long', 100, 99, 105, [
      k(0, 100, 105.5, 99.5, 102),
    ], { slippagePct: SLIP, feePct: FEE });
    assert.equal(out.outcome, 'win');
    // effEntry = 100*1.0005 = 100.05; effTP = 105*0.9995 = 104.9475;
    // grossPnl = 4.8975; fees = (100.05+104.9475)*0.0004 ≈ 0.082
    // netPnl ≈ 4.8155; risk = 1; R ≈ 4.8155
    assert.ok(out.rMultiple < 5, `expected R<5 with costs, got ${out.rMultiple}`);
    assert.ok(out.rMultiple > 4.7, `R should still be near 5, got ${out.rMultiple}`);
    assert.ok(Math.abs(out.rMultiple - 4.8155) < 0.01, `expected ~4.8155, got ${out.rMultiple}`);
  });

  test('LONG loser: -1R nominal degrades past -1R after costs', () => {
    const out = app.simulateTradeOutcome('long', 100, 99, 105, [
      k(0, 100, 100.5, 98.5, 99.7),
    ], { slippagePct: SLIP, feePct: FEE });
    assert.equal(out.outcome, 'loss');
    // SL fills lower than 99 by slippage → loss bigger than -1
    assert.ok(out.rMultiple < -1, `loss should exceed -1R after costs, got ${out.rMultiple}`);
  });

  test('Break-even still pays fees → small negative R, never positive', () => {
    const out = app.simulateTradeOutcome('long', 100, 99, 105, [
      k(0, 100, 100.4, 99.7, 100.1),
      k(60_000, 100.1, 100.3, 99.8, 100.0),
    ], { slippagePct: SLIP, feePct: FEE, maxBars: 2 });
    assert.equal(out.outcome, 'be');
    assert.ok(out.rMultiple < 0, `BE should be slightly negative after fees, got ${out.rMultiple}`);
    assert.ok(out.rMultiple > -0.1, `but only marginally — got ${out.rMultiple}`);
  });

  test('SHORT winner: slippage applied symmetrically (sell lower, buy back higher)', () => {
    // SHORT entry 86, sl 87 (risk 1), tp 80 (reward 6)
    const out = app.simulateTradeOutcome('short', 86, 87, 80, [
      k(0, 86, 86.2, 79.8, 81),
    ], { slippagePct: SLIP, feePct: FEE });
    assert.equal(out.outcome, 'win');
    // effEntry = 86*0.9995 = 85.957; effTP = 80*1.0005 = 80.04
    // grossPnl = 85.957 - 80.04 = 5.917; fees ≈ (85.957+80.04)*0.0004 ≈ 0.066
    // netPnl ≈ 5.851; risk = 1; R ≈ 5.851 (vs nominal 6)
    assert.ok(out.rMultiple < 6, `R<6 with costs, got ${out.rMultiple}`);
    assert.ok(out.rMultiple > 5.7, `R should still be near 6, got ${out.rMultiple}`);
  });

  test('higher slippage / higher fees → lower net R (monotonic)', () => {
    const baseBars = [k(0, 100, 105.5, 99.5, 102)];
    const cheap = app.simulateTradeOutcome('long', 100, 99, 105, baseBars, { slippagePct: 0.0001, feePct: 0.0001 });
    const expensive = app.simulateTradeOutcome('long', 100, 99, 105, baseBars, { slippagePct: 0.001, feePct: 0.001 });
    assert.ok(cheap.rMultiple > expensive.rMultiple, 'higher costs → lower R');
  });

  test('zero risk (entry === sl) → BE, no division by zero', () => {
    const out = app.simulateTradeOutcome('long', 100, 100, 105, [
      k(0, 100, 105.5, 99.5, 102),
    ]);
    assert.equal(out.outcome, 'be');
    assert.equal(out.rMultiple, 0);
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

describe('runBacktestAll — multi-asset aggregation', () => {
  test('runs every Binance-listed asset and aggregates trades + per-asset stats', async () => {
    const klineByInterval = {
      '1m': [k(Date.now() - 60_000, 100, 100.5, 99.5, 100, Date.now())],
      '1h': [k(Date.now() - 3600_000, 99, 101, 99, 100, Date.now())],
      '4h': [k(Date.now() - 4*3600_000, 99, 101, 99, 100, Date.now())],
      '1d': [k(Date.now() - 86_400_000, 99, 101, 99, 100, Date.now())],
    };
    const ctx = loadApp({
      fetch: async (url) => {
        const interval = (String(url).match(/interval=(\w+)/) || [])[1];
        return { ok: true, json: async () => klineByInterval[interval] || [] };
      },
    });
    const out = await ctx.app.runBacktestAll({ hours: 1 });
    // Every asset that's NOT in NON_BINANCE_ASSETS should appear.
    const expected = [...ctx.app.ASSETS]
      .filter(a => ![...ctx.app.NON_BINANCE_ASSETS].includes(a.symbol))
      .map(a => a.symbol).sort();
    const got = [...out.perAsset].map(r => r.symbol).sort();
    assert.deepEqual(got, expected);
    assert.ok(out.overall, 'aggregate stats present');
    assert.equal(typeof out.overall.winRate, 'number');
  });

  test('one symbol failing does not abort the rest (per-asset error captured)', async () => {
    let call = 0;
    const ctx = loadApp({
      fetch: async (url) => {
        call++;
        // Fail every fetch for the first symbol to force runBacktest to throw
        // for that symbol; subsequent symbols still run normally.
        if (String(url).includes('BTCUSDT')) throw new Error('binance hates us');
        return { ok: true, json: async () => [k(Date.now() - 60_000, 100, 100.5, 99.5, 100, Date.now())] };
      },
    });
    const out = await ctx.app.runBacktestAll({ hours: 1 });
    const btcRow = [...out.perAsset].find(r => r.symbol === 'BTC');
    assert.ok(btcRow.error, 'BTC failure should be captured per-row');
    // Non-failing rows should have stats objects
    const others = [...out.perAsset].filter(r => r.symbol !== 'BTC' && !r.error);
    assert.ok(others.length > 0, 'other assets succeed');
  });
});

describe('Confidence MTF tiers (2/3 and 1/3 now contribute)', () => {
  function makeAsset(o = {}) {
    return {
      symbol: 'BTC', bias: 'BULLISH',
      entry: 100, sl: 99, tp: 105, tp1: 105, grade: 'a',
      price: 100, change24h: 0,
      checks: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0], reason: '',
      ...o,
    };
  }

  // Off-session GST hour (no session) so sessComp = 0.
  // Use a Date with .getHours() = 11 (off-session: between London KZ close
  // at 10:00 and NY AM open at 13:00).
  const OFF = new Date(2024, 5, 15, 11, 30, 0);

  test('MTF 3/3 → +5 (unchanged)', () => {
    const { app } = loadApp();
    app.mtfCache = { BTC: { h1: 'bull', h4: 'bull', d1: 'bull', ts: Date.now() } };
    const conf = app.getConfidencePct(makeAsset({ price: 100 }), OFF);
    // score 0, prox 25, sess 0, mtf +5 → 30
    assert.equal(conf, 30);
  });

  test('MTF 2/3 → +3 (newly credited — was 0)', () => {
    const { app } = loadApp();
    app.mtfCache = { BTC: { h1: 'bull', h4: 'bull', d1: 'bear', ts: Date.now() } };
    const conf = app.getConfidencePct(makeAsset({ price: 100 }), OFF);
    // score 0, prox 25, sess 0, mtf +3 → 28
    assert.equal(conf, 28);
  });

  test('MTF 1/3 → -2 (newly penalised — was 0)', () => {
    const { app } = loadApp();
    app.mtfCache = { BTC: { h1: 'bull', h4: 'bear', d1: 'bear', ts: Date.now() } };
    const conf = app.getConfidencePct(makeAsset({ price: 100 }), OFF);
    // score 0, prox 25, sess 0, mtf -2 → 23
    assert.equal(conf, 23);
  });

  test('MTF 0/3 → -5 (unchanged)', () => {
    const { app } = loadApp();
    app.mtfCache = { BTC: { h1: 'bear', h4: 'bear', d1: 'bear', ts: Date.now() } };
    const conf = app.getConfidencePct(makeAsset({ price: 100 }), OFF);
    // score 0, prox 25, sess 0, mtf -5 → 20
    assert.equal(conf, 20);
  });
});
