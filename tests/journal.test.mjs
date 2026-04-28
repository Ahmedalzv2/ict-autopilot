import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadApp, gstDate } from './harness.mjs';

describe('Journal persistence (localStorage round-trip)', () => {
  test('saveJournal → loadJournal restores entries', () => {
    const ctx = loadApp();
    ctx.app.journal = [{ id: 1, symbol: 'BTC', signal: 'armed' }];
    ctx.app.saveJournal();

    // Reload with same storage to confirm round-trip
    const stored = ctx.sandbox.localStorage.getItem('ict_autopilot_journal');
    assert.ok(stored, 'journal should be persisted');

    const ctx2 = loadApp({ storage: { ict_autopilot_journal: stored } });
    ctx2.app.loadJournal();
    const restored = [...ctx2.app.journal];
    assert.equal(restored.length, 1);
    assert.equal(restored[0].symbol, 'BTC');
  });

  test('loadJournal recovers gracefully from corrupted JSON', () => {
    const ctx = loadApp({ storage: { ict_autopilot_journal: '{not-json' } });
    ctx.app.loadJournal();
    assert.deepEqual([...ctx.app.journal], []);
  });

  test('saveJournal silently truncates to the last 500 entries', () => {
    const ctx = loadApp();
    ctx.app.journal = Array.from({ length: 600 }, (_, i) => ({ id: i }));
    ctx.app.saveJournal();
    const raw = ctx.sandbox.localStorage.getItem('ict_autopilot_journal');
    const parsed = JSON.parse(raw);
    assert.equal(parsed.length, 500, 'should cap at 500');
    assert.equal(parsed[0].id, 0, 'keeps the head of the array (newest entries since logCall unshifts)');
  });
});

