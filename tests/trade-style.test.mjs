import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadApp } from './harness.mjs';

// ─────────────────────────────────────────────────────────────────────
// compareTradeStyle — pulls closed positions from MEXC and joins them
// to the local journal of bot fires. These tests cover the pure pieces
// (classification + summary). The signed-HTTP fetch is exercised
// indirectly through fetchMexcPositionHistory's wire format below.
// ─────────────────────────────────────────────────────────────────────

describe('_classifyTradesAgainstJournal', () => {
  test('bot fire matched by symbol + ±10s openTime + price within 0.05%', () => {
    const { app } = loadApp();
    const t0 = Date.now();
    const positions = [
      { symbol: 'SILVER_USDT', openTime: t0,         openAvgPrice: 87.50, closeProfit: 0.18 },
      { symbol: 'SOL_USDT',    openTime: t0 + 5000,  openAvgPrice: 200.30, closeProfit: -0.42 },
      // Manual trade: same symbol, but no journal entry within window.
      { symbol: 'SILVER_USDT', openTime: t0 + 20000, openAvgPrice: 87.20, closeProfit: 0.05 },
    ];
    const journal = [
      { live: true, mexcResponse: { data: { orderId: 'A' } }, timestamp: t0 + 1000, symbol: 'SILVER', entry: 87.50 },
      { live: true, mexcResponse: { data: { orderId: 'B' } }, timestamp: t0 + 6000, symbol: 'SOL',    entry: 200.30 },
    ];
    const out = app._classifyTradesAgainstJournal(positions, journal);
    assert.equal(out.bot.length,    2, 'two trades match journal fires');
    assert.equal(out.manual.length, 1, 'one trade is manual (no journal match)');
    assert.equal(out.manual[0].symbol, 'SILVER_USDT');
  });

  test('journal fire outside ±10s window does NOT match', () => {
    const { app } = loadApp();
    const t0 = Date.now();
    const positions = [{ symbol: 'SILVER_USDT', openTime: t0, openAvgPrice: 87.50, closeProfit: 0.10 }];
    const journal   = [{ live: true, mexcResponse: { data: { orderId: 'X' } }, timestamp: t0 + 15000, symbol: 'SILVER', entry: 87.50 }];
    const out = app._classifyTradesAgainstJournal(positions, journal);
    assert.equal(out.bot.length, 0, 'time outside window → not a bot match');
    assert.equal(out.manual.length, 1);
  });

  test('price mismatch >0.05% does NOT match', () => {
    const { app } = loadApp();
    const t0 = Date.now();
    const positions = [{ symbol: 'SILVER_USDT', openTime: t0, openAvgPrice: 87.50, closeProfit: 0.10 }];
    // entry differs by 0.5% (well outside the 0.05% tolerance)
    const journal   = [{ live: true, mexcResponse: { data: { orderId: 'X' } }, timestamp: t0, symbol: 'SILVER', entry: 88.00 }];
    const out = app._classifyTradesAgainstJournal(positions, journal);
    assert.equal(out.bot.length, 0, 'price beyond tolerance → not a bot match');
    assert.equal(out.manual.length, 1);
  });

  test('journal entries without live:true or mexcResponse ignored', () => {
    const { app } = loadApp();
    const t0 = Date.now();
    const positions = [{ symbol: 'SILVER_USDT', openTime: t0, openAvgPrice: 87.50, closeProfit: 0.10 }];
    const journal = [
      { live: false, mexcResponse: { data: { orderId: 'A' } }, timestamp: t0, symbol: 'SILVER', entry: 87.50 },  // dry-run
      { live: true,  mexcResponse: null,                       timestamp: t0, symbol: 'SILVER', entry: 87.50 },  // failed
      { live: true,  mexcResponse: { data: { orderId: 'C' } }, timestamp: t0 - 500, symbol: 'GOLD', entry: 4000 },// wrong sym
    ];
    const out = app._classifyTradesAgainstJournal(positions, journal);
    assert.equal(out.bot.length, 0, 'no bot match — all journal entries disqualified or wrong sym');
    assert.equal(out.manual.length, 1);
  });

  test('one journal fire cannot match two positions (greedy first-match)', () => {
    const { app } = loadApp();
    const t0 = Date.now();
    const positions = [
      { symbol: 'SILVER_USDT', openTime: t0,        openAvgPrice: 87.50, closeProfit: 0.10 },
      { symbol: 'SILVER_USDT', openTime: t0 + 3000, openAvgPrice: 87.50, closeProfit: 0.10 },
    ];
    const journal   = [{ live: true, mexcResponse: { data: { orderId: 'X' } }, timestamp: t0, symbol: 'SILVER', entry: 87.50 }];
    const out = app._classifyTradesAgainstJournal(positions, journal);
    assert.equal(out.bot.length,    1, 'only first match consumes the journal fire');
    assert.equal(out.manual.length, 1, 'second position has no matching fire left');
  });

  test('empty inputs return empty bot/manual', () => {
    const { app } = loadApp();
    const out = app._classifyTradesAgainstJournal([], []);
    assert.equal(out.bot.length, 0);
    assert.equal(out.manual.length, 0);
    const out2 = app._classifyTradesAgainstJournal(null, null);
    assert.equal(out2.bot.length, 0);
    assert.equal(out2.manual.length, 0);
  });
});

