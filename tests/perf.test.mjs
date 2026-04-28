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

describe('getCachedAssetState — per-tick memoization', () => {
  test('returns the same object across repeat calls within TTL (cache hit)', () => {
    const ctx = loadApp();
    ctx.app.mtfCache  = { BTC: { h1: 'bull', h4: 'bull', d1: 'bull', ts: Date.now() } };
    ctx.app.chochCache = { BTC: { detected: true, direction: 'bull', breakPrice: 100.5, swingPrice: 100, ts: Date.now() } };
    Object.assign(ctx.app.ASSETS[0], makeAsset({ price: 100.04 }));
    ctx.app.ASSETS.length = 1;

    const a1 = ctx.app.getCachedAssetState(ctx.app.ASSETS[0], LDN);
    const a2 = ctx.app.getCachedAssetState(ctx.app.ASSETS[0], LDN);
    // Same JS reference — second call hit the cache, didn't recompute.
    assert.equal(a1, a2);
    assert.equal(a1.signal, 'enter');
  });

  test('busts when price changes (price is part of the cache key)', () => {
    const ctx = loadApp();
    ctx.app.mtfCache  = { BTC: { h1: 'bull', h4: 'bull', d1: 'bull', ts: Date.now() } };
    ctx.app.chochCache = { BTC: { detected: true, direction: 'bull', breakPrice: 100.5, swingPrice: 100, ts: Date.now() } };
    Object.assign(ctx.app.ASSETS[0], makeAsset({ price: 100.04 }));
    ctx.app.ASSETS.length = 1;

    const a1 = ctx.app.getCachedAssetState(ctx.app.ASSETS[0], LDN);
    ctx.app.ASSETS[0].price = 99.50; // price moved
    const a2 = ctx.app.getCachedAssetState(ctx.app.ASSETS[0], LDN);
    assert.notEqual(a1, a2, 'price change should invalidate the cache');
  });

  test('explicit invalidate(symbol) busts only that key', () => {
    const ctx = loadApp();
    ctx.app.mtfCache  = { BTC: { h1: 'bull', h4: 'bull', d1: 'bull', ts: Date.now() } };
    ctx.app.chochCache = { BTC: { detected: true, direction: 'bull', breakPrice: 100.5, swingPrice: 100, ts: Date.now() } };
    Object.assign(ctx.app.ASSETS[0], makeAsset({ price: 100.04 }));
    ctx.app.ASSETS.length = 1;

    const a1 = ctx.app.getCachedAssetState(ctx.app.ASSETS[0], LDN);
    ctx.app.invalidateAssetStateCache('BTC');
    const a2 = ctx.app.getCachedAssetState(ctx.app.ASSETS[0], LDN);
    assert.notEqual(a1, a2);
  });

  test('explicit invalidate() with no arg clears all entries', () => {
    const ctx = loadApp();
    ctx.app.mtfCache  = { BTC: { h1: 'bull', h4: 'bull', d1: 'bull', ts: Date.now() } };
    Object.assign(ctx.app.ASSETS[0], makeAsset({ price: 100.04 }));
    ctx.app.ASSETS.length = 1;

    const a1 = ctx.app.getCachedAssetState(ctx.app.ASSETS[0], LDN);
    ctx.app.invalidateAssetStateCache();
    const a2 = ctx.app.getCachedAssetState(ctx.app.ASSETS[0], LDN);
    assert.notEqual(a1, a2, 'global invalidate should bust BTC entry too');
  });

  test('cached state matches the underlying helpers exactly', () => {
    const ctx = loadApp();
    ctx.app.mtfCache  = { BTC: { h1: 'bull', h4: 'bull', d1: 'bull', ts: Date.now() } };
    ctx.app.chochCache = { BTC: { detected: true, direction: 'bull', breakPrice: 100.5, swingPrice: 100, ts: Date.now() } };
    Object.assign(ctx.app.ASSETS[0], makeAsset({ price: 100.10 }));
    ctx.app.ASSETS.length = 1;

    const cached = ctx.app.getCachedAssetState(ctx.app.ASSETS[0], LDN);
    assert.equal(cached.signal, ctx.app.getSignal(ctx.app.ASSETS[0], LDN));
    assert.equal(cached.confidence, ctx.app.getConfidencePct(ctx.app.ASSETS[0], LDN));
    assert.equal(cached.mtf.score, ctx.app.getMTFAligned(ctx.app.ASSETS[0]).score);
  });
});