describe('Outcome resolution (Binance kline → win/loss/be)', () => {
  function makeFetchStub(closePrices) {
    let i = 0;
    return async () => ({
      json: async () => [[Date.now(), '0', '0', '0', String(closePrices[i++] ?? closePrices[closePrices.length - 1])]],
    });
  }

  test('bull setup, close price ≥ TP → win', async () => {
    const ctx = loadApp({ fetch: makeFetchStub([105]) });
    ctx.app.journal = [{
      id: 1, symbol: 'BTC', timestamp: Date.now() - 30 * 60_000,
      bias: 'BULLISH', entry: 100, sl: 99, tp: 105, outcome: null, outcomeChecks: {},
    }];
    await ctx.app.fetchOutcomeAtTime(1, 'BTC', Date.now(), 30);
    assert.equal([...ctx.app.journal][0].outcome, 'win');
  });

  test('bull setup, close price ≤ SL → loss', async () => {
    const ctx = loadApp({ fetch: makeFetchStub([98]) });
    ctx.app.journal = [{
      id: 2, symbol: 'BTC', timestamp: Date.now() - 30 * 60_000,
      bias: 'BULLISH', entry: 100, sl: 99, tp: 105, outcome: null, outcomeChecks: {},
    }];
    await ctx.app.fetchOutcomeAtTime(2, 'BTC', Date.now(), 30);
    assert.equal([...ctx.app.journal][0].outcome, 'loss');
  });

  test('bear setup, close price ≤ TP (TP below entry) → win', async () => {
    const ctx = loadApp({ fetch: makeFetchStub([80]) });
    ctx.app.journal = [{
      id: 3, symbol: 'SOL', timestamp: Date.now() - 60 * 60_000,
      bias: 'BEARISH', entry: 86, sl: 87, tp: 80, outcome: null, outcomeChecks: {},
    }];
    await ctx.app.fetchOutcomeAtTime(3, 'SOL', Date.now(), 60);
    assert.equal([...ctx.app.journal][0].outcome, 'win');
  });

  test('480-min check with no TP/SL hit → break-even', async () => {
    const ctx = loadApp({ fetch: makeFetchStub([100.5]) }); // between SL 99 and TP 105
    ctx.app.journal = [{
      id: 4, symbol: 'BTC', timestamp: Date.now() - 480 * 60_000,
      bias: 'BULLISH', entry: 100, sl: 99, tp: 105, outcome: null, outcomeChecks: {},
    }];
    await ctx.app.fetchOutcomeAtTime(4, 'BTC', Date.now(), 480);
    assert.equal([...ctx.app.journal][0].outcome, 'be');
  });

  test('30-min check with no TP/SL hit → outcome stays null (resolves on later check)', async () => {
    const ctx = loadApp({ fetch: makeFetchStub([100.5]) });
    ctx.app.journal = [{
      id: 5, symbol: 'BTC', timestamp: Date.now() - 30 * 60_000,
      bias: 'BULLISH', entry: 100, sl: 99, tp: 105, outcome: null, outcomeChecks: {},
    }];
    await ctx.app.fetchOutcomeAtTime(5, 'BTC', Date.now(), 30);
    assert.equal([...ctx.app.journal][0].outcome, null);
    assert.equal([...ctx.app.journal][0].outcomeChecks['30'], 100.5);
  });

  test('an already-resolved entry is not overwritten by a later check', async () => {
    const ctx = loadApp({ fetch: makeFetchStub([98]) });
    ctx.app.journal = [{
      id: 6, symbol: 'BTC', timestamp: Date.now() - 240 * 60_000,
      bias: 'BULLISH', entry: 100, sl: 99, tp: 105,
      outcome: 'win', outcomeChecks: { '30': 105 },
    }];
    await ctx.app.fetchOutcomeAtTime(6, 'BTC', Date.now(), 240);
    assert.equal([...ctx.app.journal][0].outcome, 'win', 'must not flip win → loss on a later candle');
  });

  test('failed fetch (network) does not crash and leaves entry unresolved', async () => {
    const ctx = loadApp({ fetch: async () => { throw new Error('network'); } });
    ctx.app.journal = [{
      id: 7, symbol: 'BTC', timestamp: Date.now() - 30 * 60_000,
      bias: 'BULLISH', entry: 100, sl: 99, tp: 105, outcome: null, outcomeChecks: {},
    }];
    await ctx.app.fetchOutcomeAtTime(7, 'BTC', Date.now(), 30);
    assert.equal([...ctx.app.journal][0].outcome, null);
  });
});

describe('scheduleOutcomeChecks (Binance vs non-Binance)', () => {
  test('non-Binance asset (GOLD) → no checks scheduled (manual outcome only)', () => {
    let calls = 0;
    const ctx = loadApp({ setTimeout: (...args) => { calls++; return 0; } });
    ctx.app.scheduleOutcomeChecks({ id: 1, symbol: 'GOLD', timestamp: Date.now() });
    assert.equal(calls, 0);
  });

  test('Binance asset (BTC) → schedules one timer per OUTCOME_CHECKS interval', () => {
    let calls = 0;
    const ctx = loadApp({ setTimeout: () => { calls++; return 0; } });
    ctx.app.scheduleOutcomeChecks({ id: 1, symbol: 'BTC', timestamp: Date.now() });
    assert.equal(calls, [...ctx.app.OUTCOME_CHECKS].length);
  });
});

describe('setManualOutcome (manual win/loss override)', () => {
  test('flips an entry from null → win', () => {
    const ctx = loadApp();
    ctx.app.journal = [{ id: 1, symbol: 'GOLD', outcome: null }];
    ctx.app.setManualOutcome(1, 'win');
    assert.equal([...ctx.app.journal][0].outcome, 'win');
  });

  test('non-existent id is a no-op (does not throw)', () => {
    const ctx = loadApp();
    ctx.app.journal = [{ id: 1, symbol: 'GOLD', outcome: null }];
    ctx.app.setManualOutcome(999, 'win'); // should not throw
    assert.equal([...ctx.app.journal][0].outcome, null);
  });
});
