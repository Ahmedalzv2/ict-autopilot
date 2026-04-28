import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadApp, gstDate } from './harness.mjs';

// Kline shape: [openTime, open, high, low, close, volume, closeTime]
function k(t, o, h, l, c) {
  return [t, String(o), String(h), String(l), String(c), '0', t + 60_000];
}

describe('findSwings — fractal pivot detection', () => {
  const { app } = loadApp();

  test('clear swing high beats both neighbors on each side (window=3)', () => {
    // 7 bars; index 3 is the pivot — high=110, all others lower.
    const bars = [
      k(0, 100, 102, 99, 101),
      k(60_000, 101, 103, 100, 102),
      k(120_000, 102, 104, 101, 103),
      k(180_000, 103, 110, 102, 109), // ← swing high
      k(240_000, 109, 105, 104, 105),
      k(300_000, 105, 104, 103, 104),
      k(360_000, 104, 103, 102, 102),
    ];
    const { swingHighs } = app.findSwings(bars, 3);
    assert.equal([...swingHighs].length, 1);
    assert.equal([...swingHighs][0].idx, 3);
    assert.equal([...swingHighs][0].price, 110);
  });

  test('clear swing low symmetric to swing high test', () => {
    const bars = [
      k(0, 100, 101, 99, 100),
      k(60_000, 100, 100, 98, 99),
      k(120_000, 99, 99, 97, 98),
      k(180_000, 98, 98, 90, 91),  // ← swing low at 90
      k(240_000, 91, 95, 92, 94),
      k(300_000, 94, 96, 93, 95),
      k(360_000, 95, 97, 94, 96),
    ];
    const { swingLows } = app.findSwings(bars, 3);
    assert.equal([...swingLows].length, 1);
    assert.equal([...swingLows][0].price, 90);
  });

  test('first/last `window` bars are excluded (the test cannot be made)', () => {
    // 7 bars, window=3 → only index 3 is testable.
    const bars = Array.from({ length: 7 }, (_, i) => k(i * 60_000, 100, 101, 99, 100));
    const { swingHighs, swingLows } = app.findSwings(bars, 3);
    // No bar wins (all same), but more importantly no bar at idx<3 or idx>=4 is even tested.
    assert.equal([...swingHighs].length, 0);
    assert.equal([...swingLows].length, 0);
  });

  test('multiple swings detected, returned in chronological order', () => {
    const bars = [
      k(0,        99, 100, 98, 99),
      k(60_000,   99, 102, 99, 101),
      k(120_000, 101, 105, 100, 104),
      k(180_000, 104, 108, 103, 107), // ← high1
      k(240_000, 107, 105, 102, 103),
      k(300_000, 103, 104, 100, 102),
      k(360_000, 102, 103, 100, 102),
      k(420_000, 102, 110, 101, 109), // ← high2
      k(480_000, 109, 108, 105, 107),
      k(540_000, 107, 106, 104, 105),
      k(600_000, 105, 106, 103, 104),
    ];
    const { swingHighs } = app.findSwings(bars, 3);
    const prices = [...swingHighs].map(s => s.price);
    assert.deepEqual(prices, [108, 110]);
  });
});

