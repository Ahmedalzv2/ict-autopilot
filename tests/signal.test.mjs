import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadApp, gstDate } from './harness.mjs';

/**
 * Signal ladder you defined in getSignal:
 *   enter  : pct ≤ 0.05% (proximity alone — fires regardless of session/score)
 *   armed  : pct ≤ 0.15% AND score ≥ 9 AND in Kill Zone (active OR macro) AND MTF ≥ 2/3
 *   watch  : pct ≤ 0.5%  AND score ≥ 7
 *   skip   : score < 4 OR Dead Zone
 *   wait   : everything else
 */

function makeAsset(overrides = {}) {
  return {
    symbol: 'TEST',
    bias: 'BULLISH',
    entry: 100,
    sl: 99,
    tp: 105,
    tp1: 105,
    grade: 'a',
    price: 100,
    change24h: 0,
    checks: [1, 1, 1, 1, 1, 1, 1, 1, 1, 1], // score 10
    reason: '',
    ...overrides,
  };
}

function loadWithMTF(mtf) {
  const ctx = loadApp();
  if (mtf) ctx.app.mtfCache = { TEST: mtf };
  return ctx.app;
}

const LDN = gstDate(9, 0);     // London KZ active
const NY  = gstDate(13, 30);   // NY AM active
const MAC = gstDate(18, 55);   // ICT Macro AM active
const DEAD = gstDate(20, 0);   // Dead Zone
const OFF  = gstDate(11, 30);  // Off-session
const SBPM = gstDate(22, 55);  // Silver Bullet PM (macro)

describe('getSignal: ENTER NOW (proximity ≤ 0.05%)', () => {
  test('fires when price is within 0.05% of entry', () => {
    const app = loadWithMTF({ h1: 'bull', h4: 'bull', d1: 'bull' });
    const a = makeAsset({ price: 100.04 }); // 0.04% above entry
    assert.equal(app.getSignal(a, LDN), 'enter');
  });

  test('boundary: exactly 0.05% → still enter', () => {
    const app = loadWithMTF({ h1: 'bull', h4: 'bull', d1: 'bull' });
    const a = makeAsset({ price: 100.05 }); // exactly 0.05%
    assert.equal(app.getSignal(a, LDN), 'enter');
  });

  test('CURRENT BEHAVIOR (worth confirming): ENTER fires even in Dead Zone', () => {
    // Proximity-only check — no session gate. If you want Dead Zone to
    // suppress ENTER too, this test will need to change with the code.
    const app = loadWithMTF({ h1: 'bull', h4: 'bull', d1: 'bull' });
    const a = makeAsset({ price: 100.04 });
    assert.equal(app.getSignal(a, DEAD), 'enter');
  });

  test('CURRENT BEHAVIOR: ENTER fires regardless of score', () => {
    // Even with score 0, if price is at entry, enter fires.
    const app = loadWithMTF({ h1: 'bull', h4: 'bull', d1: 'bull' });
    const a = makeAsset({ price: 100.04, checks: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0] });
    assert.equal(app.getSignal(a, LDN), 'enter');
  });
});

