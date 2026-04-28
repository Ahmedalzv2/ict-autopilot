import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadApp, gstDate } from './harness.mjs';

const LDN = gstDate(9, 0);

describe('serializeGuardrailState / deserializeGuardrailState (pure)', () => {
  const { app } = loadApp();

  test('round-trip preserves all four maps', () => {
    const state = {
      lastAlertMs:        { BTC: { signal: 'watch', ts: 1000 } },
      prevSignalMap:      { BTC: 'armed', ETH: 'wait' },
      lastLossMs:         { BTC: 9000 },
      sessionTradeCounts: { '2024-06-15|London Kill Zone': 2 },
    };
    const raw = app.serializeGuardrailState(state, 5000);
    const back = app.deserializeGuardrailState(raw, 5000);
    assert.deepEqual({ ...back.lastAlertMs }, state.lastAlertMs);
    assert.deepEqual({ ...back.prevSignalMap }, state.prevSignalMap);
    assert.deepEqual({ ...back.lastLossMs }, state.lastLossMs);
    assert.deepEqual({ ...back.sessionTradeCounts }, state.sessionTradeCounts);
  });

  test('null / empty / malformed input → null', () => {
    assert.equal(app.deserializeGuardrailState(null), null);
    assert.equal(app.deserializeGuardrailState(''), null);
    assert.equal(app.deserializeGuardrailState('{not-json'), null);
  });

  test('wrong version number → null (forces re-prime, never silent corruption)', () => {
    const raw = JSON.stringify({ version: 999, ts: Date.now(), lastAlertMs: {}, prevSignalMap: {}, lastLossMs: {}, sessionTradeCounts: {} });
    assert.equal(app.deserializeGuardrailState(raw), null);
  });

  test('missing ts field → null', () => {
    const raw = JSON.stringify({ version: app.GUARDRAIL_STATE_VERSION, lastAlertMs: {}, prevSignalMap: {}, lastLossMs: {}, sessionTradeCounts: {} });
    assert.equal(app.deserializeGuardrailState(raw), null);
  });

  test('older than 24h → null (stale data discarded)', () => {
    const ts = Date.now() - (25 * 60 * 60_000);
    const raw = app.serializeGuardrailState({
      lastAlertMs: {}, prevSignalMap: {}, lastLossMs: {}, sessionTradeCounts: {},
    }, ts);
    assert.equal(app.deserializeGuardrailState(raw, Date.now()), null);
  });

  test('exactly 24h boundary → still valid (just inside window)', () => {
    const now = Date.now();
    const ts = now - (24 * 60 * 60_000) + 100; // just under 24h ago
    const raw = app.serializeGuardrailState({
      lastAlertMs: { BTC: { signal: 'watch', ts: 1 } },
      prevSignalMap: {}, lastLossMs: {}, sessionTradeCounts: {},
    }, ts);
    assert.notEqual(app.deserializeGuardrailState(raw, now), null);
  });

  test('partial blob (missing some maps) → empty defaults instead of crashing', () => {
    const raw = JSON.stringify({
      version: app.GUARDRAIL_STATE_VERSION,
      ts: Date.now(),
      lastAlertMs: { BTC: { signal: 'watch', ts: 1 } },
      // prevSignalMap, lastLossMs, sessionTradeCounts intentionally missing
    });
    const back = app.deserializeGuardrailState(raw);
    assert.ok(back, 'should still parse');
    assert.deepEqual({ ...back.prevSignalMap }, {});
    assert.deepEqual({ ...back.lastLossMs }, {});
    assert.deepEqual({ ...back.sessionTradeCounts }, {});
  });
});