describe('detectCHoCH — break above swing high / below swing low', () => {
  const { app } = loadApp();

  // Build a series with a confirmed swing high at idx 3 (price 115) followed
  // by a pullback and then a breakout. The swing high must remain a fractal
  // pivot AFTER the breakout candle, so the breakout must NOT have a higher
  // high than the swing high during the fractal-confirmation window. We
  // achieve that by letting the breakout candle close above the swing on
  // the bar's CLOSE, while leaving fractal confirmation to bars 4–6 only
  // (bar 7+ are excluded from fractal detection by window=3).

  test('bullish CHoCH: last close breaks above the most recent swing high', () => {
    // 11 bars; idx 3 is the swing high at 115. Last bar closes at 116.
    // Fractal test for idx 3 examines neighbors at 0,1,2,4,5,6 (all <115).
    const bars = [
      k(0,        100, 105, 99,  104),
      k(60_000,   104, 108, 103, 107),
      k(120_000, 107, 112, 106, 111),
      k(180_000, 111, 115, 110, 113),   // ← swing HIGH at 115 (idx 3)
      k(240_000, 113, 113, 108, 109),   // pullback
      k(300_000, 109, 110, 105, 106),
      k(360_000, 106, 108, 103, 107),   // local low (idx 6)
      k(420_000, 107, 112, 106, 111),
      k(480_000, 111, 113, 110, 112),
      k(540_000, 112, 114, 111, 113),
      k(600_000, 113, 117, 112, 116),   // ← LAST: close 116 > 115
    ];
    const r = app.detectCHoCH(bars, { fractalWindow: 3 });
    assert.equal(r.detected, true);
    assert.equal(r.direction, 'bull');
    assert.equal(r.breakPrice, 116);
    assert.equal(r.swingPrice, 115);
  });

  test('no break: last close stays at or below the swing high', () => {
    // Same fixture but the last close is exactly at the swing (not >).
    const bars = [
      k(0,        100, 105, 99,  104),
      k(60_000,   104, 108, 103, 107),
      k(120_000, 107, 112, 106, 111),
      k(180_000, 111, 115, 110, 113),
      k(240_000, 113, 113, 108, 109),
      k(300_000, 109, 110, 105, 106),
      k(360_000, 106, 108, 103, 107),
      k(420_000, 107, 112, 106, 111),
      k(480_000, 111, 113, 110, 112),
      k(540_000, 112, 114, 111, 113),
      k(600_000, 113, 116, 112, 115),   // ← LAST: close 115 (NOT >)
    ];
    const r = app.detectCHoCH(bars, { fractalWindow: 3 });
    assert.equal(r.detected, false);
  });

  test('bearish CHoCH: last close breaks below the most recent swing low', () => {
    // Mirror of the bull case: swing low at idx 3 = 95, last close 93.
    const bars = [
      k(0,        110, 111, 105, 106),
      k(60_000,   106, 107, 102, 103),
      k(120_000, 103, 104, 98,  99),
      k(180_000,  99, 100,  95,  97),   // ← swing LOW at 95 (idx 3)
      k(240_000,  97, 102,  97,  101),  // bounce
      k(300_000, 101, 105, 100, 104),
      k(360_000, 104, 107, 103, 106),
      k(420_000, 106, 107, 102, 103),
      k(480_000, 103, 104,  98,  99),
      k(540_000,  99, 100,  96,  97),
      k(600_000,  97,  98,  92,  93),   // ← LAST: close 93 < 95
    ];
    const r = app.detectCHoCH(bars, { fractalWindow: 3 });
    assert.equal(r.detected, true);
    assert.equal(r.direction, 'bear');
    assert.equal(r.breakPrice, 93);
    assert.equal(r.swingPrice, 95);
  });

  test('too few bars → pending (cannot run fractal)', () => {
    const r = app.detectCHoCH([k(0, 100, 101, 99, 100)], { fractalWindow: 3 });
    assert.equal(r.pending, true);
    assert.equal(r.detected, false);
  });
});

describe('getCHoCHStatus — cache reader + bias matching', () => {
  function makeAsset(o = {}) {
    return { symbol: 'BTC', bias: 'BULLISH', ...o };
  }

  test('no cache → pending state', () => {
    const { app } = loadApp();
    app.chochCache = {};
    const s = app.getCHoCHStatus(makeAsset());
    assert.equal(s.pending, true);
    assert.equal(s.detected, false);
    assert.equal(s.supportsBias, false);
  });

  test('cache says detected bull + asset is bullish → supportsBias true', () => {
    const { app } = loadApp();
    app.chochCache = { BTC: { detected: true, direction: 'bull', breakPrice: 80100, swingPrice: 80000, ts: Date.now() } };
    const s = app.getCHoCHStatus(makeAsset({ bias: 'BULLISH' }));
    assert.equal(s.detected, true);
    assert.equal(s.supportsBias, true);
    assert.match(s.message, /confirmed/);
  });

  test('cache says bear but asset is bullish → supportsBias false (wrong direction)', () => {
    const { app } = loadApp();
    app.chochCache = { BTC: { detected: true, direction: 'bear', breakPrice: 79900, swingPrice: 80000, ts: Date.now() } };
    const s = app.getCHoCHStatus(makeAsset({ bias: 'BULLISH' }));
    assert.equal(s.detected, true);
    assert.equal(s.supportsBias, false);
    assert.match(s.message, /wrong direction/);
  });

  test('cache says no detection → not pending, not detected', () => {
    const { app } = loadApp();
    app.chochCache = { BTC: { detected: false, ts: Date.now() } };
    const s = app.getCHoCHStatus(makeAsset());
    assert.equal(s.pending, false);
    assert.equal(s.detected, false);
    assert.match(s.message, /No 1m CHoCH break/);
  });
});

