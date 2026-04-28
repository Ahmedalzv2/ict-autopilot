import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadApp, gstDate } from './harness.mjs';

const LDN = gstDate(9, 0); // London KZ active

function makeAsset(o = {}) {
  return {
    symbol: 'BTC', bias: 'BULLISH',
    entry: 100, sl: 99, tp: 105, tp1: 105, grade: 'a',
    price: 100, change24h: 0,
    checks: [1, 1, 1, 1, 1, 1, 1, 1, 1, 1], reason: '',
    ...o,
  };
}

describe('nominalR — R-multiple from a resolved journal entry', () => {
  const { app } = loadApp();

  test('LONG win: (tp-entry)/(entry-sl)', () => {
    const r = app.nominalR({ outcome: 'win', bias: 'BULLISH', entry: 100, sl: 99, tp: 105 });
    assert.equal(r, 5);
  });

  test('LONG loss: -1', () => {
    const r = app.nominalR({ outcome: 'loss', bias: 'BULLISH', entry: 100, sl: 99, tp: 105 });
    assert.equal(r, -1);
  });

  test('SHORT win: (entry-tp)/(sl-entry)', () => {
    const r = app.nominalR({ outcome: 'win', bias: 'BEARISH', entry: 86, sl: 87, tp: 80 });
    assert.equal(r, 6);
  });

  test('BE → 0', () => {
    assert.equal(app.nominalR({ outcome: 'be', bias: 'BULLISH', entry: 100, sl: 99, tp: 105 }), 0);
  });

  test('unresolved outcome → 0', () => {
    assert.equal(app.nominalR({ outcome: null, bias: 'BULLISH', entry: 100, sl: 99, tp: 105 }), 0);
  });
});

describe('getDailyR — sums today\'s realized R from journal', () => {
  const { app } = loadApp();
  const today = '2024-06-15';

  test('only counts today\'s entries', () => {
    const j = [
      { date: today, outcome: 'win',  bias: 'BULLISH', entry: 100, sl: 99, tp: 105 },
      { date: '2024-06-14', outcome: 'loss', bias: 'BULLISH', entry: 100, sl: 99, tp: 105 },
    ];
    assert.equal(app.getDailyR(j, today), 5);
  });

  test('only counts resolved trades (skips outcome:null)', () => {
    const j = [
      { date: today, outcome: 'win',  bias: 'BULLISH', entry: 100, sl: 99, tp: 105 },
      { date: today, outcome: null,    bias: 'BULLISH', entry: 100, sl: 99, tp: 105 },
    ];
    assert.equal(app.getDailyR(j, today), 5);
  });

  test('mixed: 2 wins (5R + 3R) + 2 losses (-1R each) → +6R', () => {
    const j = [
      { date: today, outcome: 'win',  bias: 'BULLISH', entry: 100, sl: 99, tp: 105 },
      { date: today, outcome: 'win',  bias: 'BULLISH', entry: 100, sl: 99, tp: 103 },
      { date: today, outcome: 'loss', bias: 'BULLISH', entry: 100, sl: 99, tp: 105 },
      { date: today, outcome: 'loss', bias: 'BULLISH', entry: 100, sl: 99, tp: 105 },
    ];
    assert.equal(app.getDailyR(j, today), 5 + 3 - 1 - 1);
  });

  test('uses entry.rMultiple if present (so backtest-style precise R is honored)', () => {
    const j = [
      { date: today, outcome: 'win', bias: 'BULLISH', entry: 100, sl: 99, tp: 105, rMultiple: 4.82 },
    ];
    assert.equal(app.getDailyR(j, today), 4.82);
  });

  test('empty journal → 0', () => {
    assert.equal(app.getDailyR([], today), 0);
  });
});

describe('getSessionTradeCount / bumpSessionTradeCount', () => {
  const { app } = loadApp();

  test('initial count is 0', () => {
    assert.equal(app.getSessionTradeCount({}, '2024-06-15', 'London Kill Zone'), 0);
  });

  test('bump increments per (date, session) key', () => {
    let c = {};
    c = app.bumpSessionTradeCount(c, '2024-06-15', 'London Kill Zone');
    c = app.bumpSessionTradeCount(c, '2024-06-15', 'London Kill Zone');
    c = app.bumpSessionTradeCount(c, '2024-06-15', 'NY AM Kill Zone');
    assert.equal(app.getSessionTradeCount(c, '2024-06-15', 'London Kill Zone'), 2);
    assert.equal(app.getSessionTradeCount(c, '2024-06-15', 'NY AM Kill Zone'), 1);
  });

  test('different dates do not collide', () => {
    let c = {};
    c = app.bumpSessionTradeCount(c, '2024-06-15', 'London Kill Zone');
    c = app.bumpSessionTradeCount(c, '2024-06-16', 'London Kill Zone');
    assert.equal(app.getSessionTradeCount(c, '2024-06-15', 'London Kill Zone'), 1);
    assert.equal(app.getSessionTradeCount(c, '2024-06-16', 'London Kill Zone'), 1);
  });

  test('null session returns 0 (off-session entries don\'t consume quota)', () => {
    assert.equal(app.getSessionTradeCount({}, '2024-06-15', null), 0);
  });

  test('bump with null session is a no-op', () => {
    const before = { 'k': 5 };
    const after = app.bumpSessionTradeCount(before, '2024-06-15', null);
    assert.deepEqual({ ...after }, { ...before });
  });
});