describe('saveGuardrailState / loadGuardrailState (localStorage round-trip)', () => {
  test('save then load restores all four maps into the closure scope', () => {
    const ctx = loadApp();
    ctx.app.lastAlertMs        = { BTC: { signal: 'armed', ts: 1234 } };
    ctx.app.prevSignalMap      = { BTC: 'armed', ETH: 'wait' };
    ctx.app.lastLossMs         = { BTC: 5678 };
    ctx.app.sessionTradeCounts = { '2024-06-15|London Kill Zone': 2 };

    ctx.app.saveGuardrailState();

    // New vm context — same persisted blob
    const stored = ctx.sandbox.localStorage.getItem(ctx.app.GUARDRAIL_STATE_KEY);
    assert.ok(stored, 'should have written to localStorage');

    const ctx2 = loadApp({ storage: { [ctx.app.GUARDRAIL_STATE_KEY]: stored } });
    const ok = ctx2.app.loadGuardrailState();
    assert.equal(ok, true);
    assert.equal(ctx2.app.lastAlertMs.BTC.signal, 'armed');
    assert.equal(ctx2.app.prevSignalMap.BTC, 'armed');
    assert.equal(ctx2.app.lastLossMs.BTC, 5678);
    assert.equal(ctx2.app.sessionTradeCounts['2024-06-15|London Kill Zone'], 2);
  });

  test('load with non-empty prevSignalMap flips firstSyncDone → no re-prime', () => {
    const ctx = loadApp();
    ctx.app.prevSignalMap = { BTC: 'armed' };
    ctx.app.saveGuardrailState();
    const stored = ctx.sandbox.localStorage.getItem(ctx.app.GUARDRAIL_STATE_KEY);

    const ctx2 = loadApp({ storage: { [ctx.app.GUARDRAIL_STATE_KEY]: stored } });
    assert.equal(ctx2.app.firstSyncDone, false, 'starts false on load');
    ctx2.app.loadGuardrailState();
    assert.equal(ctx2.app.firstSyncDone, true, 'flips to true so a refresh does not re-prime');
  });

  test('empty prevSignalMap → firstSyncDone stays false', () => {
    const ctx = loadApp();
    ctx.app.prevSignalMap = {};
    ctx.app.saveGuardrailState();
    const stored = ctx.sandbox.localStorage.getItem(ctx.app.GUARDRAIL_STATE_KEY);

    const ctx2 = loadApp({ storage: { [ctx.app.GUARDRAIL_STATE_KEY]: stored } });
    ctx2.app.loadGuardrailState();
    assert.equal(ctx2.app.firstSyncDone, false, 'empty prev → prime path on next scan');
  });

  test('no stored blob → load returns false, state untouched', () => {
    const ctx = loadApp();
    ctx.app.lastAlertMs = { BTC: { signal: 'watch', ts: 9 } };
    const ok = ctx.app.loadGuardrailState();
    assert.equal(ok, false);
    assert.equal(ctx.app.lastAlertMs.BTC.signal, 'watch', 'in-memory state preserved');
  });

  test('corrupt blob → load returns false, no crash', () => {
    const ctx = loadApp({ storage: { ict_guardrail_state: '{not-json' } });
    assert.equal(ctx.app.loadGuardrailState(), false);
  });
});

