import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadApp, gstDate } from './harness.mjs';

const { app } = loadApp();

describe('Session catalog (your trading windows)', () => {
  test('exposes all five GST sessions in the order the algorithm scans them', () => {
    const names = [...app.SESSION_DEFS].map((s) => s.name);
    assert.deepEqual(names, [
      'London Kill Zone',
      'NY AM Kill Zone',
      'ICT Macro AM',
      '⛔ Dead Zone',
      'Silver Bullet PM',
    ]);
  });

  test('classifies session types correctly (active / macro / dead)', () => {
    const byName = Object.fromEntries(app.SESSION_DEFS.map((s) => [s.name, s.type]));
    assert.equal(byName['London Kill Zone'], 'active');
    assert.equal(byName['NY AM Kill Zone'], 'active');
    assert.equal(byName['ICT Macro AM'], 'macro');
    assert.equal(byName['⛔ Dead Zone'], 'dead');
    assert.equal(byName['Silver Bullet PM'], 'macro');
  });
});

describe('getCurrentSession (GST)', () => {
  const cases = [
    // [label, h, m, expectedSessionName_or_null]
    ['just before London KZ',         7, 59,  null],
    ['London KZ open',                8, 0,   'London Kill Zone'],
    ['London KZ mid',                 9, 30,  'London Kill Zone'],
    ['London KZ last minute',         9, 59,  'London Kill Zone'],
    ['exactly London KZ close',       10, 0,  null],                  // end is exclusive
    ['between London and NY AM',      11, 30, null],
    ['NY AM open',                    13, 0,  'NY AM Kill Zone'],
    ['NY AM close (exclusive)',       15, 0,  null],
    ['gap before Macro AM',           18, 49, null],
    ['Macro AM open',                 18, 50, 'ICT Macro AM'],
    ['Macro AM mid',                  18, 55, 'ICT Macro AM'],
    ['Macro AM end → Dead Zone',      19, 0,  '⛔ Dead Zone'],
    ['Dead Zone mid',                 20, 30, '⛔ Dead Zone'],
    ['Dead Zone last minute',         21, 59, '⛔ Dead Zone'],
    ['Dead Zone close (exclusive)',   22, 0,  null],
    ['gap before Silver Bullet',      22, 49, null],
    ['Silver Bullet PM open',         22, 50, 'Silver Bullet PM'],
    ['Silver Bullet PM end',          23, 30, null],
    ['after Silver Bullet',           23, 45, null],
    ['midnight',                      0, 0,   null],
  ];

  for (const [label, h, m, expected] of cases) {
    test(`${label} (${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')} GST)`, () => {
      const s = app.getCurrentSession(gstDate(h, m));
      if (expected === null) assert.equal(s, null);
      else assert.equal(s?.name, expected);
    });
  }
});

describe('getNextKillZone (countdown driver)', () => {
  test('at 07:00 GST → London KZ in 60 minutes', () => {
    const next = app.getNextKillZone(gstDate(7, 0));
    assert.equal(next.name, 'London Kill Zone');
    assert.equal(next.diffMin, 60);
  });

  test('skips Dead Zone — at 11:30 GST next is NY AM, not Dead Zone', () => {
    const next = app.getNextKillZone(gstDate(11, 30));
    assert.equal(next.name, 'NY AM Kill Zone');
    assert.equal(next.diffMin, 90);
  });

  test('at 19:30 (mid Dead Zone) → next is Silver Bullet PM, not Dead Zone', () => {
    const next = app.getNextKillZone(gstDate(19, 30));
    assert.equal(next.name, 'Silver Bullet PM');
    assert.equal(next.diffMin, 22 * 60 + 50 - (19 * 60 + 30));
  });

  test('at 23:45 (after last KZ) → wraps to tomorrow’s London KZ', () => {
    const next = app.getNextKillZone(gstDate(23, 45));
    assert.equal(next.name, 'London Kill Zone');
    // (24*60 - 23:45) + 8:00 = 15 + 480 = 495
    assert.equal(next.diffMin, 495);
  });

  test('at 00:00 GST → London KZ in 8h', () => {
    const next = app.getNextKillZone(gstDate(0, 0));
    assert.equal(next.name, 'London Kill Zone');
    assert.equal(next.diffMin, 480);
  });

  test('inside London KZ → returns NEXT KZ (not the current one)', () => {
    // Iterating from the start of SESSION_DEFS, London is skipped because tot >= start.
    const next = app.getNextKillZone(gstDate(9, 0));
    assert.equal(next.name, 'NY AM Kill Zone');
    assert.equal(next.diffMin, 4 * 60);
  });
});

describe('getGST (UTC → GST conversion)', () => {
  test('produces a Date whose hour-of-day is GST', () => {
    // The harness sets TZ=UTC during load, but for tests here we exercise
    // the function directly. On a UTC test process, getGST should return a
    // time roughly 4 hours ahead of system UTC.
    const before = Date.now();
    const gst = app.getGST();
    const after = Date.now();
    // The constructed GST Date should be within 4h±1s of the current UTC ms.
    const expected = before + 4 * 3600 * 1000;
    assert.ok(Math.abs(gst.getTime() - expected) < 5000, `expected ~${expected}, got ${gst.getTime()}, system between ${before} and ${after}`);
  });
});
