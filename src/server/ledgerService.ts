import type { DatabaseSync } from 'node:sqlite';
import { formatINR, SEGMENT_LABELS, SYMBOL_MAP } from '../shared/catalog.js';
import type {
  HoldingPosition,
  InstrumentSegment,
  MarketTick,
  OrderRecord,
  OrderRequest,
  PortfolioSnapshot,
  SectorAllocation,
  SegmentAllocation,
} from '../shared/types.js';

interface RawOrderRow {
  id: number;
  idempotency_key: string;
  symbol: string;
  side: 'BUY' | 'SELL';
  quantity: number;
  execution_price: number;
  total_notional: number;
  realized_pnl: number;
  created_at: string;
}

interface RawTaxLotRow {
  id: number;
  symbol: string;
  initial_qty: number;
  remaining_qty: number;
  buy_price: number;
  acquired_at: string;
}

export class LedgerService {
  constructor(private readonly db: DatabaseSync) {}

  /**
   * Executes a BUY or SELL market order inside a write-locked ACID transaction (BEGIN IMMEDIATE).
   * Enforces idempotency via `idempotency_key` and computes exact FIFO realized P&L on SELL orders.
   */
  public executeOrder(
    req: OrderRequest,
    executionPrice: number
  ): { order: OrderRecord; deduplicated: boolean } {
    const meta = SYMBOL_MAP.get(req.symbol);
    if (!req.symbol || !meta) {
      throw new Error(`Unsupported symbol: ${req.symbol}`);
    }
    if (!Number.isFinite(req.quantity) || req.quantity <= 0) {
      throw new Error('Order quantity must be a positive number.');
    }
    if (!Number.isFinite(executionPrice) || executionPrice <= 0) {
      throw new Error('Invalid market execution price.');
    }
    if (!req.idempotencyKey || req.idempotencyKey.trim().length < 4) {
      throw new Error('A valid idempotencyKey is required to prevent duplicate order execution.');
    }

    const cleanKey = req.idempotencyKey.trim();

    this.db.exec('BEGIN IMMEDIATE');
    try {
      const existingOrder = this.db
        .prepare('SELECT * FROM orders WHERE idempotency_key = ?')
        .get(cleanKey) as RawOrderRow | undefined;

      if (existingOrder) {
        this.db.exec('COMMIT');
        return {
          order: this.mapOrderRow(existingOrder),
          deduplicated: true,
        };
      }

      const account = this.db
        .prepare('SELECT cash_balance, realized_pnl FROM accounts WHERE id = 1')
        .get() as { cash_balance: number; realized_pnl: number } | undefined;

      if (!account) {
        throw new Error('Trading account not initialized.');
      }

      const now = new Date().toISOString();
      const totalNotional = Number((req.quantity * executionPrice).toFixed(2));
      let orderRealizedPnl = 0;

      if (req.side === 'BUY') {
        if (account.cash_balance + 1e-6 < totalNotional) {
          throw new Error(
            `Insufficient buying power: required ${formatINR(totalNotional)}, available ${formatINR(
              account.cash_balance
            )}.`
          );
        }

        const newCash = Number(Math.max(0, account.cash_balance - totalNotional).toFixed(2));
        this.db
          .prepare('UPDATE accounts SET cash_balance = ?, updated_at = ? WHERE id = 1')
          .run(newCash, now);

        this.db
          .prepare(
            `INSERT INTO tax_lots (symbol, initial_qty, remaining_qty, buy_price, acquired_at)
             VALUES (?, ?, ?, ?, ?)`
          )
          .run(req.symbol, req.quantity, req.quantity, executionPrice, now);
      } else {
        // SELL: Consume open tax lots in strict FIFO order (oldest acquired_at first)
        const openLots = this.db
          .prepare(
            `SELECT id, symbol, initial_qty, remaining_qty, buy_price, acquired_at
             FROM tax_lots
             WHERE symbol = ? AND remaining_qty > 0
             ORDER BY acquired_at ASC, id ASC`
          )
          .all(req.symbol) as unknown as RawTaxLotRow[];

        const totalAvailableQty = openLots.reduce((sum, lot) => sum + lot.remaining_qty, 0);
        if (totalAvailableQty + 1e-6 < req.quantity) {
          throw new Error(
            `Insufficient units to sell ${req.symbol}: requested ${req.quantity}, held ${Number(
              totalAvailableQty.toFixed(4)
            )}.`
          );
        }

        let remainingToSell = req.quantity;
        const updateLotStmt = this.db.prepare('UPDATE tax_lots SET remaining_qty = ? WHERE id = ?');

        for (const lot of openLots) {
          if (remainingToSell <= 1e-8) break;
          const consumedQty = Math.min(lot.remaining_qty, remainingToSell);
          const newRemaining = Number(Math.max(0, lot.remaining_qty - consumedQty).toFixed(6));

          orderRealizedPnl += (executionPrice - lot.buy_price) * consumedQty;
          remainingToSell = Number((remainingToSell - consumedQty).toFixed(6));

          updateLotStmt.run(newRemaining, lot.id);
        }

        orderRealizedPnl = Number(orderRealizedPnl.toFixed(2));
        const newCash = Number((account.cash_balance + totalNotional).toFixed(2));
        const newRealizedPnl = Number((account.realized_pnl + orderRealizedPnl).toFixed(2));

        this.db
          .prepare('UPDATE accounts SET cash_balance = ?, realized_pnl = ?, updated_at = ? WHERE id = 1')
          .run(newCash, newRealizedPnl, now);
      }

      const insertResult = this.db
        .prepare(
          `INSERT INTO orders (idempotency_key, symbol, side, quantity, execution_price, total_notional, realized_pnl, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          cleanKey,
          req.symbol,
          req.side,
          req.quantity,
          executionPrice,
          totalNotional,
          orderRealizedPnl,
          now
        );

      const createdOrderRow = this.db
        .prepare('SELECT * FROM orders WHERE id = ?')
        .get(Number(insertResult.lastInsertRowid)) as unknown as RawOrderRow;

      this.db.exec('COMMIT');
      return {
        order: this.mapOrderRow(createdOrderRow),
        deduplicated: false,
      };
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  /**
   * Computes a complete real-time portfolio valuation snapshot grounded in open FIFO tax lots.
   */
  public getPortfolioSnapshot(latestTicks: Map<string, MarketTick>): PortfolioSnapshot {
    const account = this.db
      .prepare('SELECT cash_balance, realized_pnl FROM accounts WHERE id = 1')
      .get() as { cash_balance: number; realized_pnl: number };

    const openLotRows = this.db
      .prepare(
        `SELECT id, symbol, initial_qty, remaining_qty, buy_price, acquired_at
         FROM tax_lots
         WHERE remaining_qty > 0
         ORDER BY acquired_at ASC, id ASC`
      )
      .all() as unknown as RawTaxLotRow[];

    const recentOrderRows = this.db
      .prepare('SELECT * FROM orders ORDER BY id DESC LIMIT 40')
      .all() as unknown as RawOrderRow[];

    const groupedBySymbol = new Map<string, RawTaxLotRow[]>();
    for (const lot of openLotRows) {
      const list = groupedBySymbol.get(lot.symbol) ?? [];
      list.push(lot);
      groupedBySymbol.set(lot.symbol, list);
    }

    const holdings: HoldingPosition[] = [];
    let holdingsMarketValue = 0;
    let totalCostBasis = 0;

    for (const [symbol, lots] of groupedBySymbol.entries()) {
      const meta = SYMBOL_MAP.get(symbol);
      if (!meta) continue;

      const tick = latestTicks.get(symbol);
      const currentPrice = tick ? tick.price : meta.basePrice;
      const dayChangePercent = tick ? tick.changePercent : 0;

      let totalQty = 0;
      let totalCost = 0;
      for (const lot of lots) {
        totalQty += lot.remaining_qty;
        totalCost += lot.remaining_qty * lot.buy_price;
      }

      totalQty = Number(totalQty.toFixed(4));
      totalCost = Number(totalCost.toFixed(2));
      const avgCostBasis = totalQty > 0 ? Number((totalCost / totalQty).toFixed(2)) : 0;
      const marketValue = Number((totalQty * currentPrice).toFixed(2));
      const unrealizedPnl = Number((marketValue - totalCost).toFixed(2));
      const unrealizedPnlPercent =
        totalCost > 0 ? Number(((unrealizedPnl / totalCost) * 100).toFixed(2)) : 0;

      holdingsMarketValue += marketValue;
      totalCostBasis += totalCost;

      holdings.push({
        symbol,
        name: meta.name,
        segment: meta.segment,
        sector: meta.sector,
        exchange: meta.exchange,
        lotSize: meta.lotSize,
        beta: meta.beta,
        quantity: totalQty,
        avgCostBasis,
        currentPrice,
        marketValue,
        totalCost,
        unrealizedPnl,
        unrealizedPnlPercent,
        dayChangePercent,
        weightPercent: 0,
        openLotsCount: lots.length,
      });
    }

    holdingsMarketValue = Number(holdingsMarketValue.toFixed(2));
    totalCostBasis = Number(totalCostBasis.toFixed(2));
    const totalEquity = Number((account.cash_balance + holdingsMarketValue).toFixed(2));
    const totalUnrealizedPnl = Number((holdingsMarketValue - totalCostBasis).toFixed(2));
    const totalUnrealizedPnlPercent =
      totalCostBasis > 0 ? Number(((totalUnrealizedPnl / totalCostBasis) * 100).toFixed(2)) : 0;

    let weightedBetaSum = 0;
    const sectorTotals = new Map<string, number>();
    const segmentMap = new Map<InstrumentSegment, { mv: number; pnl: number }>();

    for (const h of holdings) {
      h.weightPercent =
        holdingsMarketValue > 0 ? Number(((h.marketValue / holdingsMarketValue) * 100).toFixed(2)) : 0;
      weightedBetaSum += (h.weightPercent / 100) * h.beta;
      sectorTotals.set(h.sector, (sectorTotals.get(h.sector) ?? 0) + h.marketValue);

      const segEntry = segmentMap.get(h.segment) ?? { mv: 0, pnl: 0 };
      segEntry.mv += h.marketValue;
      segEntry.pnl += h.unrealizedPnl;
      segmentMap.set(h.segment, segEntry);
    }

    holdings.sort((a, b) => b.marketValue - a.marketValue);

    const sectorAllocations: SectorAllocation[] = Array.from(sectorTotals.entries())
      .map(([sector, marketValue]) => ({
        sector,
        marketValue: Number(marketValue.toFixed(2)),
        weightPercent:
          holdingsMarketValue > 0 ? Number(((marketValue / holdingsMarketValue) * 100).toFixed(2)) : 0,
      }))
      .sort((a, b) => b.marketValue - a.marketValue);

    const segmentAllocations: SegmentAllocation[] = Array.from(segmentMap.entries())
      .map(([segment, val]) => ({
        segment,
        label: SEGMENT_LABELS[segment],
        marketValue: Number(val.mv.toFixed(2)),
        unrealizedPnl: Number(val.pnl.toFixed(2)),
        weightPercent:
          holdingsMarketValue > 0 ? Number(((val.mv / holdingsMarketValue) * 100).toFixed(2)) : 0,
      }))
      .sort((a, b) => b.marketValue - a.marketValue);

    return {
      cashBalance: Number(account.cash_balance.toFixed(2)),
      holdingsMarketValue,
      totalEquity,
      totalCostBasis,
      totalUnrealizedPnl,
      totalUnrealizedPnlPercent,
      totalRealizedPnl: Number(account.realized_pnl.toFixed(2)),
      portfolioBeta: Number(weightedBetaSum.toFixed(2)),
      holdings,
      sectorAllocations,
      segmentAllocations,
      recentOrders: recentOrderRows.map((r) => this.mapOrderRow(r)),
      openTaxLots: openLotRows.map((l) => ({
        id: l.id,
        symbol: l.symbol,
        initialQty: l.initial_qty,
        remainingQty: l.remaining_qty,
        buyPrice: l.buy_price,
        acquiredAt: l.acquired_at,
      })),
    };
  }

  private mapOrderRow(row: RawOrderRow): OrderRecord {
    return {
      id: row.id,
      idempotencyKey: row.idempotency_key,
      symbol: row.symbol,
      side: row.side,
      quantity: row.quantity,
      executionPrice: row.execution_price,
      totalNotional: row.total_notional,
      realizedPnl: row.realized_pnl,
      createdAt: row.created_at,
    };
  }
}
