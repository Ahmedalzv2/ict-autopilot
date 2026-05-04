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

describe('Outcome resolution (Binance kline range scan → win/loss/be)', () => {
  // Each kline: [openTime, open, high, low, close, volume, closeTime, ...]
  // We mock fetch to return an array of klines so the resolver can scan
  // for intra-candle TP/SL touches (wicks).
  function klinesFromOHLC(ohlcs) {
    return ohlcs.map((c, i) => {
      const [o, h, l, cl] = c;
      return [Date.now() + i * 60_000, String(o), String(h), String(l), String(cl), '0'];
    });
  }
  function makeFetchStub(klines) {
    return async () => ({ ok: true, json: async () => klines });
  }

  test('bull setup, candle high ≥ TP (wick hit) → win — even if close < TP', async () => {
    // Previous implementation only looked at close; this test guards the fix
    // that now scans candle highs/lows for intra-candle touches.
    const klines = klinesFromOHLC([
      [100, 102, 99.5, 101],
      [101, 105.5, 100, 102], // wick to 105.5 hits TP=105, close back at 102
    ]);
    const ctx = loadApp({ fetch: makeFetchStub(klines) });
    ctx.app.journal = [{
      id: 1, symbol: 'BTC', timestamp: Date.now() - 30 * 60_000,
      bias: 'BULLISH', entry: 100, sl: 99, tp: 105, outcome: null, outcomeChecks: {},
    }];
    await ctx.app.fetchOutcomeAtTime(1, 'BTC', Date.now(), 30);
    assert.equal([...ctx.app.journal][0].outcome, 'win');
  });

  test('bull setup, candle low ≤ SL (wick) → loss', async () => {
    const klines = klinesFromOHLC([
      [100, 100.5, 98.5, 99.8], // wick to 98.5 hits SL=99
    ]);
    const ctx = loadApp({ fetch: makeFetchStub(klines) });
    ctx.app.journal = [{
      id: 2, symbol: 'BTC', timestamp: Date.now() - 30 * 60_000,
      bias: 'BULLISH', entry: 100, sl: 99, tp: 105, outcome: null, outcomeChecks: {},
    }];
    await ctx.app.fetchOutcomeAtTime(2, 'BTC', Date.now(), 30);
    assert.equal([...ctx.app.journal][0].outcome, 'loss');
  });

  test('bear setup, low ≤ TP (TP below entry) → win', async () => {
    const klines = klinesFromOHLC([
      [86, 86.2, 79.8, 81], // wick to 79.8 hits TP=80 (bear: TP below entry)
    ]);
    const ctx = loadApp({ fetch: makeFetchStub(klines) });
    ctx.app.journal = [{
      id: 3, symbol: 'SOL', timestamp: Date.now() - 60 * 60_000,
      bias: 'BEARISH', entry: 86, sl: 87, tp: 80, outcome: null, outcomeChecks: {},
    }];
    await ctx.app.fetchOutcomeAtTime(3, 'SOL', Date.now(), 60);
    assert.equal([...ctx.app.journal][0].outcome, 'win');
  });

  test('TP and SL both hit in same candle → defaults to loss (conservative)', async () => {
    const klines = klinesFromOHLC([
      [100, 105.5, 98.5, 100], // both 105.5 (TP) and 98.5 (SL) within the candle
    ]);
    const ctx = loadApp({ fetch: makeFetchStub(klines) });
    ctx.app.journal = [{
      id: 4, symbol: 'BTC', timestamp: Date.now() - 30 * 60_000,
      bias: 'BULLISH', entry: 100, sl: 99, tp: 105, outcome: null, outcomeChecks: {},
    }];
    await ctx.app.fetchOutcomeAtTime(4, 'BTC', Date.now(), 30);
    assert.equal([...ctx.app.journal][0].outcome, 'loss');
  });

  test('480-min check with no TP/SL hit anywhere in range → break-even', async () => {
    const klines = klinesFromOHLC([
      [100, 100.4, 99.7, 100.1], [100.1, 100.3, 99.8, 100.0],
    ]);
    const ctx = loadApp({ fetch: makeFetchStub(klines) });
    ctx.app.journal = [{
      id: 5, symbol: 'BTC', timestamp: Date.now() - 480 * 60_000,
      bias: 'BULLISH', entry: 100, sl: 99, tp: 105, outcome: null, outcomeChecks: {},
    }];
    await ctx.app.fetchOutcomeAtTime(5, 'BTC', Date.now(), 480);
    assert.equal([...ctx.app.journal][0].outcome, 'be');
  });

  test('30-min check with no TP/SL hit → outcome null (resolves on later check)', async () => {
    const klines = klinesFromOHLC([[100, 100.4, 99.7, 100.1]]);
    const ctx = loadApp({ fetch: makeFetchStub(klines) });
    ctx.app.journal = [{
      id: 6, symbol: 'BTC', timestamp: Date.now() - 30 * 60_000,
      bias: 'BULLISH', entry: 100, sl: 99, tp: 105, outcome: null, outcomeChecks: {},
    }];
    await ctx.app.fetchOutcomeAtTime(6, 'BTC', Date.now(), 30);
    assert.equal([...ctx.app.journal][0].outcome, null);
    assert.equal([...ctx.app.journal][0].outcomeChecks['30'], 100.1);
  });

  test('an already-resolved entry is not overwritten by a later check', async () => {
    const klines = klinesFromOHLC([[100, 100.5, 98.5, 99]]); // would now hit SL
    const ctx = loadApp({ fetch: makeFetchStub(klines) });
    ctx.app.journal = [{
      id: 7, symbol: 'BTC', timestamp: Date.now() - 240 * 60_000,
      bias: 'BULLISH', entry: 100, sl: 99, tp: 105,
      outcome: 'win', outcomeChecks: { '30': 105 },
    }];
    await ctx.app.fetchOutcomeAtTime(7, 'BTC', Date.now(), 240);
    assert.equal([...ctx.app.journal][0].outcome, 'win');
  });

  test('failed fetch (network) does not crash and leaves entry unresolved', async () => {
    const ctx = loadApp({ fetch: async () => { throw new Error('network'); } });
    ctx.app.journal = [{
      id: 8, symbol: 'BTC', timestamp: Date.now() - 30 * 60_000,
      bias: 'BULLISH', entry: 100, sl: 99, tp: 105, outcome: null, outcomeChecks: {},
    }];
    await ctx.app.fetchOutcomeAtTime(8, 'BTC', Date.now(), 30);
    assert.equal([...ctx.app.journal][0].outcome, null);
  });

  test('first-touch wins: TP hit in candle 1, SL hit in candle 2 → win', async () => {
    const klines = klinesFromOHLC([
      [100, 105.5, 99.5, 102], // TP hit first
      [102, 102.5, 98.5, 99],  // SL hit later — ignored
    ]);
    const ctx = loadApp({ fetch: makeFetchStub(klines) });
    ctx.app.journal = [{
      id: 9, symbol: 'BTC', timestamp: Date.now() - 60 * 60_000,
      bias: 'BULLISH', entry: 100, sl: 99, tp: 105, outcome: null, outcomeChecks: {},
    }];
    await ctx.app.fetchOutcomeAtTime(9, 'BTC', Date.now(), 60);
    assert.equal([...ctx.app.journal][0].outcome, 'win');
  });
});

describe('scheduleOutcomeChecks (Binance vs non-Binance)', () => {
  // App init schedules its own background setTimeouts (price sync, etc.), so
  // we count from a baseline taken *after* loadApp returns.
  test('non-Binance asset (GOLD) → no checks scheduled (manual outcome only)', () => {
    let calls = 0;
    const ctx = loadApp({ setTimeout: () => { calls++; return 0; } });
    calls = 0;
    ctx.app.scheduleOutcomeChecks({ id: 1, symbol: 'GOLD', timestamp: Date.now() });
    assert.equal(calls, 0);
  });

  test('Binance asset (BTC) → schedules one timer per OUTCOME_CHECKS interval', () => {
    let calls = 0;
    const ctx = loadApp({ setTimeout: () => { calls++; return 0; } });
    calls = 0;
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