describe('getSignal: ARMED (proximity ≤ 0.15% + score ≥ 9 + KZ + MTF ≥ 2/3)', () => {
  test('all gates passed → armed', () => {
    const app = loadWithMTF({ h1: 'bull', h4: 'bull', d1: 'bull' });
    const a = makeAsset({ price: 100.10 }); // 0.10%, score 10
    assert.equal(app.getSignal(a, LDN), 'armed');
  });

  test('macro session counts as KZ (Silver Bullet PM)', () => {
    const app = loadWithMTF({ h1: 'bull', h4: 'bull', d1: 'bull' });
    const a = makeAsset({ price: 100.10 });
    assert.equal(app.getSignal(a, SBPM), 'armed');
  });

  test('ICT Macro AM (18:50) also counts as KZ', () => {
    const app = loadWithMTF({ h1: 'bull', h4: 'bull', d1: 'bull' });
    const a = makeAsset({ price: 100.10 });
    assert.equal(app.getSignal(a, MAC), 'armed');
  });

  test('outside KZ → falls through to watch', () => {
    const app = loadWithMTF({ h1: 'bull', h4: 'bull', d1: 'bull' });
    const a = makeAsset({ price: 100.10 });
    assert.equal(app.getSignal(a, OFF), 'watch'); // pct=0.10% ≤ 0.5% and score ≥ 7
  });

  test('score 8 → not armed (needs ≥ 9)', () => {
    const app = loadWithMTF({ h1: 'bull', h4: 'bull', d1: 'bull' });
    const a = makeAsset({ price: 100.10, checks: [1, 1, 1, 1, 1, 1, 1, 1, 0, 0] });
    assert.equal(app.getSignal(a, LDN), 'watch');
  });

  test('MTF 1/3 → not armed (needs 2/3)', () => {
    const app = loadWithMTF({ h1: 'bull', h4: 'bear', d1: 'bear' });
    const a = makeAsset({ price: 100.10 });
    assert.equal(app.getSignal(a, LDN), 'watch'); // falls to watch
  });

  test('MTF pending (no cache) → score 0, but pending counts as not aligned → not armed', () => {
    // Verifies the implicit interaction between getMTFAligned's pending state
    // and getSignal's `mtf.score >= 2` gate.
    const ctx = loadApp(); // no mtfCache populated
    const a = makeAsset({ price: 100.10 });
    assert.equal(ctx.app.getSignal(a, LDN), 'watch');
  });

  test('just inside 0.15% with score 9 + MTF 2/3 → armed', () => {
    // Note: 100.15 exactly produces 0.0015000000000005 due to FP — sits just
    // outside the threshold. We test 0.14% which is unambiguously inside.
    const app = loadWithMTF({ h1: 'bull', h4: 'bull', d1: 'bear' }); // 2/3
    const a = makeAsset({ price: 100.14, checks: [1, 1, 1, 1, 1, 1, 1, 1, 1, 0] }); // score 9
    assert.equal(app.getSignal(a, LDN), 'armed');
  });

  test('FP edge: 100.15 (intended 0.15%) drops to watch — guarding against silent regressions', () => {
    // Documents that the boundary is sensitive to floating-point representation.
    // If you tighten the comparison (e.g. <=0.0015 + epsilon), update this test.
    const app = loadWithMTF({ h1: 'bull', h4: 'bull', d1: 'bear' });
    const a = makeAsset({ price: 100.15, checks: [1, 1, 1, 1, 1, 1, 1, 1, 1, 0] });
    assert.equal(app.getSignal(a, LDN), 'watch');
  });
});

describe('getSignal: WATCH (proximity ≤ 0.5% + score ≥ 7)', () => {
  test('outside KZ, score 7, within 0.5% → watch', () => {
    const app = loadWithMTF({ h1: 'bull', h4: 'bull', d1: 'bull' });
    const a = makeAsset({ price: 100.40, checks: [1, 1, 1, 1, 1, 1, 1, 0, 0, 0] });
    assert.equal(app.getSignal(a, OFF), 'watch');
  });

  test('score 6 → not watch (drops to wait)', () => {
    const app = loadWithMTF({ h1: 'bull', h4: 'bull', d1: 'bull' });
    const a = makeAsset({ price: 100.40, checks: [1, 1, 1, 1, 1, 1, 0, 0, 0, 0] });
    assert.equal(app.getSignal(a, OFF), 'wait');
  });

  test('boundary: exactly 0.5% with score 7 → watch', () => {
    const app = loadWithMTF({ h1: 'bull', h4: 'bull', d1: 'bull' });
    const a = makeAsset({ price: 100.5, checks: [1, 1, 1, 1, 1, 1, 1, 0, 0, 0] });
    assert.equal(app.getSignal(a, OFF), 'watch');
  });
});

describe('getSignal: SKIP', () => {
  test('score < 4 → skip', () => {
    const app = loadWithMTF({ h1: 'bull', h4: 'bull', d1: 'bull' });
    const a = makeAsset({ price: 110, checks: [1, 1, 1, 0, 0, 0, 0, 0, 0, 0] });
    assert.equal(app.getSignal(a, LDN), 'skip');
  });

  test('Dead Zone → skip even with score 10', () => {
    const app = loadWithMTF({ h1: 'bull', h4: 'bull', d1: 'bull' });
    const a = makeAsset({ price: 110 }); // far from entry, score 10
    assert.equal(app.getSignal(a, DEAD), 'skip');
  });
});

describe('getSignal: WAIT (default)', () => {
  test('far from entry but score adequate → wait', () => {
    const app = loadWithMTF({ h1: 'bull', h4: 'bull', d1: 'bull' });
    const a = makeAsset({ price: 102, checks: [1, 1, 1, 1, 1, 0, 0, 0, 0, 0] }); // 2% away, score 5
    assert.equal(app.getSignal(a, LDN), 'wait');
  });
});

