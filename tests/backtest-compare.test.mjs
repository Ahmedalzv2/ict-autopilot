import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadApp } from './harness.mjs';

// Kline shape: [openTime, open, high, low, close, volume, closeTime]
function k(t, o, h, l, c) {
  return [t, String(o), String(h), String(l), String(c), '0', t + 60_000];
}

describe('diffBacktests — pure A-vs-B delta math', () => {
  const { app } = loadApp();

  test('matches symbols across results and computes per-asset deltas', () => {
    const A = {
      perAsset: [
        { symbol: 'BTC', total: 5, wins: 3, losses: 2, winRate: 0.6, totalR: 4.5 },
        { symbol: 'ETH', total: 2, wins: 0, losses: 2, winRate: 0,   totalR: -2 },
      ],
      overall: { total: 7, wins: 3, losses: 4, winRate: 3/7, totalR: 2.5 },
    };
    const B = {
      perAsset: [
        { symbol: 'BTC', total: 6, wins: 4, losses: 2, winRate: 4/6, totalR: 6 },
        { symbol: 'ETH', total: 2, wins: 1, losses: 1, winRate: 0.5, totalR: 1 },
      ],
      overall: { total: 8, wins: 5, losses: 3, winRate: 5/8, totalR: 7 },
    };
    const d = app.diffBacktests(A, B);
    const rows = [...d.perAsset];
    const btc = rows.find(r => r.symbol === 'BTC');
    assert.equal(btc.delta.trades, 1);
    assert.ok(Math.abs(btc.delta.totalR - 1.5) < 1e-9);
    assert.ok(btc.delta.winRate > 0);
    assert.ok(Math.abs(d.overall.delta.totalR - 4.5) < 1e-9);
  });

  test('symbol present only in A → B side reports zeros, deltas reflect that', () => {
    const A = { perAsset: [{ symbol: 'BTC', total: 3, wins: 2, losses: 1, winRate: 2/3, totalR: 3 }],
                overall: { total: 3, wins: 2, losses: 1, winRate: 2/3, totalR: 3 } };
    const B = { perAsset: [], overall: { total: 0, wins: 0, losses: 0, winRate: 0, totalR: 0 } };
    const d = app.diffBacktests(A, B);
    const btc = [...d.perAsset].find(r => r.symbol === 'BTC');
    assert.equal(btc.b.total, 0);
    assert.equal(btc.delta.totalR, -3, 'B is worse by 3R');
  });

  test('symbol present only in B (e.g. new asset) is included', () => {
    const A = { perAsset: [], overall: { total: 0, winRate: 0, totalR: 0 } };
    const B = { perAsset: [{ symbol: 'SOL', total: 2, wins: 2, losses: 0, winRate: 1, totalR: 4 }],
                overall: { total: 2, wins: 2, losses: 0, winRate: 1, totalR: 4 } };
    const d = app.diffBacktests(A, B);
    assert.ok([...d.perAsset].some(r => r.symbol === 'SOL'));
  });

  test('errored row in A propagates as zero values, no crash', () => {
    const A = { perAsset: [{ symbol: 'BTC', error: 'binance unreachable' }],
                overall: { total: 0, winRate: 0, totalR: 0 } };
    const B = { perAsset: [{ symbol: 'BTC', total: 4, wins: 3, losses: 1, winRate: 0.75, totalR: 5 }],
                overall: { total: 4, wins: 3, losses: 1, winRate: 0.75, totalR: 5 } };
    const d = app.diffBacktests(A, B);
    const btc = [...d.perAsset].find(r => r.symbol === 'BTC');
    assert.equal(btc.a.error, 'binance unreachable');
    assert.equal(btc.delta.totalR, 5);
  });

  test('identical inputs → all deltas are zero', () => {
    const A = { perAsset: [{ symbol: 'BTC', total: 3, wins: 2, losses: 1, winRate: 2/3, totalR: 3 }],
                overall: { total: 3, wins: 2, losses: 1, winRate: 2/3, totalR: 3 } };
    const d = app.diffBacktests(A, A);
    const btc = [...d.perAsset].find(r => r.symbol === 'BTC');
    assert.equal(btc.delta.trades, 0);
    assert.equal(btc.delta.totalR, 0);
    assert.equal(btc.delta.winRate, 0);
    assert.equal(d.overall.delta.totalR, 0);
  });

  test('per-asset rows are sorted alphabetically (stable output)', () => {
    const A = { perAsset: [
      { symbol: 'SOL', total: 1, wins: 1, losses: 0, winRate: 1, totalR: 2 },
      { symbol: 'BTC', total: 1, wins: 1, losses: 0, winRate: 1, totalR: 2 },
      { symbol: 'ETH', total: 1, wins: 1, losses: 0, winRate: 1, totalR: 2 },
    ], overall: { total: 3, winRate: 1, totalR: 6 } };
    const d = app.diffBacktests(A, A);
    const symbols = [...d.perAsset].map(r => r.symbol);
    assert.deepEqual(symbols, ['BTC', 'ETH', 'SOL']);
  });

  test('missing overall on either side does not crash (returns null overall)', () => {
    const d = app.diffBacktests({ perAsset: [] }, { perAsset: [] });
    // Should not throw; overall.a and overall.b can be null but delta is computable.
    assert.ok(d.overall);
    assert.equal(d.overall.delta.totalR, 0);
    assert.equal(d.overall.delta.trades, 0);
  });
});

describe('runBacktestComparison — async A-vs-B', () => {
  test('runs both configs in parallel and returns labeled results + diff', async () => {
    const klineByInterval = {
      '1m': [k(Date.now() - 60_000, 100, 100.5, 99.5, 100)],
      '1h': [k(Date.now() - 3600_000, 99, 101, 99, 100)],
      '4h': [k(Date.now() - 4*3600_000, 99, 101, 99, 100)],
      '1d': [k(Date.now() - 86_400_000, 99, 101, 99, 100)],
    };
    const ctx = loadApp({
      fetch: async (url) => {
        const interval = (String(url).match(/interval=(\w+)/) || [])[1];
        return { ok: true, json: async () => klineByInterval[interval] || [] };
      },
    });
    const out = await ctx.app.runBacktestComparison({
      hours: 1,
      configA: { label: 'cheap', slippagePct: 0,      feePct: 0      },
      configB: { label: 'expensive', slippagePct: 0.001, feePct: 0.001 },
    });
    assert.equal(out.labelA, 'cheap');
    assert.equal(out.labelB, 'expensive');
    assert.ok(out.resultA);
    assert.ok(out.resultB);
    assert.ok(out.diff);
    assert.ok(Array.isArray([...out.diff.perAsset]));
  });

  test('default labels when not provided', async () => {
    const ctx = loadApp({
      fetch: async () => ({ ok: true, json: async () => [k(Date.now() - 60_000, 100, 101, 99, 100)] }),
    });
    const out = await ctx.app.runBacktestComparison({ hours: 1 });
    assert.equal(out.labelA, 'A');
    assert.equal(out.labelB, 'B');
  });
});