describe('isInRevengeCooldown', () => {
  const { app } = loadApp();

  test('no recorded loss → false', () => {
    assert.equal(app.isInRevengeCooldown({}, 'BTC', Date.now()), false);
  });

  test('loss 5 min ago → true (within 30m window)', () => {
    const map = { BTC: Date.now() - 5 * 60_000 };
    assert.equal(app.isInRevengeCooldown(map, 'BTC', Date.now()), true);
  });

  test('loss 31 min ago → false (cooldown expired)', () => {
    const map = { BTC: Date.now() - 31 * 60_000 };
    assert.equal(app.isInRevengeCooldown(map, 'BTC', Date.now()), false);
  });

  test('per-symbol isolation — losing BTC does not block ETH', () => {
    const map = { BTC: Date.now() };
    assert.equal(app.isInRevengeCooldown(map, 'ETH', Date.now()), false);
  });
});

describe('checkArmedAlerts — guardrail integration', () => {
  function setup({ price = 100.04, journal = [], lastLossMs = {}, sessionCounts = {} } = {}) {
    const ctx = loadApp({ fetch: async () => ({ json: async () => [] }) });
    ctx.app.mtfCache = { BTC: { h1: 'bull', h4: 'bull', d1: 'bull', ts: Date.now() } };
    Object.assign(ctx.app.ASSETS[0], makeAsset({ price }));
    ctx.app.ASSETS.length = 1;
    ctx.app.firstSyncDone = true;
    ctx.app.consecutiveSyncFails = 0;
    ctx.app.alertLog = [];
    ctx.app.journal = journal;
    ctx.app.lastLossMs = lastLossMs;
    ctx.app.sessionTradeCounts = sessionCounts;
    ctx.app.prevSignalMap = { BTC: 'wait' };
    ctx.app.lastAlertMs = {};
    return ctx;
  }

  test('daily loss limit (-3R) blocks all new alerts', async () => {
    // Must match the date encoded in `LDN = gstDate(9,0)` — tests/harness's
    // gstDate uses a fixed 2024-06-15 so checkArmedAlerts' gstDateKey(gst)
    // produces this same string.
    const today = '2024-06-15';
    const ctx = setup({
      journal: [
        { date: today, outcome: 'loss', bias: 'BULLISH', entry: 100, sl: 99, tp: 105 },
        { date: today, outcome: 'loss', bias: 'BULLISH', entry: 100, sl: 99, tp: 105 },
        { date: today, outcome: 'loss', bias: 'BULLISH', entry: 100, sl: 99, tp: 105 },
      ],
    });
    await ctx.app.checkArmedAlerts(LDN);
    assert.equal([...ctx.app.alertLog].length, 0, '−3R should block new alerts');
  });

  test('daily PnL of -2R does NOT trigger the limit (boundary not hit)', async () => {
    // Must match the date encoded in `LDN = gstDate(9,0)` — tests/harness's
    // gstDate uses a fixed 2024-06-15 so checkArmedAlerts' gstDateKey(gst)
    // produces this same string.
    const today = '2024-06-15';
    const ctx = setup({
      journal: [
        { date: today, outcome: 'loss', bias: 'BULLISH', entry: 100, sl: 99, tp: 105 },
        { date: today, outcome: 'loss', bias: 'BULLISH', entry: 100, sl: 99, tp: 105 },
      ],
    });
    await ctx.app.checkArmedAlerts(LDN);
    assert.ok([...ctx.app.alertLog].length >= 1, '−2R should still allow alerts');
  });

  test('revenge cooldown blocks ENTER on the same symbol after a recent loss', async () => {
    const ctx = setup({
      lastLossMs: { BTC: Date.now() - 5 * 60_000 }, // 5 min ago
    });
    await ctx.app.checkArmedAlerts(LDN);
    assert.equal([...ctx.app.alertLog].length, 0, 'recent loss → no new ENTER');
  });

  test('revenge cooldown expires after 30 min', async () => {
    const ctx = setup({
      lastLossMs: { BTC: Date.now() - 31 * 60_000 },
    });
    await ctx.app.checkArmedAlerts(LDN);
    assert.ok([...ctx.app.alertLog].length >= 1, '31m later — fires normally');
  });

  test('per-session trade limit (3) blocks the 4th alert', async () => {
    // Must match the date encoded in `LDN = gstDate(9,0)` — tests/harness's
    // gstDate uses a fixed 2024-06-15 so checkArmedAlerts' gstDateKey(gst)
    // produces this same string.
    const today = '2024-06-15';
    const ctx = setup({
      sessionCounts: { [`${today}|London Kill Zone`]: 3 },
    });
    await ctx.app.checkArmedAlerts(LDN);
    assert.equal([...ctx.app.alertLog].length, 0, '4th alert in session blocked');
  });

  test('every fired alert bumps the session counter', async () => {
    const ctx = setup({});
    await ctx.app.checkArmedAlerts(LDN);
    // Must match the date encoded in `LDN = gstDate(9,0)` — tests/harness's
    // gstDate uses a fixed 2024-06-15 so checkArmedAlerts' gstDateKey(gst)
    // produces this same string.
    const today = '2024-06-15';
    const counts = { ...ctx.app.sessionTradeCounts };
    assert.equal(counts[`${today}|London Kill Zone`], 1, 'counter should be 1 after one fire');
  });
});