describe('isInvalidated + getSignal "invalid" short-circuit', () => {
  test('LONG: price above SL → not invalidated', () => {
    const { app } = loadApp();
    assert.equal(app.isInvalidated({ entry: 100, sl: 99, price: 100 }), false);
    assert.equal(app.isInvalidated({ entry: 100, sl: 99, price: 99.5 }), false);
  });

  test('LONG: price at or below SL → invalidated', () => {
    const { app } = loadApp();
    assert.equal(app.isInvalidated({ entry: 100, sl: 99, price: 99 }), true);
    assert.equal(app.isInvalidated({ entry: 100, sl: 99, price: 98 }), true);
  });

  test('SHORT: price below SL → not invalidated', () => {
    const { app } = loadApp();
    assert.equal(app.isInvalidated({ entry: 100, sl: 101, price: 100 }), false);
    assert.equal(app.isInvalidated({ entry: 100, sl: 101, price: 100.5 }), false);
  });

  test('SHORT: price at or above SL → invalidated', () => {
    const { app } = loadApp();
    assert.equal(app.isInvalidated({ entry: 100, sl: 101, price: 101 }), true);
    assert.equal(app.isInvalidated({ entry: 100, sl: 101, price: 102 }), true);
  });

  test('missing fields → not invalidated', () => {
    const { app } = loadApp();
    assert.equal(app.isInvalidated(null), false);
    assert.equal(app.isInvalidated({}), false);
    assert.equal(app.isInvalidated({ entry: 100, sl: 0, price: 100 }), false);
    assert.equal(app.isInvalidated({ entry: 100, sl: 99, price: 0 }), false);
  });

  test('SL equals entry (malformed) → not invalidated', () => {
    const { app } = loadApp();
    assert.equal(app.isInvalidated({ entry: 100, sl: 100, price: 100 }), false);
  });

  test('getSignal: invalidated LONG never fires enter, even at perfect proximity', () => {
    const app = loadWithMTF({ h1: 'bull', h4: 'bull', d1: 'bull' });
    // price exactly at entry (would normally → 'enter') but already crossed SL
    const a = makeAsset({ price: 99, entry: 100, sl: 99 });
    a.price = 100; // tweak: pretend it bounced back to entry zone
    a.sl = 99;
    // Actually invalidated test: price ≤ SL
    a.price = 98.5;
    assert.equal(app.getSignal(a, LDN), 'invalid');
  });

  test('getSignal: invalidated SHORT never fires enter', () => {
    const app = loadWithMTF({ h1: 'bear', h4: 'bear', d1: 'bear' });
    const a = makeAsset({ bias: 'BEARISH', entry: 100, sl: 101, price: 102 });
    assert.equal(app.getSignal(a, LDN), 'invalid');
  });

  test('analyzeAsset: invalidated produces a stand-aside paragraph', () => {
    const { app } = loadApp();
    const a = makeAsset({ entry: 100, sl: 99, price: 98.5 });
    const text = app.analyzeAsset(a, LDN);
    assert.match(text, /INVALIDATED/);
    assert.match(text, /stop-loss/i);
    // Must NOT mislead the user into thinking the trade is on
    assert.doesNotMatch(text, /ENTER NOW — EXECUTE/);
  });
});

describe('getMTFAligned (multi-timeframe consensus)', () => {
  test('no cache → pending, aligned=true (UI fallback), score 0', () => {
    const { app } = loadApp();
    const a = { symbol: 'TEST', bias: 'BULLISH' };
    const mtf = app.getMTFAligned(a);
    assert.equal(mtf.pending, true);
    assert.equal(mtf.score, 0);
  });

  test('all 3 match bullish bias → score 3, aligned=true', () => {
    const { app } = loadApp();
    app.mtfCache = { TEST: { h1: 'bull', h4: 'bull', d1: 'bull' } };
    const mtf = app.getMTFAligned({ symbol: 'TEST', bias: 'BULLISH' });
    assert.equal(mtf.score, 3);
    assert.equal(mtf.aligned, true);
  });

  test('2 of 3 match → score 2, aligned=false', () => {
    const { app } = loadApp();
    app.mtfCache = { TEST: { h1: 'bull', h4: 'bull', d1: 'bear' } };
    const mtf = app.getMTFAligned({ symbol: 'TEST', bias: 'BULLISH' });
    assert.equal(mtf.score, 2);
    assert.equal(mtf.aligned, false);
  });

  test('bias defaults to bear when string lacks "bull"', () => {
    const { app } = loadApp();
    app.mtfCache = { TEST: { h1: 'bear', h4: 'bear', d1: 'bear' } };
    const bullishMatch = app.getMTFAligned({ symbol: 'TEST', bias: 'IN FLUX' }); // not "bull" → falls to bear
    assert.equal(bullishMatch.score, 3);
  });
});

