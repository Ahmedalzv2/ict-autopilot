import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadApp } from './harness.mjs';

/**
 * Macro blackout: ±30 minutes around high/critical impact ECON_EVENTS.
 * Algo-driven volatility around FOMC/CPI/NFP/PCE has nothing to do with
 * ICT structure — getSignal returns 'blackout' to suppress entries.
 */

// Construct a Date at GST h:m on a chosen UTC date. Reused in lieu of gstDate
// because we need to anchor to a real ECON_EVENTS row, not a synthetic day.
function gstAt(dateStr, hh, mm) {
  // ECON_EVENTS rows are stored as date+time in GST (UTC+4). For a test Date
  // whose .getHours() in the test process (TZ=UTC) reads as the GST hour, we
  // construct a local-time Date directly.
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(y, m - 1, d, hh, mm, 0);
}

describe('getMacroBlackout', () => {
  test('outside any window → null', () => {
    const { app } = loadApp();
    // No high-impact event near 2024-01-15 12:00 GST
    const noWindow = new Date('2024-01-15T12:00:00+04:00');
    assert.equal(app.getMacroBlackout(noWindow), null);
  });

  test('exactly at an event → blackout active', () => {
    const { app } = loadApp();
    // Find any high-impact ECON_EVENTS row dynamically and test against it.
    const high = [...app.ECON_EVENTS].find(e => e.impact === 'high' || e.impact === 'critical');
    assert.ok(high, 'fixture should contain at least one high-impact event');
    const at = new Date(`${high.date}T${high.time}:00+04:00`);
    const bl = app.getMacroBlackout(at);
    assert.ok(bl, 'blackout should be active at exact event time');
    assert.equal(bl.event, high.event);
    assert.equal(bl.minutes, 0);
  });

  test('29 min before high-impact event → blackout active (side: before)', () => {
    const { app } = loadApp();
    const high = [...app.ECON_EVENTS].find(e => e.impact === 'high' || e.impact === 'critical');
    const eventTs = new Date(`${high.date}T${high.time}:00+04:00`).getTime();
    const at = new Date(eventTs - 29 * 60_000);
    const bl = app.getMacroBlackout(at);
    assert.ok(bl);
    assert.equal(bl.side, 'before');
  });

  test('29 min after high-impact event → blackout active (side: after)', () => {
    const { app } = loadApp();
    const high = [...app.ECON_EVENTS].find(e => e.impact === 'high' || e.impact === 'critical');
    const eventTs = new Date(`${high.date}T${high.time}:00+04:00`).getTime();
    const at = new Date(eventTs + 29 * 60_000);
    const bl = app.getMacroBlackout(at);
    assert.ok(bl);
    assert.equal(bl.side, 'after');
  });

  test('31 min before event → outside the window', () => {
    const { app } = loadApp();
    const high = [...app.ECON_EVENTS].find(e => e.impact === 'high' || e.impact === 'critical');
    const eventTs = new Date(`${high.date}T${high.time}:00+04:00`).getTime();
    const at = new Date(eventTs - 31 * 60_000);
    assert.equal(app.getMacroBlackout(at), null);
  });

  test('medium-impact events do NOT trigger blackout', () => {
    const { app } = loadApp();
    const med = [...app.ECON_EVENTS].find(e => e.impact === 'medium');
    if (!med) return; // skip if fixture has no medium event
    const at = new Date(`${med.date}T${med.time}:00+04:00`);
    assert.equal(app.getMacroBlackout(at), null);
  });
});

describe('getSignal under macro blackout', () => {
  test('returns "blackout" overriding ENTER NOW', () => {
    const { app } = loadApp();
    const high = [...app.ECON_EVENTS].find(e => e.impact === 'high' || e.impact === 'critical');
    const at = new Date(`${high.date}T${high.time}:00+04:00`);

    app.mtfCache = { BTC: { h1: 'bull', h4: 'bull', d1: 'bull', ts: Date.now() } };
    const a = {
      symbol: 'BTC', bias: 'BULLISH',
      entry: 100, sl: 99, tp: 105, tp1: 105, grade: 'a',
      price: 100.04, change24h: 0,
      checks: [1, 1, 1, 1, 1, 1, 1, 1, 1, 1], reason: '',
    };
    assert.equal(app.getSignal(a, at), 'blackout');
  });

  test('invalidation still wins over blackout (terminal state ranks higher)', () => {
    const { app } = loadApp();
    const high = [...app.ECON_EVENTS].find(e => e.impact === 'high' || e.impact === 'critical');
    const at = new Date(`${high.date}T${high.time}:00+04:00`);

    const a = {
      symbol: 'BTC', bias: 'BULLISH',
      entry: 100, sl: 99, tp: 105, tp1: 105, grade: 'a',
      price: 94, change24h: 0,
      checks: [1, 1, 1, 1, 1, 1, 1, 1, 1, 1], reason: '',
      invalidationPrice: 95,
    };
    assert.equal(app.getSignal(a, at), 'invalid');
  });
});

describe('analyzeAsset blackout narrative', () => {
  test('shows MACRO BLACKOUT and the event name', () => {
    const { app } = loadApp();
    const high = [...app.ECON_EVENTS].find(e => e.impact === 'high' || e.impact === 'critical');
    const at = new Date(`${high.date}T${high.time}:00+04:00`);

    app.mtfCache = { BTC: { h1: 'bull', h4: 'bull', d1: 'bull', ts: Date.now() } };
    const a = {
      symbol: 'BTC', bias: 'BULLISH',
      entry: 100, sl: 99, tp: 105, tp1: 105, grade: 'a',
      price: 100, change24h: 0,
      checks: [1, 1, 1, 1, 1, 1, 1, 1, 1, 1], reason: '',
    };
    const text = app.analyzeAsset(a, at);
    assert.match(text, /MACRO BLACKOUT/);
    assert.match(text, new RegExp(high.event.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  });
});