describe('getSignal — CHoCH gate on ARMED', () => {
  const LDN = gstDate(9, 0);

  function makeAsset(o = {}) {
    return {
      symbol: 'BTC', bias: 'BULLISH',
      entry: 100, sl: 99, tp: 105, tp1: 105, grade: 'a',
      price: 100.10, change24h: 0,
      checks: [1, 1, 1, 1, 1, 1, 1, 1, 1, 1], reason: '',
      ...o,
    };
  }

  test('CHoCH pending (no fetch yet) → ARMED still fires (don\'t block on missing data)', () => {
    const { app } = loadApp();
    app.mtfCache = { BTC: { h1: 'bull', h4: 'bull', d1: 'bull', ts: Date.now() } };
    app.chochCache = {}; // pending
    assert.equal(app.getSignal(makeAsset(), LDN), 'armed');
  });

  test('CHoCH confirms bull bias → ARMED', () => {
    const { app } = loadApp();
    app.mtfCache = { BTC: { h1: 'bull', h4: 'bull', d1: 'bull', ts: Date.now() } };
    app.chochCache = { BTC: { detected: true, direction: 'bull', breakPrice: 100.5, swingPrice: 100, ts: Date.now() } };
    assert.equal(app.getSignal(makeAsset(), LDN), 'armed');
  });

  test('CHoCH wrong direction → drops to WATCH (no CHoCH = no trade)', () => {
    const { app } = loadApp();
    app.mtfCache = { BTC: { h1: 'bull', h4: 'bull', d1: 'bull', ts: Date.now() } };
    app.chochCache = { BTC: { detected: true, direction: 'bear', breakPrice: 99, swingPrice: 100, ts: Date.now() } };
    // pct=0.10% within 0.5%, score 10 ≥ 7 → falls through to WATCH
    assert.equal(app.getSignal(makeAsset(), LDN), 'watch');
  });

  test('CHoCH not detected (real fetch ran, found nothing) → drops to WATCH', () => {
    const { app } = loadApp();
    app.mtfCache = { BTC: { h1: 'bull', h4: 'bull', d1: 'bull', ts: Date.now() } };
    app.chochCache = { BTC: { detected: false, ts: Date.now() } };
    assert.equal(app.getSignal(makeAsset(), LDN), 'watch');
  });

  test('ENTER (≤ 0.05%) fires regardless of CHoCH (price-at-entry overrides)', () => {
    const { app } = loadApp();
    app.chochCache = { BTC: { detected: false, ts: Date.now() } }; // would block ARMED
    const a = makeAsset({ price: 100.04 });
    assert.equal(app.getSignal(a, LDN), 'enter');
  });
});

describe('getConfidencePct — CHoCH +5/−3 grading', () => {
  const OFF = gstDate(11, 30);

  function makeAsset(o = {}) {
    return {
      symbol: 'BTC', bias: 'BULLISH',
      entry: 100, sl: 99, tp: 105, tp1: 105, grade: 'a',
      price: 100, change24h: 0,
      checks: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0], reason: '',
      ...o,
    };
  }

  test('CHoCH pending → no contribution (score 0, MTF +5, prox 25 → 30)', () => {
    const { app } = loadApp();
    app.mtfCache = { BTC: { h1: 'bull', h4: 'bull', d1: 'bull', ts: Date.now() } };
    app.chochCache = {};
    assert.equal(app.getConfidencePct(makeAsset(), OFF), 30);
  });

  test('CHoCH confirms bias → +5 (total 35)', () => {
    const { app } = loadApp();
    app.mtfCache = { BTC: { h1: 'bull', h4: 'bull', d1: 'bull', ts: Date.now() } };
    app.chochCache = { BTC: { detected: true, direction: 'bull', breakPrice: 100.5, swingPrice: 100, ts: Date.now() } };
    assert.equal(app.getConfidencePct(makeAsset(), OFF), 35);
  });

  test('CHoCH wrong direction → -3 (total 27)', () => {
    const { app } = loadApp();
    app.mtfCache = { BTC: { h1: 'bull', h4: 'bull', d1: 'bull', ts: Date.now() } };
    app.chochCache = { BTC: { detected: true, direction: 'bear', breakPrice: 99, swingPrice: 100, ts: Date.now() } };
    assert.equal(app.getConfidencePct(makeAsset(), OFF), 27);
  });
});

describe('isCHoCHStale', () => {
  const { app } = loadApp();

  test('no cache → stale', () => {
    app.chochCache = {};
    assert.equal(app.isCHoCHStale('BTC'), true);
  });

  test('fresh cache → not stale', () => {
    app.chochCache = { BTC: { detected: true, ts: Date.now() } };
    assert.equal(app.isCHoCHStale('BTC'), false);
  });

  test('cache 90s old → stale (60s threshold)', () => {
    app.chochCache = { BTC: { detected: true, ts: Date.now() - 90_000 } };
    assert.equal(app.isCHoCHStale('BTC'), true);
  });
});