describe('getTodaysJournalEntries — today-filter memoization', () => {
  const TODAY = '2024-06-15';

  test('returns the SAME array reference on repeat calls (cache hit)', () => {
    const ctx = loadApp();
    const j = [
      { date: TODAY, outcome: 'win', bias: 'BULLISH', entry: 100, sl: 99, tp: 105 },
      { date: '2024-06-14', outcome: 'loss', bias: 'BULLISH', entry: 100, sl: 99, tp: 105 },
    ];
    const a = ctx.app.getTodaysJournalEntries(j, TODAY);
    const b = ctx.app.getTodaysJournalEntries(j, TODAY);
    assert.equal(a, b, 'same input → same array reference');
    assert.equal([...a].length, 1);
  });

  test('invalidates when journal length changes (new entry added)', () => {
    const ctx = loadApp();
    const j = [{ date: TODAY, outcome: 'win', bias: 'BULLISH', entry: 100, sl: 99, tp: 105 }];
    const a = ctx.app.getTodaysJournalEntries(j, TODAY);
    j.push({ date: TODAY, outcome: 'loss', bias: 'BULLISH', entry: 100, sl: 99, tp: 105 });
    const b = ctx.app.getTodaysJournalEntries(j, TODAY);
    assert.notEqual(a, b, 'length change should bust the cache');
    assert.equal([...b].length, 2);
  });

  test('invalidates when todayKey changes (midnight rollover)', () => {
    const ctx = loadApp();
    const j = [{ date: TODAY, outcome: 'win', bias: 'BULLISH', entry: 100, sl: 99, tp: 105 }];
    const a = ctx.app.getTodaysJournalEntries(j, TODAY);
    const b = ctx.app.getTodaysJournalEntries(j, '2024-06-16');
    assert.notEqual(a, b, 'date rollover should bust the cache');
  });

  test('explicit invalidateTodaysJournalCache() forces a fresh computation', () => {
    const ctx = loadApp();
    const j = [{ date: TODAY, outcome: 'win', bias: 'BULLISH', entry: 100, sl: 99, tp: 105 }];
    const a = ctx.app.getTodaysJournalEntries(j, TODAY);
    ctx.app.invalidateTodaysJournalCache();
    const b = ctx.app.getTodaysJournalEntries(j, TODAY);
    assert.notEqual(a, b);
  });
});

describe('Perf measurement — recordTickPerf / getPerfStats', () => {
  test('no samples → null stats (no NaN, no crash)', () => {
    const ctx = loadApp();
    // Fresh load — there are no samples yet.
    assert.equal(ctx.app.getPerfStats(), null);
  });

  test('samples accumulate and stats reflect them', () => {
    const ctx = loadApp();
    ctx.app.recordTickPerf(10);
    ctx.app.recordTickPerf(20);
    ctx.app.recordTickPerf(30);
    const s = ctx.app.getPerfStats();
    assert.equal(s.samples, 3);
    assert.equal(s.avgMs, 20);
    assert.equal(s.maxMs, 30);
  });

  test('ring buffer caps at 60 samples (oldest evicted)', () => {
    const ctx = loadApp();
    for (let i = 0; i < 80; i++) ctx.app.recordTickPerf(i);
    const s = ctx.app.getPerfStats();
    assert.equal(s.samples, 60);
    assert.equal(s.maxMs, 79); // newest kept
  });

  test('p50 and p95 are reasonable on a known distribution', () => {
    const ctx = loadApp();
    // 100 samples 1..100. Buffer caps at 60 so we get 41..100.
    for (let i = 1; i <= 100; i++) ctx.app.recordTickPerf(i);
    const s = ctx.app.getPerfStats();
    // Of [41..100] sorted, p50 ≈ index 30 = 71, p95 ≈ index 57 = 98
    assert.ok(s.p50Ms >= 70 && s.p50Ms <= 72, `p50=${s.p50Ms}`);
    assert.ok(s.p95Ms >= 97 && s.p95Ms <= 99, `p95=${s.p95Ms}`);
  });
});
