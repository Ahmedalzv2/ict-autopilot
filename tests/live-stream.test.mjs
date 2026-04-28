import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadApp } from './harness.mjs';

describe('parseTickerMessage (Binance miniTicker → app shape)', () => {
  const { app } = loadApp();

  test('combined-stream envelope (data wrapper) → parsed update', () => {
    const env = JSON.stringify({
      stream: 'btcusdt@miniTicker',
      data: { e: '24hrMiniTicker', E: 1, s: 'BTCUSDT', c: '77123.45', o: '76000.00' },
    });
    const u = app.parseTickerMessage(env);
    assert.deepEqual([u.symbol, u.price], ['BTC', 77123.45]);
    // change24h = (77123.45 - 76000) / 76000 * 100 ≈ 1.4782
    assert.ok(Math.abs(u.change24h - 1.4782) < 0.001);
  });

  test('plain (non-wrapped) ticker payload also works', () => {
    const env = JSON.stringify({ s: 'ETHUSDT', c: '3500', o: '3450' });
    const u = app.parseTickerMessage(env);
    assert.equal(u.symbol, 'ETH');
    assert.equal(u.price, 3500);
  });

  test('object form (already parsed) is accepted', () => {
    const u = app.parseTickerMessage({ s: 'SOLUSDT', c: '180.5', o: '175' });
    assert.equal(u.symbol, 'SOL');
    assert.equal(u.price, 180.5);
  });

  test('malformed JSON → null (does not throw)', () => {
    assert.equal(app.parseTickerMessage('{not-json'), null);
  });

  test('missing symbol field → null', () => {
    assert.equal(app.parseTickerMessage('{"c":"100"}'), null);
  });

  test('non-finite price → null', () => {
    assert.equal(app.parseTickerMessage('{"s":"BTCUSDT","c":"NaN","o":"100"}'), null);
  });

  test('zero open → change24h is 0 (no division by zero)', () => {
    const u = app.parseTickerMessage('{"s":"BTCUSDT","c":"100","o":"0"}');
    assert.equal(u.change24h, 0);
  });

  test('USDT suffix is stripped from the stream symbol', () => {
    const u = app.parseTickerMessage('{"s":"XRPUSDT","c":"1","o":"1"}');
    assert.equal(u.symbol, 'XRP');
  });
});

describe('recordSignalState (sparkline state buffer)', () => {
  const { app } = loadApp();

  test('first observation creates an entry', () => {
    const out = app.recordSignalState({}, 'BTC', 'wait', 1000);
    assert.equal(out.BTC.length, 1);
    assert.equal(out.BTC[0].signal, 'wait');
    assert.equal(out.BTC[0].ts, 1000);
  });

  test('same signal as last → no new entry (transitions only)', () => {
    let h = app.recordSignalState({}, 'BTC', 'wait', 1000);
    h = app.recordSignalState(h, 'BTC', 'wait', 2000);
    h = app.recordSignalState(h, 'BTC', 'wait', 3000);
    assert.equal(h.BTC.length, 1);
  });

  test('different signal → new entry pushed', () => {
    let h = app.recordSignalState({}, 'BTC', 'wait', 1000);
    h = app.recordSignalState(h, 'BTC', 'watch', 2000);
    h = app.recordSignalState(h, 'BTC', 'armed', 3000);
    assert.deepEqual([...h.BTC].map(x => x.signal), ['wait', 'watch', 'armed']);
  });

  test('entries older than 24h are pruned', () => {
    const day = 24 * 60 * 60_000;
    let h = app.recordSignalState({}, 'BTC', 'wait', 0);
    h = app.recordSignalState(h, 'BTC', 'watch', day + 1);
    // The 'wait' entry is older than 24h relative to the new now → pruned.
    assert.equal(h.BTC.length, 1);
    assert.equal(h.BTC[0].signal, 'watch');
  });

  test('per-symbol isolation', () => {
    let h = app.recordSignalState({}, 'BTC', 'wait', 1000);
    h = app.recordSignalState(h, 'ETH', 'armed', 1000);
    h = app.recordSignalState(h, 'BTC', 'watch', 2000);
    assert.equal(h.BTC.length, 2);
    assert.equal(h.ETH.length, 1);
  });

  test('input history is not mutated', () => {
    const before = { BTC: [{ ts: 1000, signal: 'wait' }] };
    const snapshot = JSON.stringify(before);
    app.recordSignalState(before, 'BTC', 'armed', 2000);
    assert.equal(JSON.stringify(before), snapshot);
  });
});

describe('renderSparkline (signal history → SVG)', () => {
  test('empty history → placeholder div, not an SVG', () => {
    const { app } = loadApp();
    app.signalHistory = {};
    const out = app.renderSparkline('BTC', Date.now());
    assert.doesNotMatch(out, /<svg/);
  });

  test('single segment renders one rect', () => {
    const { app } = loadApp();
    const now = Date.now();
    app.signalHistory = { BTC: [{ ts: now - 1000, signal: 'armed' }] };
    const out = app.renderSparkline('BTC', now);
    assert.match(out, /<svg/);
    assert.match(out, /<rect/);
    // Color for 'armed' is the bull green
    assert.match(out, /#5cb88a/);
  });

  test('multi-segment renders multiple rects in chronological order', () => {
    const { app } = loadApp();
    const now = Date.now();
    app.signalHistory = {
      BTC: [
        { ts: now - 6 * 3600_000, signal: 'wait' },
        { ts: now - 3 * 3600_000, signal: 'watch' },
        { ts: now - 1 * 3600_000, signal: 'armed' },
      ],
    };
    const out = app.renderSparkline('BTC', now);
    const rectCount = (out.match(/<rect/g) || []).length;
    assert.equal(rectCount, 3);
  });

  test('older-than-24h entries are filtered out at render time', () => {
    const { app } = loadApp();
    const now = Date.now();
    const day = 24 * 60 * 60_000;
    app.signalHistory = {
      BTC: [
        { ts: now - day - 5000, signal: 'wait' },     // pruned
        { ts: now - day + 5000, signal: 'watch' },
        { ts: now - 1000,        signal: 'armed' },
      ],
    };
    const out = app.renderSparkline('BTC', now);
    const rectCount = (out.match(/<rect/g) || []).length;
    assert.equal(rectCount, 2);
  });
});
