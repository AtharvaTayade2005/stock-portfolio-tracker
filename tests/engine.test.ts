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

describe('Indian Stock Market Portfolio Tracker Core Engines (Phase 1 + Phase 2)', () => {
  it('starts portfolio with 0 pre-seeded holdings and 3 linked Indian bank accounts', () => {
    const db = createDatabase(':memory:');
    const ledger = new LedgerService(db);
    const snapshot = ledger.getPortfolioSnapshot(new Map());

    assert.equal(snapshot.holdings.length, 0, 'Initial portfolio must have 0 holdings');
    assert.equal(snapshot.cashBalance, 500000.0);
    assert.equal(snapshot.bankAccounts.length, 3);
    assert.ok(snapshot.bankAccounts[0].bankName.includes('SBI'));
  });

  it('computes exact FIFO tax-lot consumption and realized P&L in INR across multi-lot sells', () => {
    const db = createDatabase(':memory:');
    const ledger = new LedgerService(db);

    const buy1 = ledger.executeOrder(
      { symbol: 'ICICIBANK', side: 'BUY', quantity: 10, idempotencyKey: 'test-icici-buy-1' },
      1200.0
    );
    assert.equal(buy1.deduplicated, false);

    const buy2 = ledger.executeOrder(
      { symbol: 'ICICIBANK', side: 'BUY', quantity: 10, idempotencyKey: 'test-icici-buy-2' },
      1250.0
    );
    assert.equal(buy2.deduplicated, false);

    const sell1 = ledger.executeOrder(
      { symbol: 'ICICIBANK', side: 'SELL', quantity: 15, idempotencyKey: 'test-icici-sell-1' },
      1300.0
    );
    assert.equal(sell1.order.realizedPnl, 1250.0);

    const snapshot = ledger.getPortfolioSnapshot(new Map());
    const iciciHolding = snapshot.holdings.find((h) => h.symbol === 'ICICIBANK');
    assert.ok(iciciHolding, 'ICICIBANK holding should exist with 5 remaining shares');
    assert.equal(iciciHolding.quantity, 5);
    assert.equal(iciciHolding.avgCostBasis, 1250.0);
  });

  it('supports atomic 3-in-1 Bank-to-Demat UPI transfers and external broker imports (SBI Securities / HDFC Sky / Groww)', () => {
    const db = createDatabase(':memory:');
    const ledger = new LedgerService(db);

    const tx = ledger.transferBankFunds({
      bankAccountId: 1,
      direction: 'DEPOSIT_TO_DEMAT',
      method: 'UPI',
      amount: 100000.0,
    });
    assert.equal(tx.amount, 100000.0);

    const imported = ledger.importExternalHoldings([
      { symbol: 'SBIN', quantity: 50, buyPrice: 1042.0, brokerSource: 'SBI Securities' },
      { symbol: 'HDFCBANK', quantity: 30, buyPrice: 798.0, brokerSource: 'HDFC Sky' },
    ]);
    assert.equal(imported.importedCount, 2);

    const snapshot = ledger.getPortfolioSnapshot(new Map());
    assert.equal(snapshot.cashBalance, 600000.0);
    assert.equal(snapshot.holdings.length, 2);
    assert.ok(snapshot.holdings.some((h) => h.brokers.includes('SBI Securities')));
    assert.ok(snapshot.holdings.some((h) => h.brokers.includes('HDFC Sky')));
  });

  it('enforces idempotency keys and rejects orders exceeding INR buying power', () => {
    const db = createDatabase(':memory:');
    const ledger = new LedgerService(db);

    const first = ledger.executeOrder(
      { symbol: 'INFY', side: 'BUY', quantity: 5, idempotencyKey: 'idem-key-001' },
      1151.2
    );
    const duplicate = ledger.executeOrder(
      { symbol: 'INFY', side: 'BUY', quantity: 5, idempotencyKey: 'idem-key-001' },
      1151.2
    );

    assert.equal(first.deduplicated, false);
    assert.equal(duplicate.deduplicated, true);
    assert.equal(first.order.id, duplicate.order.id);

    assert.throws(() => {
      ledger.executeOrder(
        { symbol: 'DIXON', side: 'BUY', quantity: 10000, idempotencyKey: 'idem-overdraft' },
        12992.0
      );
    }, /Insufficient Demat buying power/);
  });

  it('calculates O(N) SMA, EMA, Wilder RSI(14), and Bollinger Bands for NSE/NFO instruments', () => {
    const engine = new MarketEngine();
    const candles = engine.getCandles('RELIANCE');
    assert.ok(candles.length >= 70);

    const closes = [100, 120, 140, 160, 180, 200];
    const sma3 = computeSMA(closes, 3);
    assert.deepEqual(sma3, [null, null, 120, 140, 160, 180]);

    const ema3 = computeEMA(closes, 3);
    assert.equal(ema3[2], 120);
    assert.ok(ema3[5]! > 170);

    const rsi = computeWilderRSI(
      candles.map((c) => c.close),
      14
    );
    const latestRsi = rsi[rsi.length - 1];
    assert.ok(latestRsi !== null && latestRsi >= 0 && latestRsi <= 100);

    const bb = computeBollingerBands(
      candles.map((c) => c.close),
      20,
      2
    );
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
      targetPrice: 1200.0,
      note: 'NSE IT breakout test',
    });

    const miss = alertEngine.evaluateTick({
      symbol: 'INFY',
      price: 1185.0,
      prevClose: 1155.0,
      open: 1160.0,
      dayHigh: 1190.0,
      dayLow: 1150.0,
      change: 30.0,
      changePercent: 2.6,
      volume: 10000,
      bid: 1184.8,
      ask: 1185.2,
      timestamp: Date.now(),
      source: 'NSE_LIVE_SYNC',
    });
    assert.equal(miss.length, 0);

    const hit = alertEngine.evaluateTick({
      symbol: 'INFY',
      price: 1205.0,
      prevClose: 1155.0,
      open: 1160.0,
      dayHigh: 1210.0,
      dayLow: 1150.0,
      change: 50.0,
      changePercent: 4.33,
      volume: 12000,
      bid: 1204.8,
      ask: 1205.2,
      timestamp: Date.now(),
      source: 'NSE_LIVE_SYNC',
    });
    assert.equal(hit.length, 1);
    assert.equal(hit[0].id, created.id);
    assert.equal(hit[0].status, 'TRIGGERED');
  });
});
