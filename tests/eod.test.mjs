import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadApp, gstDate } from './harness.mjs';

const TODAY = '2024-06-15';

function makeJournalEntry(o = {}) {
  return {
    date: TODAY,
    timestamp: new Date(2024, 5, 15, 9, 30).getTime(),
    symbol: 'BTC', bias: 'BULLISH',
    entry: 100, sl: 99, tp: 105, tp1: 105, grade: 'a',
    session: 'London Kill Zone',
    outcome: null,
    ...o,
  };
}

describe('summarizeDay — pure aggregation', () => {
  const { app } = loadApp();

  test('empty journal → zeroed stats, no crash', () => {
    const s = app.summarizeDay([], TODAY);
    assert.equal(s.total, 0);
    assert.equal(s.winRate, 0);
    assert.equal(s.totalR, 0);
    assert.equal(s.bestTrade, null);
    assert.equal(s.worstTrade, null);
    assert.equal([...s.sessionsHit].length, 0);
    // Tradeable sessions in the default SESSION_DEFS = active + macro = 4.
    assert.equal([...s.sessionsMissed].length, 4);
  });

  test('only counts entries from todayKey (matches via date OR timestamp)', () => {
    const yesterdayTs = new Date(2024, 5, 14, 9, 30).getTime();
    const j = [
      makeJournalEntry({ outcome: 'win',  date: TODAY }),
      makeJournalEntry({ outcome: 'loss', date: '2024-06-14', timestamp: yesterdayTs }),
    ];
    const s = app.summarizeDay(j, TODAY);
    assert.equal(s.total, 1);
    assert.equal(s.wins, 1);
    assert.equal(s.losses, 0);
  });

  test('win-rate computed over RESOLVED only (pending excluded)', () => {
    const j = [
      makeJournalEntry({ outcome: 'win' }),
      makeJournalEntry({ outcome: 'loss' }),
      makeJournalEntry({ outcome: null }), // pending — should not count
    ];
    const s = app.summarizeDay(j, TODAY);
    assert.equal(s.total, 3);
    assert.equal(s.pending, 1);
    assert.equal(s.winRate, 0.5);
  });

  test('totalR uses entry.rMultiple if present, else nominalR fallback', () => {
    const j = [
      makeJournalEntry({ outcome: 'win', rMultiple: 4.82 }), // realistic-cost R
      makeJournalEntry({ outcome: 'loss' }),                  // nominal -1
    ];
    const s = app.summarizeDay(j, TODAY);
    assert.ok(Math.abs(s.totalR - (4.82 - 1)) < 1e-9);
  });

  test('best / worst trade by R-multiple', () => {
    const j = [
      makeJournalEntry({ outcome: 'win', symbol: 'BTC', rMultiple: 5 }),
      makeJournalEntry({ outcome: 'win', symbol: 'ETH', rMultiple: 2 }),
      makeJournalEntry({ outcome: 'loss', symbol: 'SOL', rMultiple: -1 }),
    ];
    const s = app.summarizeDay(j, TODAY);
    assert.equal(s.bestTrade.symbol, 'BTC');
    assert.equal(s.worstTrade.symbol, 'SOL');
  });

  test('per-session breakdown counts and sums', () => {
    const j = [
      makeJournalEntry({ session: 'London Kill Zone', outcome: 'win',  rMultiple: 3 }),
      makeJournalEntry({ session: 'London Kill Zone', outcome: 'loss', rMultiple: -1 }),
      makeJournalEntry({ session: 'NY AM Kill Zone',  outcome: 'win',  rMultiple: 2 }),
    ];
    const s = app.summarizeDay(j, TODAY);
    assert.equal(s.bySession['London Kill Zone'].count, 2);
    assert.equal(s.bySession['London Kill Zone'].wins, 1);
    assert.equal(s.bySession['London Kill Zone'].losses, 1);
    assert.equal(s.bySession['London Kill Zone'].totalR, 2);
    assert.equal(s.bySession['NY AM Kill Zone'].count, 1);
  });

  test('sessionsHit / sessionsMissed reflect actual entries', () => {
    const j = [
      makeJournalEntry({ session: 'London Kill Zone' }),
      makeJournalEntry({ session: 'Silver Bullet PM' }),
    ];
    const s = app.summarizeDay(j, TODAY);
    const hit = [...s.sessionsHit];
    const missed = [...s.sessionsMissed];
    assert.ok(hit.includes('London Kill Zone'));
    assert.ok(hit.includes('Silver Bullet PM'));
    assert.ok(missed.includes('NY AM Kill Zone'));
    assert.ok(missed.includes('ICT Macro AM'));
    // Dead Zone excluded entirely (no-trade window)
    assert.ok(!hit.includes('⛔ Dead Zone'));
    assert.ok(!missed.includes('⛔ Dead Zone'));
  });

  test('falls back to gstDateKey(timestamp) when entry.date is missing', () => {
    const todayTs = new Date(2024, 5, 15, 9, 30).getTime();
    const j = [
      { timestamp: todayTs, symbol: 'BTC', bias: 'BULLISH', entry: 100, sl: 99, tp: 105,
        outcome: 'win', session: 'London Kill Zone' },
    ];
    const s = app.summarizeDay(j, TODAY);
    assert.equal(s.total, 1);
  });
});

describe('maybeRenderEodRecap — fires once per GST day at 23:59', () => {
  test('not at 23:59 → does not fire', () => {
    const ctx = loadApp();
    ctx.app.journal = [];
    ctx.app.maybeRenderEodRecap(gstDate(15, 30));
    const last = ctx.sandbox.localStorage.getItem(ctx.app.EOD_LAST_KEY);
    assert.equal(last, null);
  });

  test('at 23:59 with no prior fire today → records the date in localStorage', () => {
    const ctx = loadApp();
    ctx.app.journal = [];
    ctx.app.maybeRenderEodRecap(gstDate(23, 59));
    const last = ctx.sandbox.localStorage.getItem(ctx.app.EOD_LAST_KEY);
    assert.equal(last, '2024-06-15');
  });

  test('second call within the same minute → no duplicate (dedup via localStorage)', () => {
    const ctx = loadApp({ storage: { ict_last_eod_date: '2024-06-15' } });
    let renders = 0;
    // Replace the modal renderer with a counter on the sandbox so we can
    // observe whether it was invoked.
    ctx.sandbox.renderEodRecapModal = () => { renders++; };
    ctx.app.journal = [];
    ctx.app.maybeRenderEodRecap(gstDate(23, 59));
    assert.equal(renders, 0, 'already fired today, do not re-render');
  });

  test('different date stored → fires (handles a midnight rollover or skipped day)', () => {
    const ctx = loadApp({ storage: { ict_last_eod_date: '2024-06-14' } }); // yesterday's record
    ctx.app.journal = [];
    ctx.app.maybeRenderEodRecap(gstDate(23, 59));
    const last = ctx.sandbox.localStorage.getItem(ctx.app.EOD_LAST_KEY);
    assert.equal(last, '2024-06-15', 'today\'s date is now persisted');
  });

  test('no gst arg → no-op (defensive)', () => {
    const ctx = loadApp();
    ctx.app.maybeRenderEodRecap(null);
    ctx.app.maybeRenderEodRecap(undefined);
    // Just asserting nothing throws.
    assert.equal(ctx.sandbox.localStorage.getItem(ctx.app.EOD_LAST_KEY), null);
  });
});
