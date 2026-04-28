import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadApp, gstDate } from './harness.mjs';

const { app } = loadApp();

describe('fmtTime — 12h GST clock', () => {
  test('midnight → 12:00 AM', () => {
    assert.equal(app.fmtTime(gstDate(0, 0)), '12:00 AM');
  });

  test('noon → 12:00 PM (not 0:00 PM)', () => {
    assert.equal(app.fmtTime(gstDate(12, 0)), '12:00 PM');
  });

  test('zero-pads minutes', () => {
    assert.equal(app.fmtTime(gstDate(8, 5)), '8:05 AM');
  });

  test('with seconds includes a zero-padded SS', () => {
    assert.equal(app.fmtTime(gstDate(13, 7, 3), true), '1:07:03 PM');
  });

  test('11:59 PM is the last minute of the GST day', () => {
    assert.equal(app.fmtTime(gstDate(23, 59)), '11:59 PM');
  });
});

describe('fmt12hm — raw hour/minute formatter', () => {
  const cases = [
    [0, 0, '12:00 AM'],
    [0, 30, '12:30 AM'],
    [11, 59, '11:59 AM'],
    [12, 0, '12:00 PM'],
    [13, 0, '1:00 PM'],
    [22, 50, '10:50 PM'], // Silver Bullet PM open
  ];
  for (const [h, m, expected] of cases) {
    test(`${h}:${String(m).padStart(2, '0')} → ${expected}`, () => {
      assert.equal(app.fmt12hm(h, m), expected);
    });
  }
});

describe('fmtCountdown — HH:MM:SS from minutes', () => {
  test('60 minutes → 01:00:00', () => {
    assert.equal(app.fmtCountdown(60), '01:00:00');
  });

  test('1.5 minutes → 00:01:30', () => {
    assert.equal(app.fmtCountdown(1.5), '00:01:30');
  });

  test('zero → 00:00:00', () => {
    assert.equal(app.fmtCountdown(0), '00:00:00');
  });

  test('495 minutes (overnight wrap) → 08:15:00', () => {
    assert.equal(app.fmtCountdown(495), '08:15:00');
  });
});
