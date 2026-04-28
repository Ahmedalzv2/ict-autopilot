import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadApp, gstDate } from './harness.mjs';

describe('tagHeadline (asset extraction from news titles)', () => {
  const cases = [
    ['Bitcoin ETF flows hit a record high', ['BTC']],
    ['BTC breaks $80K resistance', ['BTC']],
    ['Ether falls 5% after L2 outage', ['ETH']],
    ['Solana DEX volume surges',           ['SOL']],
    ['BNB and XRP both rally',             ['BNB', 'XRP']],
    ['Fed announces rate decision',        []],
    ['',                                   []],
    ['Gold bullion at all-time highs',     ['GOLD']],
    ['Silver pulls back from XAG resistance', ['SILVER']],
    ['Nasdaq tumbles on tech selloff',     ['US100']],
  ];

  for (const [title, expected] of cases) {
    test(`"${title || '(empty)'}" → [${expected.join(', ')}]`, () => {
      const { app } = loadApp();
      const tagged = [...app.tagHeadline(title)].sort();
      assert.deepEqual(tagged, [...expected].sort());
    });
  }

  test('case-insensitive matching', () => {
    const { app } = loadApp();
    assert.deepEqual([...app.tagHeadline('BITCOIN ETF')], ['BTC']);
    assert.deepEqual([...app.tagHeadline('bitcoin etf')], ['BTC']);
    assert.deepEqual([...app.tagHeadline('BiTcoiN etf')], ['BTC']);
  });
});

describe('getNewsContext + analyzeAsset integration', () => {
  test('returns the most recent tagged headline for the asset', () => {
    const { app } = loadApp();
    app.assetNewsMap = {
      BTC: [
        { title: 'BTC breaks 80K', source: 'CoinDesk', url: '#', ts: 1000 },
        { title: 'older headline', source: 'X', url: '#', ts: 500 },
      ],
    };
    const ctx = [...app.getNewsContext('BTC')];
    assert.equal(ctx.length, 1);
    assert.equal(ctx[0].title, 'BTC breaks 80K');
  });

  test('returns empty array when no news for symbol', () => {
    const { app } = loadApp();
    app.assetNewsMap = {};
    assert.deepEqual([...app.getNewsContext('BTC')], []);
  });

  test('analyzeAsset includes the headline when news exists', () => {
    const { app } = loadApp();
    app.mtfCache = { BTC: { h1: 'bull', h4: 'bull', d1: 'bull' } };
    app.assetNewsMap = {
      BTC: [{ title: 'Bitcoin spot ETF inflows hit record', source: 'CoinDesk', url: '#', ts: Date.now() }],
    };
    const asset = {
      symbol: 'BTC', bias: 'BULLISH',
      entry: 100, sl: 99, tp: 105, tp1: 105, grade: 'a',
      price: 100.4, change24h: 0,
      checks: [1, 1, 1, 1, 1, 1, 1, 1, 1, 1], reason: '',
    };
    const text = app.analyzeAsset(asset, gstDate(9, 0));
    assert.match(text, /📰 Recent: "Bitcoin spot ETF inflows hit record"/);
    assert.match(text, /CoinDesk/);
  });

  test('analyzeAsset omits the news line when no headline tagged', () => {
    const { app } = loadApp();
    app.mtfCache = { BTC: { h1: 'bull', h4: 'bull', d1: 'bull' } };
    app.assetNewsMap = {};
    const asset = {
      symbol: 'BTC', bias: 'BULLISH',
      entry: 100, sl: 99, tp: 105, tp1: 105, grade: 'a',
      price: 100.4, change24h: 0,
      checks: [1, 1, 1, 1, 1, 1, 1, 1, 1, 1], reason: '',
    };
    const text = app.analyzeAsset(asset, gstDate(9, 0));
    assert.doesNotMatch(text, /📰/);
  });
});
