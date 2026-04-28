import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadApp, gstDate } from './harness.mjs';

const OFF = gstDate(11, 30);
const LDN = gstDate(9, 0);

function makeAsset(o = {}) {
  return {
    symbol: 'BTC', bias: 'BULLISH',
    entry: 100, sl: 99, tp: 105, tp1: 105, grade: 'a',
    price: 100, change24h: 0,
    checks: [1, 1, 1, 1, 1, 1, 1, 1, 1, 1], reason: '',
    ...o,
  };
}

describe('Confidence floor — never negative', () => {
  test('zero score, mtf misaligned, far from entry, off-session → 0 not negative', async () => {
    const { app } = loadApp();
    app.mtfCache = { BTC: { h1: 'bear', h4: 'bear', d1: 'bear' } }; // mtf score 0 against bull bias → -5
    const a = makeAsset({ price: 110, checks: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0] });
    const conf = app.getConfidencePct(a, OFF);
    assert.ok(conf >= 0, `confidence must be ≥ 0, got ${conf}`);
    assert.equal(conf, 0);
  });

  test('still capped at 99 in best-case', async () => {
    const { app } = loadApp();
    app.mtfCache = { BTC: { h1: 'bull', h4: 'bull', d1: 'bull' } };
    const a = makeAsset({ price: 100.05 });
    const conf = app.getConfidencePct(a, LDN);
    assert.equal(conf, 99);
  });
});

describe('R:R warning surfaced in analyzeAsset', () => {
  test('R:R 1:1 setup → "Sub-2:1 R:R" warning', async () => {
    const { app } = loadApp();
    app.mtfCache = { BTC: { h1: 'bull', h4: 'bull', d1: 'bull' } };
    // entry 100, sl 99 (1$ risk), tp 101 (1$ reward) → R:R 1:1
    const a = makeAsset({ entry: 100, sl: 99, tp: 101, tp1: 101, price: 100.4 });
    const text = app.analyzeAsset(a, LDN);
    assert.match(text, /Sub-2:1 R:R/);
  });

  test('R:R 2.5:1 setup → "below your 1:3" caution', async () => {
    const { app } = loadApp();
    app.mtfCache = { BTC: { h1: 'bull', h4: 'bull', d1: 'bull' } };
    const a = makeAsset({ entry: 100, sl: 99, tp: 102.5, tp1: 102.5, price: 100.4 });
    const text = app.analyzeAsset(a, LDN);
    assert.match(text, /below your 1:3/);
  });

  test('R:R 5:1 setup → no warning', async () => {
    const { app } = loadApp();
    app.mtfCache = { BTC: { h1: 'bull', h4: 'bull', d1: 'bull' } };
    const a = makeAsset({ entry: 100, sl: 99, tp: 105, tp1: 105, price: 100.4 });
    const text = app.analyzeAsset(a, LDN);
    assert.doesNotMatch(text, /Sub-2:1|below your 1:3/);
  });
});

describe('Stale-data guard suppresses alerts', () => {
  function setup() {
    const ctx = loadApp({ fetch: async () => ({ json: async () => [] }) });
    ctx.app.mtfCache = { BTC: { h1: 'bull', h4: 'bull', d1: 'bull' } };
    Object.assign(ctx.app.ASSETS[0], makeAsset({ price: 100.04 }));
    ctx.app.ASSETS.length = 1;
    ctx.app.firstSyncDone = true;
    ctx.app.alertLog = [];
    ctx.app.journal = [];
    ctx.app.prevSignalMap = { BTC: 'wait' };
    return ctx;
  }

  test('with consecutiveSyncFails ≥ 2 → no alerts fire', async () => {
    const ctx = setup();
    ctx.app.consecutiveSyncFails = 2; // simulate 2 failed syncs
    await ctx.app.checkArmedAlerts(LDN);
    assert.equal([...ctx.app.alertLog].length, 0, 'stale data must not trigger alerts');
  });

  test('with consecutiveSyncFails = 0 → alerts fire normally', async () => {
    const ctx = setup();
    ctx.app.consecutiveSyncFails = 0;
    await ctx.app.checkArmedAlerts(LDN);
    assert.ok([...ctx.app.alertLog].length >= 1, 'fresh data should fire normally');
  });
});

describe('CHECK_LABELS resolved (no longer a todo)', () => {
  test('CHECK_LABELS length is 10, every label has a slot in checks', async () => {
    const { app } = loadApp();
    assert.equal(app.CHECK_LABELS.length, 10);
    assert.equal([...app.ASSETS][0].checks.length, 10);
  });

  test('"Premium/Discount" is gone (intentionally — assets do not track it)', async () => {
    const { app } = loadApp();
    assert.ok(![...app.CHECK_LABELS].includes('Premium/Discount'));
  });
});