describe('_summarizeTrades', () => {
  test('aggregate over wins, losses, fee, PnL', () => {
    const { app } = loadApp();
    const s = app._summarizeTrades([
      { closeProfit:  0.20, fee: 0.005 },
      { closeProfit: -0.15, fee: 0.004 },
      { closeProfit:  0.10, fee: 0.003 },
      { closeProfit:  0,    fee: 0.001 },  // break-even — not counted as win or loss
    ]);
    assert.equal(s.n, 4);
    assert.equal(s.wins, 2);
    assert.equal(s.losses, 1);
    assert.ok(Math.abs(s.winRate - 2/3) < 0.001, `winRate ≈ 0.667, got ${s.winRate}`);
    assert.ok(Math.abs(s.totalPnl - 0.15)  < 1e-9, `totalPnl 0.15, got ${s.totalPnl}`);
    assert.ok(Math.abs(s.totalFee - 0.013) < 1e-9, `totalFee 0.013, got ${s.totalFee}`);
    assert.ok(Math.abs(s.avgWin  - 0.15)   < 1e-9, `avgWin 0.15, got ${s.avgWin}`);
    assert.ok(Math.abs(s.avgLoss + 0.15)   < 1e-9, `avgLoss -0.15, got ${s.avgLoss}`);
  });

  test('empty input → zero stats', () => {
    const { app } = loadApp();
    const s = app._summarizeTrades([]);
    assert.equal(s.n, 0); assert.equal(s.wins, 0); assert.equal(s.losses, 0);
    assert.equal(s.winRate, 0); assert.equal(s.totalPnl, 0); assert.equal(s.avgPnl, 0);
  });
});

describe('fetchMexcPositionHistory — wire format', () => {
  test('signs request with sorted query params; hits the history endpoint', async () => {
    const calls = [];
    const ctx = loadApp({
      storage: {
        ict_mexc_api_key: 'k', ict_mexc_api_secret: 's',
        ict_mexc_worker_url: 'https://my.workers.dev',
        ict_live_trading_v2: JSON.stringify({ enabled: true, dryRun: false }),
      },
      fetch: async (url, init) => {
        calls.push({ url: String(url), init });
        return {
          ok: true, status: 200,
          text: async () => JSON.stringify({ success: true, code: 0, data: [
            { symbol: 'SILVER_USDT', positionType: 2, leverage: 200,
              openAvgPrice: 87.50, closeAvgPrice: 87.30, vol: 46,
              closeProfit: 0.18, fee: 0.005,
              openTime:  Date.now() - 60_000,
              closeTime: Date.now() - 30_000 },
          ] }),
        };
      },
    });
    ctx.app.loadLiveTradingState();
    const r = await ctx.app.fetchMexcPositionHistory({ days: 1, pageSize: 50 });
    assert.equal(r.ok, true);
    assert.equal(r.positions.length, 1);
    assert.equal(r.positions[0].symbol, 'SILVER_USDT');
    const hist = calls.find(c => c.url.includes('/position/list/history_positions'));
    assert.ok(hist, 'history endpoint must be hit');
    assert.match(hist.url, /page_num=1&page_size=50/, 'query params in URL');
    assert.match(hist.init.headers['Signature'], /^[0-9a-f]{64}$/);
    // Signature should cover the param string (sorted alphabetically by key).
    const expected = await ctx.app._signMexcRequest('k', 's', hist.init.headers['Request-Time'], 'page_num=1&page_size=50');
    assert.equal(hist.init.headers['Signature'], expected, 'signature must match HMAC of param string');
  });

  test('no keys → no-keys; no worker → no-worker', async () => {
    const { app } = loadApp();
    let r = await app.fetchMexcPositionHistory();
    assert.equal(r.error, 'no-keys');
    app.saveMexcKeys('k', 's');
    r = await app.fetchMexcPositionHistory();
    assert.equal(r.error, 'no-worker');
  });
});