describe('getConfidencePct (score + proximity + session, capped at 99)', () => {
  test('full alignment near entry inside KZ → near max', () => {
    const { app } = loadApp();
    app.mtfCache = { TEST: { h1: 'bull', h4: 'bull', d1: 'bull' } };
    const a = makeAsset({ price: 100.05 }); // 0.05% off
    const conf = app.getConfidencePct(a, LDN);
    // score: 10/10 * 60 = 60, +5 MTF bonus = 65, prox 25, sess 15 → 105 → capped 99
    assert.equal(conf, 99);
  });

  test('off-session, far from entry, score 0 → very low', () => {
    const { app } = loadApp();
    app.mtfCache = { TEST: { h1: 'bear', h4: 'bear', d1: 'bear' } }; // mtf score 0
    const a = makeAsset({ price: 110, checks: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0] });
    const conf = app.getConfidencePct(a, OFF);
    // score 0 * 60 = 0, MTF -5, prox 0, sess 0 → -5 → Math.min(99, -5) → -5
    // (Documents current behavior; you may want a Math.max(0, …) floor.)
    assert.ok(conf <= 0, `expected ≤ 0, got ${conf}`);
  });

  test('Dead Zone gives ZERO session credit (no entries during Dead Zone — ICT rule)', () => {
    const { app } = loadApp();
    app.mtfCache = { TEST: { h1: 'bull', h4: 'bull', d1: 'bull' } };
    const a = makeAsset({ price: 100, checks: [1, 1, 1, 1, 1, 0, 0, 0, 0, 0] }); // score 5
    const conf = app.getConfidencePct(a, DEAD);
    // score 5/10 * 60 = 30, MTF +5 (3 of 3), prox 25 (pct=0), sess 0 (Dead Zone)
    // → 30 + 5 + 25 + 0 = 60
    assert.equal(conf, 60);
  });

  test('proximity tiers aligned with getSignal: 0.05/0.15/0.5/1% grant 25/20/12/5', () => {
    const { app } = loadApp();
    app.mtfCache = { TEST: { h1: 'bull', h4: 'bull', d1: 'bull' } };
    // Inputs are chosen unambiguously inside each tier (floating point
    // representation of "boundary" values like 0.0015 isn't reliable).
    const cases = [
      [0.0003, 25], // enter zone (≤ 0.05%)
      [0.001,  20], // armed zone (> 0.05%, ≤ 0.15%)
      [0.003,  12], // watch zone (> 0.15%, ≤ 0.5%)
      [0.008,   5], // radar    (> 0.5%, ≤ 1.0%)
      [0.05,    0], // out of range
    ];
    for (const [pct, expectedProx] of cases) {
      const a = makeAsset({
        entry: 100,
        price: 100 + 100 * pct,
        checks: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
      });
      const conf = app.getConfidencePct(a, OFF);
      // sessComp = 0 (off-session), scoreComp = 0, MTF +5 (score 3 of 3)
      assert.equal(conf, 5 + expectedProx, `pct=${pct} expected prox ${expectedProx}, conf=${conf}`);
    }
  });
});

describe('analyzeAsset narrative', () => {
  test('ENTER signal mentions LIMIT, SL and TP1 prices', () => {
    const { app } = loadApp();
    app.mtfCache = { TEST: { h1: 'bull', h4: 'bull', d1: 'bull' } };
    const a = makeAsset({ price: 100.04 });
    const text = app.analyzeAsset(a, LDN);
    assert.match(text, /LIMIT/);
    assert.match(text, /Stop Loss/);
    assert.match(text, /TP1/);
  });

  test('Dead Zone analysis tells the user to stand down', () => {
    const { app } = loadApp();
    const a = makeAsset({ price: 110 });
    const text = app.analyzeAsset(a, DEAD);
    assert.match(text, /Dead Zone/i);
  });

  test('SPOT mode produces accumulation-language, not entry/SL/TP language', () => {
    const { app } = loadApp();
    const a = makeAsset({ tradeMode: 'spot', price: 100.1 });
    const text = app.analyzeAsset(a, LDN);
    assert.match(text, /SPOT/);
    assert.match(text, /accumulation|accumulate/i);
    assert.doesNotMatch(text, /Stop Loss/);
  });
});
