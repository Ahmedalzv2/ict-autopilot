import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadApp } from './harness.mjs';

describe('parseBinanceTicker — /ticker/24hr response shape', () => {
  const { app } = loadApp();

  test('valid response → { price, change24h }', () => {
    const t = app.parseBinanceTicker({ lastPrice: '2412.50', priceChangePercent: '1.34' });
    assert.equal(t.price, 2412.50);
    assert.equal(t.change24h, 1.34);
  });

  test('missing priceChangePercent → change24h falls back to 0', () => {
    const t = app.parseBinanceTicker({ lastPrice: '2412.50' });
    assert.equal(t.price, 2412.50);
    assert.equal(t.change24h, 0);
  });

  test('non-numeric lastPrice → null (no NaN written)', () => {
    assert.equal(app.parseBinanceTicker({ lastPrice: 'oops' }), null);
  });

  test('null/undefined input → null', () => {
    assert.equal(app.parseBinanceTicker(null), null);
    assert.equal(app.parseBinanceTicker(undefined), null);
  });
});

describe('PRICE_PROXY_SYMBOLS configuration (per the user\'s instruction)', () => {
  const { app } = loadApp();

  test('GOLD proxied via XAUTUSDT (Tether Gold)', () => {
    assert.equal(app.PRICE_PROXY_SYMBOLS.GOLD, 'XAUTUSDT');
  });

  test('SILVER proxied via XAGUSDT', () => {
    assert.equal(app.PRICE_PROXY_SYMBOLS.SILVER, 'XAGUSDT');
  });

  test('US100 NOT in the proxy map (no Binance proxy — manual only)', () => {
    assert.equal(app.PRICE_PROXY_SYMBOLS.US100, undefined);
  });
});

describe('fetchNonBinancePrices — async integration', () => {
  test('updates GOLD price when XAUTUSDT returns valid ticker', async () => {
    const ctx = loadApp({
      fetch: async (url) => {
        const u = String(url);
        if (u.includes('XAUTUSDT')) {
          return { ok: true, json: async () => ({ lastPrice: '2412.50', priceChangePercent: '1.20' }) };
        }
        return { ok: false }; // SILVER fails
      },
    });
    await ctx.app.fetchNonBinancePrices();
    const gold = [...ctx.app.ASSETS].find(a => a.symbol === 'GOLD');
    assert.equal(gold.price, 2412.50);
    assert.equal(gold.change24h, 1.20);
  });

  test('updates BOTH metals when both endpoints respond', async () => {
    const ctx = loadApp({
      fetch: async (url) => {
        const u = String(url);
        if (u.includes('XAUTUSDT')) return { ok: true, json: async () => ({ lastPrice: '2412.50', priceChangePercent: '1.20' }) };
        if (u.includes('XAGUSDT'))  return { ok: true, json: async () => ({ lastPrice: '28.95',   priceChangePercent: '0.40' }) };
        return { ok: false };
      },
    });
    await ctx.app.fetchNonBinancePrices();
    const gold = [...ctx.app.ASSETS].find(a => a.symbol === 'GOLD');
    const silver = [...ctx.app.ASSETS].find(a => a.symbol === 'SILVER');
    assert.equal(gold.price, 2412.50);
    assert.equal(silver.price, 28.95);
  });

  test('US100 is never fetched (not in PRICE_PROXY_SYMBOLS)', async () => {
    let urls = [];
    const ctx = loadApp({
      fetch: async (url) => {
        urls.push(String(url));
        return { ok: false };
      },
    });
    await ctx.app.fetchNonBinancePrices();
    const us100Calls = urls.filter(u => /US100|NDX|US-100/i.test(u));
    assert.equal(us100Calls.length, 0, 'no US100/NDX request should ever go out');
  });

  test('all proxies fail → ASSETS unchanged, no crash', async () => {
    const ctx = loadApp({ fetch: async () => { throw new Error('network'); } });
    const before = {
      GOLD:   [...ctx.app.ASSETS].find(a => a.symbol === 'GOLD').price,
      SILVER: [...ctx.app.ASSETS].find(a => a.symbol === 'SILVER').price,
    };
    const updated = await ctx.app.fetchNonBinancePrices();
    assert.equal(updated, 0);
    assert.equal([...ctx.app.ASSETS].find(a => a.symbol === 'GOLD').price, before.GOLD);
    assert.equal([...ctx.app.ASSETS].find(a => a.symbol === 'SILVER').price, before.SILVER);
  });

  test('fallback host is tried when first host fails', async () => {
    let calls = [];
    const ctx = loadApp({
      fetch: async (url) => {
        calls.push(String(url));
        if (calls.length === 1) return { ok: false }; // first host bad
        if (String(url).includes('XAUTUSDT')) return { ok: true, json: async () => ({ lastPrice: '2412.50', priceChangePercent: '1' }) };
        return { ok: false };
      },
    });
    await ctx.app.fetchNonBinancePrices();
    // Should have hit the fallback host at least once for the GOLD proxy.
    const xautCalls = calls.filter(u => u.includes('XAUTUSDT'));
    assert.ok(xautCalls.length >= 2, `expected fallback to be tried, got ${xautCalls.length} XAUTUSDT calls`);
  });
});
