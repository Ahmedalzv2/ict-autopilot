import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadApp, gstDate } from './harness.mjs';

const OFF = gstDate(11, 30); // off-session so sessComp is 0 in confidence math

describe('scoreHeadlineSentiment — keyword polarity', () => {
  const { app } = loadApp();

  test('all bullish words → polarity +1', () => {
    const r = app.scoreHeadlineSentiment('Bitcoin ETF inflows surge to all-time high');
    assert.equal(r.bearish, 0);
    assert.ok(r.bullish >= 1);
    assert.equal(r.polarity, 1);
  });

  test('all bearish words → polarity -1', () => {
    const r = app.scoreHeadlineSentiment('Major exchange hacked, liquidation cascade incoming');
    assert.equal(r.bullish, 0);
    assert.ok(r.bearish >= 1);
    assert.equal(r.polarity, -1);
  });

  test('mixed → polarity between -1 and +1', () => {
    const r = app.scoreHeadlineSentiment('Bull rally crashes after lawsuit news');
    // 'rally' bullish, 'crashes' + 'lawsuit' bearish → 1 vs 2 → -1/3
    assert.ok(r.polarity > -1 && r.polarity < 1);
    assert.ok(r.polarity < 0);
  });

  test('no matches → polarity 0', () => {
    const r = app.scoreHeadlineSentiment('Quarterly developer update published');
    assert.equal(r.polarity, 0);
  });

  test('case-insensitive', () => {
    const a = app.scoreHeadlineSentiment('SURGE in inflows');
    const b = app.scoreHeadlineSentiment('surge in inflows');
    assert.equal(a.polarity, b.polarity);
  });

  test('empty string → polarity 0', () => {
    assert.equal(app.scoreHeadlineSentiment('').polarity, 0);
    assert.equal(app.scoreHeadlineSentiment(null).polarity, 0);
  });
});

describe('aggregateAssetSentiment — recency-weighted average', () => {
  const { app } = loadApp();

  test('empty list → score 0, count 0', () => {
    const a = app.aggregateAssetSentiment([], Date.now());
    assert.equal(a.score, 0);
    assert.equal(a.count, 0);
  });

  test('single fresh bullish headline → score ≈ +1', () => {
    const now = Date.now();
    const a = app.aggregateAssetSentiment([{ title: 'BTC rally and inflows', ts: now }], now);
    assert.equal(a.score, 1);
    assert.equal(a.count, 1);
  });

  test('headline older than 6h is excluded', () => {
    const now = Date.now();
    const a = app.aggregateAssetSentiment([
      { title: 'BTC rally', ts: now - 7 * 3600_000 }, // 7h old, dropped
    ], now);
    assert.equal(a.count, 0);
  });

  test('newer headlines weigh more than older', () => {
    const now = Date.now();
    // Fresh bullish + 4h-old bearish. Fresh weighs ~1.0, old weighs ~0.33.
    // Aggregate should still tilt bullish.
    const a = app.aggregateAssetSentiment([
      { title: 'BTC rally inflows', ts: now },
      { title: 'BTC crash dump', ts: now - 4 * 3600_000 },
    ], now);
    assert.ok(a.score > 0, `expected positive aggregate, got ${a.score}`);
  });

  test('count reflects ALL headlines within the window (not weight)', () => {
    const now = Date.now();
    const a = app.aggregateAssetSentiment([
      { title: 'a inflows', ts: now },
      { title: 'b inflows', ts: now - 2 * 3600_000 },
      { title: 'c inflows', ts: now - 5 * 3600_000 },
    ], now);
    assert.equal(a.count, 3);
  });
});

