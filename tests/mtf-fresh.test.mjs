import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadApp, gstDate } from './harness.mjs';

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

describe('isMTFStale', () => {
  test('no cache → stale (forces fetch)', () => {
    const { app } = loadApp();
    app.mtfCache = {};
    assert.equal(app.isMTFStale('BTC'), true);
  });

  test('cache without ts → stale', () => {
    const { app } = loadApp();
    app.mtfCache = { BTC: { h1: 'bull', h4: 'bull', d1: 'bull' } };
    assert.equal(app.isMTFStale('BTC'), true);
  });

  test('cache fresh (just now) → not stale', () => {
    const { app } = loadApp();
    app.mtfCache = { BTC: { h1: 'bull', h4: 'bull', d1: 'bull', ts: Date.now() } };
    assert.equal(app.isMTFStale('BTC'), false);
  });

  test('cache 90s old → stale (threshold is 60s)', () => {
    const { app } = loadApp();
    app.mtfCache = { BTC: { h1: 'bull', h4: 'bull', d1: 'bull', ts: Date.now() - 90_000 } };
    assert.equal(app.isMTFStale('BTC'), true);
  });
});

describe('checkArmedAlerts: fresh-MTF refetch on escalation', () => {
  function setup({ price, mtfTs, fetchKlines }) {
    let fetchCalls = 0;
    const ctx = loadApp({
      fetch: async (url) => {
        fetchCalls++;
        // Detect MTF kline requests vs other requests
        if (url && String(url).includes('klines')) {
          return { ok: true, json: async () => fetchKlines };
        }
        return { ok: true, json: async () => [] };
      },
    });
    ctx.app.mtfCache = { BTC: { h1: 'bull', h4: 'bull', d1: 'bull', ts: mtfTs } };
    // Prime CHoCH cache as fresh + supporting so the new CHoCH refetch
    // path doesn't trigger; this test is about MTF refetch behavior.
    ctx.app.chochCache = { BTC: { detected: true, direction: 'bull', breakPrice: 100.5, swingPrice: 100, swingTs: 0, ts: Date.now() } };
    Object.assign(ctx.app.ASSETS[0], makeAsset({ price }));
    ctx.app.ASSETS.length = 1;
    ctx.app.firstSyncDone = true;
    ctx.app.consecutiveSyncFails = 0;
    ctx.app.alertLog = [];
    ctx.app.journal = [];
    ctx.app.prevSignalMap = { BTC: 'wait' };
    ctx.app.lastAlertMs = {};
    return { ctx, fetchCalls: () => fetchCalls };
  }

  // fetchMTFAlignment reads klines[length-2] (the last complete candle). For
  // a 2-element fixture that is index 0. close > open = bull, close < open = bear.
  // Format: [openTime, open, high, low, close, volume, closeTime]
  const BULL_KLINES = [
    [0, '99',  '102', '98',  '101', '0', 0],   // open 99, close 101 → bull
    [0, '101', '102', '99',  '100', '0', 0],   // (current/incomplete — ignored)
  ];
  const BEAR_KLINES = [
    [0, '101', '102', '98',  '99',  '0', 0],   // open 101, close 99 → bear
    [0, '99',  '100', '97',  '98',  '0', 0],   // (current/incomplete — ignored)
  ];

  test('fresh MTF → no refetch on escalation', async () => {
    const { ctx, fetchCalls } = setup({
      price: 100.10,                 // armed
      mtfTs: Date.now(),             // fresh
      fetchKlines: BULL_KLINES,
    });
    await ctx.app.checkArmedAlerts(LDN);
    assert.equal(fetchCalls(), 0, 'fresh cache should not trigger MTF refetch');
    assert.ok([...ctx.app.alertLog].length >= 1, 'alert fires on escalation');
  });

  test('stale MTF + escalation to ARMED → triggers refetch', async () => {
    const { ctx, fetchCalls } = setup({
      price: 100.10,                 // armed
      mtfTs: Date.now() - 5 * 60_000, // stale
      fetchKlines: BULL_KLINES,
    });
    await ctx.app.checkArmedAlerts(LDN);
    assert.ok(fetchCalls() > 0, 'stale cache forces MTF refetch');
  });

  test('stale MTF + refresh shows MTF flipped → ARMED downgrades, no alert fires', async () => {
    // Set up with stale MTF claiming bull, but the refetch returns bear klines
    // (last complete candle closes below open). After refetch, MTF score drops
    // to 0/3 against the bull bias, getSignal falls back to 'watch', and we
    // do NOT fire an ARMED alert.
    const { ctx } = setup({
      price: 100.10,
      mtfTs: Date.now() - 5 * 60_000, // stale
      fetchKlines: BEAR_KLINES,        // refetch returns bearish bias
    });
    await ctx.app.checkArmedAlerts(LDN);
    // The fresh MTF will flip h1/h4/d1 → all bear vs our bull bias → mtf.score=0.
    // armed gate (mtf.score >= 2) fails → drops to watch.
    // Watch escalation does still fire — but NOT an armed alert.
    const fired = [...ctx.app.alertLog];
    assert.ok(!fired.some(a => a.signal === 'armed'), 'no ARMED alert on misaligned fresh MTF');
  });

  test('escalation to WATCH does not trigger MTF refetch (only armed/enter do)', async () => {
    const { ctx, fetchCalls } = setup({
      price: 100.40,                 // watch zone
      mtfTs: Date.now() - 5 * 60_000, // stale
      fetchKlines: BULL_KLINES,
    });
    await ctx.app.checkArmedAlerts(LDN);
    assert.equal(fetchCalls(), 0, 'WATCH alerts do not need fresh MTF');
  });
});
