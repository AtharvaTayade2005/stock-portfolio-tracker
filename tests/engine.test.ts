import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createDatabase } from '../src/server/db.js';
import { LedgerService } from '../src/server/ledgerService.js';
import { AlertEngine } from '../src/server/alertEngine.js';
import {
  computeAllIndicators,
  computeBollingerBands,
  computeEMA,
  computeSMA,
  computeWilderRSI,
} from '../src/shared/indicators.js';
import { MarketEngine } from '../src/server/marketEngine.js';

describe('Indian Stock Market Portfolio Tracker Core Engines (NSE/BSE/NFO/ETF/MF)', () => {
  it('computes exact FIFO tax-lot consumption and realized P&L in INR across multi-lot sells', () => {
    const db = createDatabase(':memory:');
    const ledger = new LedgerService(db);

    // Buy Lot 1 of ICICIBANK: 10 shares @ ₹1,200.00 (₹12,000)
    const buy1 = ledger.executeOrder(
      { symbol: 'ICICIBANK', side: 'BUY', quantity: 10, idempotencyKey: 'test-icici-buy-1' },
      1200.0
    );
    assert.equal(buy1.deduplicated, false);

    // Buy Lot 2 of ICICIBANK: 10 shares @ ₹1,250.00 (₹12,500)
    const buy2 = ledger.executeOrder(
      { symbol: 'ICICIBANK', side: 'BUY', quantity: 10, idempotencyKey: 'test-icici-buy-2' },
      1250.0
    );
    assert.equal(buy2.deduplicated, false);

    // Sell 15 shares of ICICIBANK @ ₹1,300.00
    // FIFO must consume 10 shares from Lot 1 ((1300 - 1200)*10 = +₹1,000)
    // and 5 shares from Lot 2 ((1300 - 1250)*5 = +₹250) -> Total Realized P&L = +₹1,250.00
    const sell1 = ledger.executeOrder(
      { symbol: 'ICICIBANK', side: 'SELL', quantity: 15, idempotencyKey: 'test-icici-sell-1' },
      1300.0
    );
    assert.equal(sell1.order.realizedPnl, 1250.0);

    const snapshot = ledger.getPortfolioSnapshot(new Map());
    const iciciHolding = snapshot.holdings.find((h) => h.symbol === 'ICICIBANK');
    assert.ok(iciciHolding, 'ICICIBANK holding should still exist with 5 remaining shares');
    assert.equal(iciciHolding.quantity, 5);
    assert.equal(iciciHolding.avgCostBasis, 1250.0);
  });

  it('enforces idempotency keys and rejects orders exceeding INR buying power', () => {
    const db = createDatabase(':memory:');
    const ledger = new LedgerService(db);

    const first = ledger.executeOrder(
      { symbol: 'INFY', side: 'BUY', quantity: 5, idempotencyKey: 'idem-key-001' },
      1850.0
    );
    const duplicate = ledger.executeOrder(
      { symbol: 'INFY', side: 'BUY', quantity: 5, idempotencyKey: 'idem-key-001' },
      1850.0
    );

    assert.equal(first.deduplicated, false);
    assert.equal(duplicate.deduplicated, true);
    assert.equal(first.order.id, duplicate.order.id);

    assert.throws(() => {
      ledger.executeOrder(
        { symbol: 'DIXON', side: 'BUY', quantity: 10000, idempotencyKey: 'idem-overdraft' },
        15420.0
      );
    }, /Insufficient buying power/);
  });

  it('calculates O(N) SMA, EMA, Wilder RSI(14), and Bollinger Bands for NSE/NFO instruments', () => {
    const engine = new MarketEngine();
    const candles = engine.getCandles('RELIANCE');
    assert.ok(candles.length >= 100);

    const closes = [100, 120, 140, 160, 180, 200];
    const sma3 = computeSMA(closes, 3);
    assert.deepEqual(sma3, [null, null, 120, 140, 160, 180]);

    const ema3 = computeEMA(closes, 3);
    assert.equal(ema3[2], 120);
    assert.ok(ema3[5]! > 170);

    const rsi = computeWilderRSI(candles.map((c) => c.close), 14);
    const latestRsi = rsi[rsi.length - 1];
    assert.ok(latestRsi !== null && latestRsi >= 0 && latestRsi <= 100);

    const bb = computeBollingerBands(candles.map((c) => c.close), 20, 2);
    const lastIdx = candles.length - 1;
    assert.ok(bb.upper[lastIdx]! > bb.middle[lastIdx]!);
    assert.ok(bb.middle[lastIdx]! > bb.lower[lastIdx]!);

    const summary = computeAllIndicators('RELIANCE', candles);
    assert.equal(summary.symbol, 'RELIANCE');
    assert.equal(summary.points.length, candles.length);
  });

  it('evaluates INR price alerts in O(1) symbol bucket lookup time', () => {
    const db = createDatabase(':memory:');
    const alertEngine = new AlertEngine(db);

    const created = alertEngine.createAlert({
      symbol: 'INFY',
      direction: 'ABOVE',
      targetPrice: 1900.0,
      note: 'NSE IT breakout test',
    });

    const miss = alertEngine.evaluateTick({
      symbol: 'INFY',
      price: 1885.0,
      prevClose: 1868.4,
      change: 16.6,
      changePercent: 0.89,
      volume: 10000,
      bid: 1884.8,
      ask: 1885.2,
      timestamp: Date.now(),
      source: 'REPLAY',
    });
    assert.equal(miss.length, 0);

    const hit = alertEngine.evaluateTick({
      symbol: 'INFY',
      price: 1905.0,
      prevClose: 1868.4,
      change: 36.6,
      changePercent: 1.96,
      volume: 12000,
      bid: 1904.8,
      ask: 1905.2,
      timestamp: Date.now(),
      source: 'REPLAY',
    });
    assert.equal(hit.length, 1);
    assert.equal(hit[0].id, created.id);
    assert.equal(hit[0].status, 'TRIGGERED');
  });
});