describe('getSentimentContext — bias-aligned grading', () => {
  const { app } = loadApp();

  test('bullish bias + bullish headlines → strong-confluence', () => {
    const now = Date.now();
    const ctx = app.getSentimentContext({ bias: 'BULLISH' }, [
      { title: 'BTC ETF surges to all-time high', ts: now },
      { title: 'inflows soar amid institutional adoption', ts: now },
    ], now);
    assert.equal(ctx.alignment, 'strong-confluence');
  });

  test('bullish bias + bearish headlines → strong-conflict', () => {
    const now = Date.now();
    const ctx = app.getSentimentContext({ bias: 'BULLISH' }, [
      { title: 'BTC crash, liquidation cascade', ts: now },
      { title: 'major exchange hacked', ts: now },
    ], now);
    assert.equal(ctx.alignment, 'strong-conflict');
  });

  test('bearish bias + bearish headlines → strong-confluence (short setup loves bearish news)', () => {
    const now = Date.now();
    const ctx = app.getSentimentContext({ bias: 'BEARISH' }, [
      { title: 'crash and dump dominate', ts: now },
      { title: 'sec sues exchange', ts: now },
    ], now);
    assert.equal(ctx.alignment, 'strong-confluence');
  });

  test('bearish bias + bullish headlines → strong-conflict', () => {
    const now = Date.now();
    const ctx = app.getSentimentContext({ bias: 'BEARISH' }, [
      { title: 'rally and surge with inflows', ts: now },
    ], now);
    assert.equal(ctx.alignment, 'strong-conflict');
  });

  test('mixed sentiment → neutral or weak', () => {
    const now = Date.now();
    const ctx = app.getSentimentContext({ bias: 'BULLISH' }, [
      { title: 'rally', ts: now },
      { title: 'dump', ts: now },
    ], now);
    // 50/50 split → near 0 score → neutral
    assert.ok(['neutral', 'weak-confluence', 'weak-conflict'].includes(ctx.alignment));
  });

  test('no headlines → alignment "none"', () => {
    const ctx = app.getSentimentContext({ bias: 'BULLISH' }, [], Date.now());
    assert.equal(ctx.alignment, 'none');
    assert.equal(ctx.count, 0);
  });
});

describe('getConfidencePct — sentiment integration (toggleable)', () => {
  function makeAsset(o = {}) {
    return {
      symbol: 'BTC', bias: 'BULLISH',
      entry: 100, sl: 99, tp: 105, tp1: 105, grade: 'a',
      price: 100, change24h: 0,
      checks: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0], reason: '',
      ...o,
    };
  }

  test('toggle ON + strong-confluence → +5 reflected in confidence', () => {
    const ctx = loadApp();
    ctx.app.mtfCache = { BTC: { h1: 'bull', h4: 'bull', d1: 'bull', ts: Date.now() } };
    ctx.app.assetNewsMap = { BTC: [{ title: 'BTC ETF inflows surge', ts: Date.now() }] };
    ctx.app.sentimentEnabled = true;
    const baseline = ctx.app.getConfidencePct(makeAsset(), OFF);

    ctx.app.assetNewsMap = {}; // remove sentiment
    const without = ctx.app.getConfidencePct(makeAsset(), OFF);

    assert.ok(baseline > without, `with sentiment ${baseline} should beat without ${without}`);
    assert.equal(baseline - without, 5, 'strong-confluence adds exactly 5');
  });

  test('toggle ON + strong-conflict → -5', () => {
    const ctx = loadApp();
    ctx.app.mtfCache = { BTC: { h1: 'bull', h4: 'bull', d1: 'bull', ts: Date.now() } };
    ctx.app.sentimentEnabled = true;
    ctx.app.assetNewsMap = {};
    const without = ctx.app.getConfidencePct(makeAsset(), OFF);

    ctx.app.assetNewsMap = { BTC: [
      { title: 'BTC crash and liquidation', ts: Date.now() },
      { title: 'exchange hacked', ts: Date.now() },
    ]};
    const withConflict = ctx.app.getConfidencePct(makeAsset(), OFF);

    assert.equal(without - withConflict, 5, 'strong-conflict subtracts exactly 5');
  });

  test('toggle OFF → sentiment makes no contribution', () => {
    const ctx = loadApp();
    ctx.app.mtfCache = { BTC: { h1: 'bull', h4: 'bull', d1: 'bull', ts: Date.now() } };
    ctx.app.sentimentEnabled = false;
    ctx.app.assetNewsMap = {};
    const without = ctx.app.getConfidencePct(makeAsset(), OFF);

    ctx.app.assetNewsMap = { BTC: [{ title: 'BTC ETF inflows surge', ts: Date.now() }] };
    const withSent = ctx.app.getConfidencePct(makeAsset(), OFF);

    assert.equal(without, withSent, 'OFF means zero impact regardless of headlines');
  });

  test('sentiment never gates — wrong-direction sentiment shifts confidence but NOT signal state', () => {
    // Confluence/conflict only adjusts the percentage; signal ladder is
    // unchanged. This test confirms getSignal output is the same with
    // sentiment ON regardless of whether headlines align.
    const ctx = loadApp();
    ctx.app.mtfCache  = { BTC: { h1: 'bull', h4: 'bull', d1: 'bull', ts: Date.now() } };
    ctx.app.chochCache = { BTC: { detected: true, direction: 'bull', breakPrice: 100.5, swingPrice: 100, ts: Date.now() } };
    ctx.app.sentimentEnabled = true;
    const a = makeAsset({
      price: 100.10, // armed zone
      checks: [1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
    });
    // With supportive sentiment
    ctx.app.assetNewsMap = { BTC: [{ title: 'BTC rally inflows', ts: Date.now() }] };
    const sigA = ctx.app.getSignal(a, gstDate(9, 0));
    // With opposing sentiment
    ctx.app.assetNewsMap = { BTC: [{ title: 'BTC crash dump', ts: Date.now() }] };
    const sigB = ctx.app.getSignal(a, gstDate(9, 0));
    assert.equal(sigA, sigB, 'sentiment must not change which signal fires');
  });
});

