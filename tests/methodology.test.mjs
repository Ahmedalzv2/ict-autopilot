import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadApp, gstDate } from './harness.mjs';

const LDN = gstDate(9, 0);
const OFF = gstDate(11, 30);

function makeLong(o = {}) {
  return {
    symbol: 'BTC', bias: 'BULLISH',
    entry: 100, sl: 99, tp: 105, tp1: 105, grade: 'a',
    price: 100, change24h: 0,
    checks: [1, 1, 1, 1, 1, 1, 1, 1, 1, 1], reason: '',
    ...o,
  };
}

function makeShort(o = {}) {
  return {
    symbol: 'SOL', bias: 'BEARISH',
    entry: 86, sl: 87, tp: 80, tp1: 80, grade: 'a-plus',
    price: 86, change24h: 0,
    checks: [1, 1, 1, 1, 1, 1, 1, 1, 1, 1], reason: '',
    ...o,
  };
}

describe('Invalidation: structured kill switch (your ICT rule)', () => {
  test('LONG setup, no invalidationPrice set → never invalidated', () => {
    const { app } = loadApp();
    const a = makeLong({ price: 1 }); // crashed price; no invalidation field
    assert.equal(app.isInvalidated(a), false);
  });

  test('LONG setup, price ≤ invalidationPrice → invalidated', () => {
    const { app } = loadApp();
    const a = makeLong({ price: 94, invalidationPrice: 95 });
    assert.equal(app.isInvalidated(a), true);
  });

  test('LONG setup, price still above invalidationPrice → valid', () => {
    const { app } = loadApp();
    const a = makeLong({ price: 96, invalidationPrice: 95 });
    assert.equal(app.isInvalidated(a), false);
  });

  test('SHORT setup, price ≥ invalidationPrice → invalidated', () => {
    const { app } = loadApp();
    const a = makeShort({ price: 91, invalidationPrice: 90 });
    assert.equal(app.isInvalidated(a), true);
  });

  test('SHORT setup, price still below invalidationPrice → valid', () => {
    const { app } = loadApp();
    const a = makeShort({ price: 89, invalidationPrice: 90 });
    assert.equal(app.isInvalidated(a), false);
  });

  test('getSignal returns "invalid" for invalidated assets — no other state matters', () => {
    const { app } = loadApp();
    app.mtfCache = { BTC: { h1: 'bull', h4: 'bull', d1: 'bull' } };
    // Even with perfect score and price AT entry, an invalidated setup
    // should return 'invalid' (overrides ENTER NOW).
    const a = makeLong({ price: 94, invalidationPrice: 95 });
    assert.equal(app.getSignal(a, LDN), 'invalid');
  });

  test('analyzeAsset shows the kill-switch text on invalidation', () => {
    const { app } = loadApp();
    const a = makeLong({ price: 94, invalidationPrice: 95 });
    const text = app.analyzeAsset(a, LDN);
    assert.match(text, /INVALIDATED/);
    assert.match(text, /setup is dead/i);
  });

  test('zero / non-finite invalidationPrice ignored (back-compat)', () => {
    const { app } = loadApp();
    assert.equal(app.isInvalidated(makeLong({ price: 1, invalidationPrice: 0 })), false);
    assert.equal(app.isInvalidated(makeLong({ price: 1, invalidationPrice: NaN })), false);
    assert.equal(app.isInvalidated(makeLong({ price: 1, invalidationPrice: null })), false);
  });
});

