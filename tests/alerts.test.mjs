import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { loadApp, gstDate } from './harness.mjs';

/**
 * checkArmedAlerts uses prevSignalMap as a per-symbol memory, and only fires
 * an alert when the new signal is *strictly higher* than the previous one in
 * the ladder: wait < watch < armed < enter.
 */

const LDN = gstDate(9, 0);

function makeAsset(o = {}) {
  return {
    symbol: 'BTC',
    bias: 'BULLISH',
    entry: 100, sl: 99, tp: 105, tp1: 105,
    grade: 'a',
    price: 100,
    change24h: 0,
    checks: [1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
    reason: '',
    ...o,
  };
}

function setup({ price, prev }) {
  const ctx = loadApp({
    fetch: async () => ({ json: async () => [] }), // logCall paths
  });
  ctx.app.mtfCache = { BTC: { h1: 'bull', h4: 'bull', d1: 'bull', ts: Date.now() } };
  ctx.app.alertLog = [];
  ctx.app.journal = [];
  ctx.app.firstSyncDone = true; // bypass first-sync suppression for tests that exercise transitions
  // Replace the only asset with our test fixture
  const assets = [...ctx.app.ASSETS];
  assets.forEach((a) => { /* no-op, just ensures access */ });
  // We can't reassign ASSETS (it's a const), but we can mutate the first entry.
  Object.assign(ctx.app.ASSETS[0], makeAsset({ price }));
  ctx.app.ASSETS.length = 1; // shrink to a single asset for isolation
  if (prev !== undefined) {
    // prevSignalMap isn't in the export bag, but we can reach it via a
    // round-trip through a real escalation. Easier: drive a precursor signal.
    // For these tests we use the sandbox's own checkArmedAlerts twice.
  }
  return ctx;
}

describe('checkArmedAlerts: edge-triggered escalation', () => {
  test('first sync after page load PRIMES prevSignalMap without firing (no spam)', async () => {
    // After a page reload, every asset starts at default 'wait'. Without
    // suppression, any asset already at watch/armed would alert as if it had
    // just escalated. firstSyncDone gates this.
    const ctx = setup({ price: 100.04 }); // would otherwise be ENTER
    ctx.app.firstSyncDone = false; // explicit: simulate a fresh load
    ctx.app.alertLog = [];
    ctx.app.journal = [];
    await ctx.app.checkArmedAlerts(LDN);
    assert.equal([...ctx.app.alertLog].length, 0, 'no alert on first scan');
    assert.equal([...ctx.app.journal].length, 0, 'no journal entry on first scan');
    assert.equal(ctx.app.firstSyncDone, true, 'flag flips to true after priming');
    assert.equal(ctx.app.prevSignalMap.BTC, 'enter', 'prevSignalMap is primed');
  });

  test('after first sync, repeating same signal does not fire', async () => {
    const ctx = setup({ price: 100.04 });
    ctx.app.firstSyncDone = false;
    await ctx.app.checkArmedAlerts(LDN); // primes
    ctx.app.alertLog = [];
    await ctx.app.checkArmedAlerts(LDN); // would fire on enter, but we already at enter
    assert.equal([...ctx.app.alertLog].length, 0, 'no spam on stable signal');
  });

  test('repeat invocation at same signal does NOT fire again', async () => {
    const ctx = setup({ price: 100.04 });
    ctx.app.alertLog = [];
    await ctx.app.checkArmedAlerts(LDN); // primes & fires
    const afterFirst = [...ctx.app.alertLog].length;
    await ctx.app.checkArmedAlerts(LDN); // should be a no-op
    assert.equal([...ctx.app.alertLog].length, afterFirst, 'no new alert when signal unchanged');
  });

  test('de-escalation (armed → watch) does NOT fire', async () => {
    const ctx = setup({ price: 100.10 }); // armed (in KZ, score 10, MTF aligned)
    ctx.app.alertLog = [];
    await ctx.app.checkArmedAlerts(LDN); // primes at 'armed'
    const after = [...ctx.app.alertLog].length;

    // Move price further from entry → drops to watch
    ctx.app.ASSETS[0].price = 100.40;
    await ctx.app.checkArmedAlerts(LDN);
    assert.equal([...ctx.app.alertLog].length, after, 'watch after armed must not re-alert');
  });

  test('escalation watch → armed fires', async () => {
    const ctx = setup({ price: 100.40 }); // watch
    await ctx.app.checkArmedAlerts(LDN);
    const before = [...ctx.app.alertLog].length;

    ctx.app.ASSETS[0].price = 100.10; // → armed
    await ctx.app.checkArmedAlerts(LDN);
    assert.ok([...ctx.app.alertLog].length > before, 'armed after watch should fire');
  });

  test('escalation armed → enter fires', async () => {
    const ctx = setup({ price: 100.10 }); // armed
    await ctx.app.checkArmedAlerts(LDN);
    const before = [...ctx.app.alertLog].length;

    ctx.app.ASSETS[0].price = 100.03; // → enter
    await ctx.app.checkArmedAlerts(LDN);
    assert.ok([...ctx.app.alertLog].length > before, 'enter after armed should fire');
    assert.equal([...ctx.app.alertLog][0].signal, 'enter', 'newest alert is the enter event');
  });

  test('alertLog cap: never exceeds 50 entries', async () => {
    const ctx = setup({ price: 100.04 });
    ctx.app.alertLog = Array.from({ length: 60 }, (_, i) => ({ time: '00:00', symbol: 'X', signal: 'wait', price: 0, entry: 0, grade: 'a', analysis: '' }));
    // Force one more push
    await ctx.app.checkArmedAlerts(LDN);
    assert.ok([...ctx.app.alertLog].length <= 50, `alertLog length=${[...ctx.app.alertLog].length}`);
  });

  test('every alert escalation logs a journal entry', async () => {
    const ctx = setup({ price: 100.04 });
    ctx.app.journal = [];
    await ctx.app.checkArmedAlerts(LDN);
    assert.ok([...ctx.app.journal].length >= 1, 'journal should record the called signal');
  });
});