describe('analyzeAsset — sentiment narrative line', () => {
  test('confluent sentiment surfaces with green icon', () => {
    const ctx = loadApp();
    ctx.app.mtfCache  = { BTC: { h1: 'bull', h4: 'bull', d1: 'bull', ts: Date.now() } };
    ctx.app.assetNewsMap = { BTC: [
      { title: 'BTC rally inflows surge', ts: Date.now() },
      { title: 'institutional adoption', ts: Date.now() },
    ]};
    ctx.app.sentimentEnabled = true;
    const a = {
      symbol: 'BTC', bias: 'BULLISH',
      entry: 100, sl: 99, tp: 105, tp1: 105, grade: 'a',
      price: 100.4, change24h: 0,
      checks: [1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
    };
    const text = ctx.app.analyzeAsset(a, gstDate(9, 0));
    assert.match(text, /🟢 Sentiment/);
    assert.match(text, /align/);
  });

  test('conflict surfaces with red icon', () => {
    const ctx = loadApp();
    ctx.app.mtfCache  = { BTC: { h1: 'bull', h4: 'bull', d1: 'bull', ts: Date.now() } };
    ctx.app.assetNewsMap = { BTC: [
      { title: 'BTC crash and dump', ts: Date.now() },
      { title: 'liquidation cascade', ts: Date.now() },
    ]};
    ctx.app.sentimentEnabled = true;
    const a = {
      symbol: 'BTC', bias: 'BULLISH',
      entry: 100, sl: 99, tp: 105, tp1: 105, grade: 'a',
      price: 100.4, change24h: 0,
      checks: [1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
    };
    const text = ctx.app.analyzeAsset(a, gstDate(9, 0));
    assert.match(text, /🔴 Sentiment/);
    assert.match(text, /push against|opposes/);
  });

  test('toggle OFF still SHOWS the sentiment line but tags it informational', () => {
    const ctx = loadApp();
    ctx.app.mtfCache  = { BTC: { h1: 'bull', h4: 'bull', d1: 'bull', ts: Date.now() } };
    ctx.app.assetNewsMap = { BTC: [
      { title: 'BTC rally inflows surge', ts: Date.now() },
    ]};
    ctx.app.sentimentEnabled = false;
    const a = {
      symbol: 'BTC', bias: 'BULLISH',
      entry: 100, sl: 99, tp: 105, tp1: 105, grade: 'a',
      price: 100.4, change24h: 0,
      checks: [1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
    };
    const text = ctx.app.analyzeAsset(a, gstDate(9, 0));
    assert.match(text, /sentiment toggle OFF/);
  });
});