describe('Alert cooldown: stops oscillation spam at signal boundaries', () => {
  function setup() {
    const ctx = loadApp({ fetch: async () => ({ json: async () => [] }) });
    ctx.app.mtfCache = { BTC: { h1: 'bull', h4: 'bull', d1: 'bull' } };
    Object.assign(ctx.app.ASSETS[0], makeLong({ price: 100.4 })); // watch zone
    ctx.app.ASSETS.length = 1;
    ctx.app.firstSyncDone = true;
    ctx.app.alertLog = [];
    ctx.app.journal = [];
    ctx.app.prevSignalMap = { BTC: 'wait' };
    ctx.app.lastAlertMs = {};
    ctx.app.consecutiveSyncFails = 0;
    return ctx;
  }

  test('WATCH→WAIT→WATCH within cooldown does NOT re-alert', () => {
    const ctx = setup();
    ctx.app.checkArmedAlerts(LDN); // fires watch
    assert.equal([...ctx.app.alertLog].length, 1);

    // Simulate price moving back out then in (the spam case)
    ctx.app.ASSETS[0].price = 100.8; // wait
    ctx.app.checkArmedAlerts(LDN);   // no alert (de-escalation)
    ctx.app.ASSETS[0].price = 100.4; // back to watch
    ctx.app.checkArmedAlerts(LDN);   // SHOULD be suppressed by cooldown
    assert.equal([...ctx.app.alertLog].length, 1, 'no spam — cooldown holds');
  });

  test('WATCH cooldown expires → can re-alert', () => {
    const ctx = setup();
    ctx.app.checkArmedAlerts(LDN); // fires
    assert.equal([...ctx.app.alertLog].length, 1);

    // Force cooldown expiry by backdating the lastAlertMs entry
    ctx.app.lastAlertMs = { BTC: { signal: 'watch', ts: Date.now() - 11 * 60_000 } };
    ctx.app.prevSignalMap = { BTC: 'wait' };
    ctx.app.checkArmedAlerts(LDN);
    assert.equal([...ctx.app.alertLog].length, 2, 'fires again after cooldown');
  });

  test('ENTER has no cooldown — fires every time it escalates', () => {
    const ctx = setup();
    Object.assign(ctx.app.ASSETS[0], makeLong({ price: 100.04 })); // ENTER
    ctx.app.lastAlertMs = { BTC: { signal: 'enter', ts: Date.now() - 1000 } }; // 1s ago
    ctx.app.prevSignalMap = { BTC: 'wait' };
    ctx.app.checkArmedAlerts(LDN);
    assert.equal([...ctx.app.alertLog].length, 1, 'ENTER ignores cooldown');
  });

  test('ARMED cooldown is 3 minutes, not 10', () => {
    const ctx = setup();
    Object.assign(ctx.app.ASSETS[0], makeLong({ price: 100.10 })); // armed
    ctx.app.checkArmedAlerts(LDN); // fires armed
    assert.equal([...ctx.app.alertLog].length, 1);

    // 2 minutes ago — within 3min cooldown → suppressed
    ctx.app.lastAlertMs = { BTC: { signal: 'armed', ts: Date.now() - 2 * 60_000 } };
    ctx.app.prevSignalMap = { BTC: 'wait' };
    ctx.app.checkArmedAlerts(LDN);
    assert.equal([...ctx.app.alertLog].length, 1, '2m later still in cooldown');

    // 4 minutes ago — past 3min cooldown → fires
    ctx.app.lastAlertMs = { BTC: { signal: 'armed', ts: Date.now() - 4 * 60_000 } };
    ctx.app.prevSignalMap = { BTC: 'wait' };
    ctx.app.checkArmedAlerts(LDN);
    assert.equal([...ctx.app.alertLog].length, 2, 'fires after 3m');
  });
});

describe('Funding rate context (ICT contrarian read)', () => {
  test('extreme positive funding → bearish bias message', () => {
    const { app } = loadApp();
    app.fundingRateMap = { BTC: 0.08 };
    const ctx = app.getFundingContext('BTC');
    assert.equal(ctx.bias, 'bearish');
    assert.match(ctx.message, /longs crowded/);
    assert.match(ctx.message, /sweep DOWN/);
  });

  test('extreme negative funding → bullish bias message', () => {
    const { app } = loadApp();
    app.fundingRateMap = { BTC: -0.05 };
    const ctx = app.getFundingContext('BTC');
    assert.equal(ctx.bias, 'bullish');
    assert.match(ctx.message, /shorts crowded/);
    assert.match(ctx.message, /sweep UP/);
  });

  test('balanced funding → neutral bias', () => {
    const { app } = loadApp();
    app.fundingRateMap = { BTC: 0.01 };
    const ctx = app.getFundingContext('BTC');
    assert.equal(ctx.bias, 'neutral');
  });

  test('no funding data for symbol → null context', () => {
    const { app } = loadApp();
    app.fundingRateMap = {};
    assert.equal(app.getFundingContext('BTC'), null);
  });

  test('analyzeAsset surfaces funding when bias is non-neutral', () => {
    const { app } = loadApp();
    app.mtfCache = { BTC: { h1: 'bull', h4: 'bull', d1: 'bull' } };
    app.fundingRateMap = { BTC: -0.05 }; // bullish (shorts crowded)
    const a = makeLong({ price: 100.4 });
    const text = app.analyzeAsset(a, LDN);
    assert.match(text, /📊/);
    assert.match(text, /shorts crowded/);
    assert.match(text, /Aligns with your long setup/);
  });

  test('analyzeAsset flags conflict when funding bias opposes setup', () => {
    const { app } = loadApp();
    app.mtfCache = { BTC: { h1: 'bull', h4: 'bull', d1: 'bull' } };
    app.fundingRateMap = { BTC: 0.08 }; // bearish
    const a = makeLong({ price: 100.4 });
    const text = app.analyzeAsset(a, LDN);
    assert.match(text, /Conflicts with your bullish setup/);
  });

  test('analyzeAsset omits the funding line when neutral', () => {
    const { app } = loadApp();
    app.mtfCache = { BTC: { h1: 'bull', h4: 'bull', d1: 'bull' } };
    app.fundingRateMap = { BTC: 0.01 }; // neutral
    const a = makeLong({ price: 100.4 });
    const text = app.analyzeAsset(a, LDN);
    assert.doesNotMatch(text, /📊/);
  });
});