describe('Refresh-resilience integration (the actual safety property)', () => {
  function makeAsset(o = {}) {
    return {
      symbol: 'BTC', bias: 'BULLISH',
      entry: 100, sl: 99, tp: 105, tp1: 105, grade: 'a',
      price: 100.10, change24h: 0,
      checks: [1, 1, 1, 1, 1, 1, 1, 1, 1, 1], reason: '',
      ...o,
    };
  }

  test('revenge cooldown survives page refresh', async () => {
    // First "session": fire a loss on BTC, save state.
    const ctx1 = loadApp();
    ctx1.app.lastLossMs = { BTC: Date.now() - 5 * 60_000 }; // 5m ago
    ctx1.app.saveGuardrailState();
    const stored = ctx1.sandbox.localStorage.getItem(ctx1.app.GUARDRAIL_STATE_KEY);

    // "Reload" — fresh vm, same localStorage blob.
    const ctx2 = loadApp({
      storage: { [ctx1.app.GUARDRAIL_STATE_KEY]: stored },
      fetch: async () => ({ json: async () => [] }),
    });
    ctx2.app.loadGuardrailState();
    ctx2.app.mtfCache  = { BTC: { h1: 'bull', h4: 'bull', d1: 'bull', ts: Date.now() } };
    ctx2.app.chochCache = { BTC: { detected: true, direction: 'bull', breakPrice: 100.5, swingPrice: 100, ts: Date.now() } };
    Object.assign(ctx2.app.ASSETS[0], makeAsset({ price: 100.04 })); // would otherwise ENTER
    ctx2.app.ASSETS.length = 1;
    ctx2.app.consecutiveSyncFails = 0;
    ctx2.app.alertLog = [];

    await ctx2.app.checkArmedAlerts(LDN);
    assert.equal([...ctx2.app.alertLog].length, 0,
      'reload + recent loss → still in revenge cooldown, no ENTER fires');
  });

  test('session trade count survives page refresh (4th alert still blocked)', async () => {
    const today = '2024-06-15';
    const ctx1 = loadApp();
    ctx1.app.sessionTradeCounts = { [`${today}|London Kill Zone`]: 3 };
    ctx1.app.saveGuardrailState();
    const stored = ctx1.sandbox.localStorage.getItem(ctx1.app.GUARDRAIL_STATE_KEY);

    const ctx2 = loadApp({
      storage: { [ctx1.app.GUARDRAIL_STATE_KEY]: stored },
      fetch: async () => ({ json: async () => [] }),
    });
    ctx2.app.loadGuardrailState();
    ctx2.app.mtfCache  = { BTC: { h1: 'bull', h4: 'bull', d1: 'bull', ts: Date.now() } };
    ctx2.app.chochCache = { BTC: { detected: true, direction: 'bull', breakPrice: 100.5, swingPrice: 100, ts: Date.now() } };
    Object.assign(ctx2.app.ASSETS[0], makeAsset());
    ctx2.app.ASSETS.length = 1;
    ctx2.app.consecutiveSyncFails = 0;
    ctx2.app.alertLog = [];

    await ctx2.app.checkArmedAlerts(LDN);
    assert.equal([...ctx2.app.alertLog].length, 0,
      'reload + session full → still no new alerts');
  });

  test('persisted prevSignalMap stops the post-refresh re-prime spam', async () => {
    // Symbol was already at ARMED before refresh. Reload + checkArmedAlerts
    // should NOT re-fire ARMED — prevSignalMap was restored, so the same
    // signal is not an "escalation".
    const ctx1 = loadApp();
    ctx1.app.prevSignalMap = { BTC: 'armed' };
    ctx1.app.saveGuardrailState();
    const stored = ctx1.sandbox.localStorage.getItem(ctx1.app.GUARDRAIL_STATE_KEY);

    const ctx2 = loadApp({
      storage: { [ctx1.app.GUARDRAIL_STATE_KEY]: stored },
      fetch: async () => ({ json: async () => [] }),
    });
    ctx2.app.loadGuardrailState();
    ctx2.app.mtfCache  = { BTC: { h1: 'bull', h4: 'bull', d1: 'bull', ts: Date.now() } };
    ctx2.app.chochCache = { BTC: { detected: true, direction: 'bull', breakPrice: 100.5, swingPrice: 100, ts: Date.now() } };
    Object.assign(ctx2.app.ASSETS[0], makeAsset()); // still ARMED
    ctx2.app.ASSETS.length = 1;
    ctx2.app.consecutiveSyncFails = 0;
    ctx2.app.alertLog = [];

    await ctx2.app.checkArmedAlerts(LDN);
    assert.equal([...ctx2.app.alertLog].length, 0,
      'persisted prevSignalMap means refresh does not re-fire the same signal');
  });
});
