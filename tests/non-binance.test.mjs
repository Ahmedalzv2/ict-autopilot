import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadApp } from './harness.mjs';

describe('parseGoldPriceResponse — goldprice.org JSON shape', () => {
  const { app } = loadApp();

  test('extracts xauPrice and xagPrice from items[0]', () => {
    const r = app.parseGoldPriceResponse({
      items: [{ curr: 'USD', xauPrice: 2412.50, xagPrice: 28.95 }],
    });
    assert.equal(r.GOLD, 2412.50);
    assert.equal(r.SILVER, 28.95);
  });

  test('missing items → empty object (no crash)', () => {
    const r = app.parseGoldPriceResponse({});
    assert.deepEqual({ ...r }, {});
  });

  test('non-finite prices are skipped (no NaN written)', () => {
    const r = app.parseGoldPriceResponse({
      items: [{ xauPrice: 'oops', xagPrice: null }],
    });
    assert.deepEqual({ ...r }, {});
  });

  test('partial response (only xau) returns just GOLD', () => {
    const r = app.parseGoldPriceResponse({ items: [{ xauPrice: 2400 }] });
    assert.equal(r.GOLD, 2400);
    assert.equal(r.SILVER, undefined);
  });
});

describe('parseYahooChartResponse — Yahoo v8 chart shape', () => {
  const { app } = loadApp();

  test('returns the latest non-null close from indicators', () => {
    const json = {
      chart: { result: [{
        indicators: { quote: [{ close: [17000, 17050, 17120, null, null] }] },
      }] },
    };
    assert.equal(app.parseYahooChartResponse(json), 17120);
  });

  test('falls back to meta.regularMarketPrice when all closes null (market closed)', () => {
    const json = {
      chart: { result: [{
        indicators: { quote: [{ close: [null, null] }] },
        meta: { regularMarketPrice: 17234.56 },
      }] },
    };
    assert.equal(app.parseYahooChartResponse(json), 17234.56);
  });

  test('totally empty response → null', () => {
    assert.equal(app.parseYahooChartResponse({}), null);
    assert.equal(app.parseYahooChartResponse(null), null);
  });

  test('all null closes + no meta → null', () => {
    const json = { chart: { result: [{ indicators: { quote: [{ close: [null] }] } }] } };
    assert.equal(app.parseYahooChartResponse(json), null);
  });
});

describe('parseStooqCsv — stooq CSV row', () => {
  const { app } = loadApp();

  test('extracts close from second line', () => {
    const csv = 'Symbol,Date,Time,Open,High,Low,Close,Volume\n^NDX,2026-04-29,21:30:00,17000,17150,16950,17234.56,1234567';
    assert.equal(app.parseStooqCsv(csv), 17234.56);
  });

  test('header-only CSV → null', () => {
    const csv = 'Symbol,Date,Time,Open,High,Low,Close,Volume\n';
    assert.equal(app.parseStooqCsv(csv), null);
  });

  test('non-string input → null (no crash)', () => {
    assert.equal(app.parseStooqCsv(null), null);
    assert.equal(app.parseStooqCsv(undefined), null);
    assert.equal(app.parseStooqCsv(42), null);
  });

  test('non-numeric close field → null', () => {
    const csv = 'Symbol,Date,Time,Open,High,Low,Close,Volume\n^NDX,2026-04-29,21:30:00,17000,17150,16950,N/A,1234567';
    assert.equal(app.parseStooqCsv(csv), null);
  });

  test('handles \\r\\n line endings (Windows-style CSV)', () => {
    const csv = 'Symbol,Date,Time,Open,High,Low,Close,Volume\r\n^NDX,2026-04-29,21:30:00,17000,17150,16950,17234.56,1234567\r\n';
    assert.equal(app.parseStooqCsv(csv), 17234.56);
  });
});

describe('fetchNonBinancePrices — async integration', () => {
  test('updates GOLD/SILVER/US100 on ASSETS when sources return data', async () => {
    const ctx = loadApp({
      fetch: async (url) => {
        const u = String(url);
        if (u.includes('goldprice.org')) {
          return { ok: true, json: async () => ({ items: [{ xauPrice: 2412.50, xagPrice: 28.95 }] }) };
        }
        if (u.includes('finance.yahoo.com')) {
          return { ok: true, json: async () => ({
            chart: { result: [{ indicators: { quote: [{ close: [17234.56] }] } }] },
          }) };
        }
        return { ok: false };
      },
    });
    await ctx.app.fetchNonBinancePrices();
    const gold = [...ctx.app.ASSETS].find(a => a.symbol === 'GOLD');
    const silver = [...ctx.app.ASSETS].find(a => a.symbol === 'SILVER');
    const us100 = [...ctx.app.ASSETS].find(a => a.symbol === 'US100');
    assert.equal(gold.price, 2412.50);
    assert.equal(silver.price, 28.95);
    assert.equal(us100.price, 17234.56);
  });

  test('Yahoo failing falls through to stooq', async () => {
    const ctx = loadApp({
      fetch: async (url) => {
        const u = String(url);
        if (u.includes('finance.yahoo.com')) {
          return { ok: false, json: async () => ({}) };
        }
        if (u.includes('stooq.com')) {
          return { ok: true, text: async () => 'Symbol,Date,Time,Open,High,Low,Close,Volume\n^NDX,2026-04-29,21:30:00,0,0,0,17000,0' };
        }
        return { ok: false };
      },
    });
    await ctx.app.fetchNonBinancePrices();
    const us100 = [...ctx.app.ASSETS].find(a => a.symbol === 'US100');
    assert.equal(us100.price, 17000);
  });

  test('all sources failing → ASSETS prices unchanged, no crash', async () => {
    const ctx = loadApp({
      fetch: async () => { throw new Error('CORS'); },
    });
    const before = {
      GOLD:   [...ctx.app.ASSETS].find(a => a.symbol === 'GOLD').price,
      SILVER: [...ctx.app.ASSETS].find(a => a.symbol === 'SILVER').price,
      US100:  [...ctx.app.ASSETS].find(a => a.symbol === 'US100').price,
    };
    const updated = await ctx.app.fetchNonBinancePrices();
    assert.equal(updated, 0);
    assert.equal([...ctx.app.ASSETS].find(a => a.symbol === 'GOLD').price, before.GOLD);
    assert.equal([...ctx.app.ASSETS].find(a => a.symbol === 'SILVER').price, before.SILVER);
    assert.equal([...ctx.app.ASSETS].find(a => a.symbol === 'US100').price, before.US100);
  });

  test('change24h is updated to reflect tick-over-tick movement', async () => {
    const ctx = loadApp({
      fetch: async (url) => {
        const u = String(url);
        if (u.includes('goldprice.org')) {
          return { ok: true, json: async () => ({ items: [{ xauPrice: 2500, xagPrice: 30 }] }) };
        }
        return { ok: false };
      },
    });
    const gold = [...ctx.app.ASSETS].find(a => a.symbol === 'GOLD');
    const previous = gold.price; // seeded value
    await ctx.app.fetchNonBinancePrices();
    const expected = ((2500 - previous) / previous) * 100;
    assert.ok(Math.abs(gold.change24h - expected) < 1e-6,
      `change24h should reflect movement, got ${gold.change24h} expected ${expected}`);
  });
});
