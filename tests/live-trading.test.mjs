import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadApp } from './harness.mjs';

describe('live-trading status machine', () => {
  test('no keys saved → state "not-connected" 🔌', () => {
    const { app } = loadApp();
    app.loadLiveTradingState();
    const s = app.liveTradingStatus();
    assert.equal(s.state, 'not-connected');
    assert.equal(s.icon, '🔌');
  });

  test('keys saved, master OFF → state "connected-off" 🟡', () => {
    const { app } = loadApp();
    app.saveMexcKeys('key', 'secret');
    app.loadLiveTradingState();
    assert.equal(app.liveTradingStatus().state, 'connected-off');
    assert.equal(app.liveTradingStatus().icon, '🟡');
  });

  test('keys + master ON + dry-run ON → state "on-dryrun" 🟢', () => {
    const { app } = loadApp();
    app.saveMexcKeys('key', 'secret');
    app.setLiveTradingEnabled(true);
    app.setLiveTradingDryRun(true);
    assert.equal(app.liveTradingStatus().state, 'on-dryrun');
    assert.equal(app.liveTradingStatus().icon, '🟢');
  });

  test('keys + master ON + dry-run OFF → state "on-live" 🔴', () => {
    const { app } = loadApp();
    app.saveMexcKeys('key', 'secret');
    app.setLiveTradingEnabled(true);
    app.setLiveTradingDryRun(false);
    assert.equal(app.liveTradingStatus().state, 'on-live');
    assert.equal(app.liveTradingStatus().icon, '🔴');
  });

  test('clearMexcKeys forces master switch OFF (no live trading without keys)', () => {
    const { app } = loadApp();
    app.saveMexcKeys('key', 'secret');
    app.setLiveTradingEnabled(true);
    app.setLiveTradingDryRun(false);
    app.clearMexcKeys();
    assert.equal(app.getMexcApiKey(), '');
    assert.equal(app.getMexcApiSecret(), '');
    assert.equal(app.liveTradingStatus().state, 'not-connected');
  });

  test('settings persist across app reloads', () => {
    const ctx1 = loadApp();
    ctx1.app.saveMexcKeys('persist-key', 'persist-secret');
    ctx1.app.setLiveTradingEnabled(true);
    ctx1.app.setLiveTradingDryRun(false);
    // Re-instantiate the app with the same localStorage shape
    const ctx2 = loadApp({
      storage: {
        ict_mexc_api_key: 'persist-key',
        ict_mexc_api_secret: 'persist-secret',
        ict_live_trading_v2: JSON.stringify({ enabled: true, dryRun: false }),
      },
    });
    ctx2.app.loadLiveTradingState();
    assert.equal(ctx2.app.getMexcApiKey(), 'persist-key');
    assert.equal(ctx2.app.liveTradingStatus().state, 'on-live');
  });

  test('dry-run defaults to ON when no setting is stored (safe default)', () => {
    const { app } = loadApp({
      storage: {
        ict_mexc_api_key: 'k',
        ict_mexc_api_secret: 's',
        // No ict_live_trading_v2 → should default to enabled:false, dryRun:true
      },
    });
    app.loadLiveTradingState();
    const status = app.liveTradingStatus();
    // master defaults off, but if master were on, dry-run defaults to true
    app.setLiveTradingEnabled(true);
    assert.equal(app.liveTradingStatus().state, 'on-dryrun');
  });
});

describe('placeMexcFuturesOrderStub', () => {
  function asset() {
    return { symbol: 'SILVER', bias: 'BEARISH', price: 75.66, grade: 'b' };
  }

  test('master OFF → does not send, returns master-off', () => {
    const { app } = loadApp();
    app.saveMexcKeys('k', 's');
    // master defaults off
    const r = app.placeMexcFuturesOrderStub(asset(), 'SHORT', 75.65, 75.5, 75.9, 1, 3);
    assert.equal(r.sent, false);
    assert.equal(r.reason, 'master-off');
  });

  test('master ON + dry-run ON → appends a [DRY-RUN] journal entry, no HTTP', () => {
    const ctx = loadApp({ storage: { journal: '[]' } });
    ctx.app.saveMexcKeys('k', 's');
    ctx.app.setLiveTradingEnabled(true);
    ctx.app.setLiveTradingDryRun(true);
    const beforeLen = (ctx.app.journal || []).length;
    const r = ctx.app.placeMexcFuturesOrderStub(asset(), 'SHORT', 75.65, 75.5, 75.9, 1, 3);
    assert.equal(r.sent, false);
    assert.equal(r.dryRun, true);
    const after = ctx.app.journal;
    assert.equal(after.length, beforeLen + 1, 'journal should grow by 1');
    assert.equal(after[0].dryRun, true, 'entry should be flagged dryRun');
    assert.match(after[0].analysis, /\[DRY-RUN\]/);
    assert.match(after[0].analysis, /SHORT SILVER/);
  });

  test('master ON + dry-run OFF → live path is intentionally not wired (returns clear marker)', () => {
    const ctx = loadApp();
    ctx.app.saveMexcKeys('k', 's');
    ctx.app.setLiveTradingEnabled(true);
    ctx.app.setLiveTradingDryRun(false);
    const r = ctx.app.placeMexcFuturesOrderStub(asset(), 'SHORT', 75.65, 75.5, 75.9, 1, 3);
    assert.equal(r.sent, false);
    assert.equal(r.reason, 'live-not-wired');
    assert.match(r.message, /not wired/i);
  });
});
