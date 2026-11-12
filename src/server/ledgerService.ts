import type { DatabaseSync } from 'node:sqlite';
import { formatINR, SEGMENT_LABELS, SYMBOL_MAP } from '../shared/catalog.js';
import type {
  BankAccount,
  BankTransaction,
  BrokerSource,
  ExternalHoldingImportItem,
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
  broker_source?: BrokerSource;
  created_at: string;
}

interface RawTaxLotRow {
  id: number;
  symbol: string;
  initial_qty: number;
  remaining_qty: number;
  buy_price: number;
  broker_source?: BrokerSource;
  acquired_at: string;
}

interface RawBankRow {
  id: number;
  bank_name: string;
  account_number_masked: string;
  ifsc_code: string;
  upi_id: string;
  balance: number;
  is_primary: number;
}

interface RawBankTxRow {
  id: number;
  bank_account_id: number;
  bank_name: string;
  type: BankTransaction['type'];
  method: BankTransaction['method'];
  amount: number;
  reference_note: string;
  created_at: string;
}

export class LedgerService {
  constructor(private readonly db: DatabaseSync) {}

  /**
   * Executes a BUY or SELL market order inside a write-locked ACID transaction (BEGIN IMMEDIATE).
   * Supports 3-in-1 Bank Auto-Sweep (like SBI Securities / HDFC Sky) when `useThreeInOneBankId` is provided.
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
    const brokerSource: BrokerSource = req.brokerSource || 'KitePulse Direct';

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
        let currentCash = account.cash_balance;

        // 3-in-1 Bank-to-Demat Auto-Debit if requested or if Demat balance is short and a 3-in-1 bank is selected
        if (req.useThreeInOneBankId) {
          const bank = this.db
            .prepare('SELECT * FROM bank_accounts WHERE id = ?')
            .get(req.useThreeInOneBankId) as RawBankRow | undefined;

          if (!bank) {
            throw new Error('Selected 3-in-1 linked bank account not found.');
          }
          if (bank.balance + 1e-6 < totalNotional) {
            throw new Error(
              `Insufficient funds in ${bank.bank_name}: required ${formatINR(
                totalNotional
              )}, available ${formatINR(bank.balance)}.`
            );
          }

          const newBankBal = Number(Math.max(0, bank.balance - totalNotional).toFixed(2));
          this.db
            .prepare('UPDATE bank_accounts SET balance = ? WHERE id = ?')
            .run(newBankBal, bank.id);

          this.db
            .prepare(
              `INSERT INTO bank_transactions (bank_account_id, bank_name, type, method, amount, reference_note, created_at)
               VALUES (?, ?, 'THREE_IN_ONE_BUY_DEBIT', 'ASBA_3IN1', ?, ?, ?)`
            )
            .run(
              bank.id,
              bank.bank_name,
              totalNotional,
              `3-in-1 ASBA Block & Debit for BUY ${req.quantity} ${req.symbol} @ ${formatINR(
                executionPrice
              )}`,
              now
            );

          currentCash = Number((currentCash + totalNotional).toFixed(2));
        }

        if (currentCash + 1e-6 < totalNotional) {
          throw new Error(
            `Insufficient Demat buying power: required ${formatINR(
              totalNotional
            )}, available ${formatINR(currentCash)}. Add funds from your linked bank or enable 3-in-1 Bank Auto-Debit.`
          );
        }

        const newCash = Number(Math.max(0, currentCash - totalNotional).toFixed(2));
        this.db
          .prepare('UPDATE accounts SET cash_balance = ?, updated_at = ? WHERE id = 1')
          .run(newCash, now);

        this.db
          .prepare(
            `INSERT INTO tax_lots (symbol, initial_qty, remaining_qty, buy_price, broker_source, acquired_at)
             VALUES (?, ?, ?, ?, ?, ?)`
          )
          .run(req.symbol, req.quantity, req.quantity, executionPrice, brokerSource, now);
      } else {
        // SELL: Consume open tax lots in strict FIFO order (oldest acquired_at first)
        const openLots = this.db
          .prepare(
            `SELECT id, symbol, initial_qty, remaining_qty, buy_price, broker_source, acquired_at
             FROM tax_lots
             WHERE symbol = ? AND remaining_qty > 0
             ORDER BY acquired_at ASC, id ASC`
          )
          .all(req.symbol) as unknown as RawTaxLotRow[];

        const totalAvailableQty = openLots.reduce((sum, lot) => sum + lot.remaining_qty, 0);
        if (totalAvailableQty + 1e-6 < req.quantity) {
          throw new Error(
            `Insufficient units in Demat to sell ${req.symbol}: requested ${req.quantity}, held ${Number(
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
        let newCash = Number((account.cash_balance + totalNotional).toFixed(2));
        const newRealizedPnl = Number((account.realized_pnl + orderRealizedPnl).toFixed(2));

        // If 3-in-1 bank sweep is enabled on SELL, credit proceeds directly back to the linked bank
        if (req.useThreeInOneBankId) {
          const bank = this.db
            .prepare('SELECT * FROM bank_accounts WHERE id = ?')
            .get(req.useThreeInOneBankId) as RawBankRow | undefined;

          if (bank) {
            const newBankBal = Number((bank.balance + totalNotional).toFixed(2));
            this.db
              .prepare('UPDATE bank_accounts SET balance = ? WHERE id = ?')
              .run(newBankBal, bank.id);

            this.db
              .prepare(
                `INSERT INTO bank_transactions (bank_account_id, bank_name, type, method, amount, reference_note, created_at)
                 VALUES (?, ?, 'THREE_IN_ONE_SELL_CREDIT', 'ASBA_3IN1', ?, ?, ?)`
              )
              .run(
                bank.id,
                bank.bank_name,
                totalNotional,
                `3-in-1 Direct Bank Settlement for SELL ${req.quantity} ${req.symbol} @ ${formatINR(
                  executionPrice
                )}`,
                now
              );
            newCash = account.cash_balance;
          }
        }

        this.db
          .prepare('UPDATE accounts SET cash_balance = ?, realized_pnl = ?, updated_at = ? WHERE id = 1')
          .run(newCash, newRealizedPnl, now);
      }

      const insertResult = this.db
        .prepare(
          `INSERT INTO orders (idempotency_key, symbol, side, quantity, execution_price, total_notional, realized_pnl, broker_source, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          cleanKey,
          req.symbol,
          req.side,
          req.quantity,
          executionPrice,
          totalNotional,
          orderRealizedPnl,
          brokerSource,
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
   * Links a new Indian Bank account (SBI, HDFC, ICICI, Axis, Kotak, PNB, Bank of Baroda) for UPI/NetBanking/3-in-1 transfers.
   */
  public linkBankAccount(input: {
    bankName: string;
    accountNumberMasked: string;
    ifscCode: string;
    upiId: string;
    initialBalance: number;
    isPrimaryThreeInOne?: boolean;
  }): BankAccount {
    if (!input.bankName?.trim() || !input.ifscCode?.trim()) {
      throw new Error('Bank name and IFSC code are required.');
    }
    const balance = Math.max(0, Number(input.initialBalance || 0));

    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (input.isPrimaryThreeInOne) {
        this.db.prepare('UPDATE bank_accounts SET is_primary = 0').run();
      }
      const res = this.db
        .prepare(
          `INSERT INTO bank_accounts (bank_name, account_number_masked, ifsc_code, upi_id, balance, is_primary)
           VALUES (?, ?, ?, ?, ?, ?)`
        )
        .run(
          input.bankName.trim(),
          input.accountNumberMasked.trim() || 'XXXX-XXXX-8821',
          input.ifscCode.trim().toUpperCase(),
          input.upiId.trim() || 'investor@upi',
          balance,
          input.isPrimaryThreeInOne ? 1 : 0
        );

      const created = this.db
        .prepare('SELECT * FROM bank_accounts WHERE id = ?')
        .get(Number(res.lastInsertRowid)) as unknown as RawBankRow;

      this.db.exec('COMMIT');
      return this.mapBankRow(created);
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  /**
   * Executes an atomic double-entry funds transfer between a linked Indian bank account and the Demat trading ledger.
   */
  public transferBankFunds(input: {
    bankAccountId: number;
    direction: 'DEPOSIT_TO_DEMAT' | 'WITHDRAW_TO_BANK';
    method: 'UPI' | 'NETBANKING' | 'IMPS' | 'ASBA_3IN1';
    amount: number;
    referenceNote?: string;
  }): BankTransaction {
    if (!Number.isFinite(input.amount) || input.amount <= 0) {
      throw new Error('Transfer amount must be greater than ₹0.');
    }

    const amount = Number(input.amount.toFixed(2));
    const now = new Date().toISOString();

    this.db.exec('BEGIN IMMEDIATE');
    try {
      const bank = this.db
        .prepare('SELECT * FROM bank_accounts WHERE id = ?')
        .get(input.bankAccountId) as RawBankRow | undefined;

      if (!bank) {
        throw new Error('Linked bank account not found.');
      }

      const account = this.db
        .prepare('SELECT cash_balance FROM accounts WHERE id = 1')
        .get() as { cash_balance: number };

      if (input.direction === 'DEPOSIT_TO_DEMAT') {
        if (bank.balance + 1e-6 < amount) {
          throw new Error(
            `Insufficient balance in ${bank.bank_name}: requested ${formatINR(
              amount
            )}, available ${formatINR(bank.balance)}.`
          );
        }

        const newBankBal = Number((bank.balance - amount).toFixed(2));
        const newDematCash = Number((account.cash_balance + amount).toFixed(2));

        this.db
          .prepare('UPDATE bank_accounts SET balance = ? WHERE id = ?')
          .run(newBankBal, bank.id);
        this.db
          .prepare('UPDATE accounts SET cash_balance = ?, updated_at = ? WHERE id = 1')
          .run(newDematCash, now);
      } else {
        if (account.cash_balance + 1e-6 < amount) {
          throw new Error(
            `Insufficient free Demat margin to withdraw: requested ${formatINR(
              amount
            )}, available ${formatINR(account.cash_balance)}.`
          );
        }

        const newDematCash = Number((account.cash_balance - amount).toFixed(2));
        const newBankBal = Number((bank.balance + amount).toFixed(2));

        this.db
          .prepare('UPDATE accounts SET cash_balance = ?, updated_at = ? WHERE id = 1')
          .run(newDematCash, now);
        this.db
          .prepare('UPDATE bank_accounts SET balance = ? WHERE id = ?')
          .run(newBankBal, bank.id);
      }

      const utr = `${input.method}/${Math.floor(100000000000 + Math.random() * 899999999999)}`;
      const note =
        input.referenceNote?.trim() ||
        (input.direction === 'DEPOSIT_TO_DEMAT'
          ? `Instant ${input.method} Add Funds to Demat (${utr})`
          : `Payout Settlement to ${bank.bank_name} (${utr})`);

      const txRes = this.db
        .prepare(
          `INSERT INTO bank_transactions (bank_account_id, bank_name, type, method, amount, reference_note, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
        .run(bank.id, bank.bank_name, input.direction, input.method, amount, note, now);

      const createdTx = this.db
        .prepare('SELECT * FROM bank_transactions WHERE id = ?')
        .get(Number(txRes.lastInsertRowid)) as unknown as RawBankTxRow;

      this.db.exec('COMMIT');
      return this.mapBankTxRow(createdTx);
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  /**
   * Imports existing Demat holdings from external Indian brokers (SBI Securities, HDFC Sky, Groww, Zerodha, Angel One)
   * without deducting Demat cash (since those shares were already purchased in the external Demat account).
   */
  public importExternalHoldings(items: ExternalHoldingImportItem[]): { importedCount: number } {
    if (!Array.isArray(items) || items.length === 0) {
      throw new Error('No holdings provided to import.');
    }

    const now = new Date().toISOString();
    let importedCount = 0;

    this.db.exec('BEGIN IMMEDIATE');
    try {
      const insertLot = this.db.prepare(
        `INSERT INTO tax_lots (symbol, initial_qty, remaining_qty, buy_price, broker_source, acquired_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      );
      const insertOrder = this.db.prepare(
        `INSERT INTO orders (idempotency_key, symbol, side, quantity, execution_price, total_notional, realized_pnl, broker_source, created_at)
         VALUES (?, ?, 'BUY', ?, ?, ?, 0, ?, ?)`
      );

      for (const item of items) {
        const cleanSymbol = item.symbol?.trim().toUpperCase();
        if (!cleanSymbol || !SYMBOL_MAP.has(cleanSymbol)) continue;
        if (!Number.isFinite(item.quantity) || item.quantity <= 0) continue;
        if (!Number.isFinite(item.buyPrice) || item.buyPrice <= 0) continue;

        const broker: BrokerSource = item.brokerSource || 'SBI Securities';
        const notional = Number((item.quantity * item.buyPrice).toFixed(2));
        const idemKey = `import-${broker.replace(/\s+/g, '-').toLowerCase()}-${cleanSymbol}-${Date.now()}-${importedCount}`;

        insertLot.run(cleanSymbol, item.quantity, item.quantity, item.buyPrice, broker, now);
        insertOrder.run(
          idemKey,
          cleanSymbol,
          item.quantity,
          item.buyPrice,
          notional,
          broker,
          now
        );
        importedCount++;
      }

      this.db.exec('COMMIT');
      return { importedCount };
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  /**
   * Clears all holdings and order history so the portfolio starts completely empty (0 positions).
   */
  public resetPortfolioHoldings(): void {
    const now = new Date().toISOString();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.exec('DELETE FROM tax_lots; DELETE FROM orders;');
      this.db
        .prepare('UPDATE accounts SET realized_pnl = 0, updated_at = ? WHERE id = 1')
        .run(now);
      this.db.exec('COMMIT');
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
        `SELECT id, symbol, initial_qty, remaining_qty, buy_price, broker_source, acquired_at
         FROM tax_lots
         WHERE remaining_qty > 0
         ORDER BY acquired_at ASC, id ASC`
      )
      .all() as unknown as RawTaxLotRow[];

    const recentOrderRows = this.db
      .prepare('SELECT * FROM orders ORDER BY id DESC LIMIT 40')
      .all() as unknown as RawOrderRow[];

    const bankRows = this.db
      .prepare('SELECT * FROM bank_accounts ORDER BY is_primary DESC, id ASC')
      .all() as unknown as RawBankRow[];

    const bankTxRows = this.db
      .prepare('SELECT * FROM bank_transactions ORDER BY id DESC LIMIT 30')
      .all() as unknown as RawBankTxRow[];

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
      const prevClose = tick ? tick.prevClose : meta.prevClose;
      const openPrice = tick ? tick.open : meta.openPrice ?? meta.prevClose;
      const dayHigh = tick ? tick.dayHigh : meta.dayHigh ?? currentPrice;
      const dayLow = tick ? tick.dayLow : meta.dayLow ?? currentPrice;
      const dayChange = tick ? tick.change : Number((currentPrice - prevClose).toFixed(2));
      const dayChangePercent = tick
        ? tick.changePercent
        : Number((((currentPrice - prevClose) / prevClose) * 100).toFixed(2));

      let totalQty = 0;
      let totalCost = 0;
      const brokerSet = new Set<BrokerSource>();

      for (const lot of lots) {
        totalQty += lot.remaining_qty;
        totalCost += lot.remaining_qty * lot.buy_price;
        brokerSet.add(lot.broker_source || 'KitePulse Direct');
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
        prevClose,
        openPrice,
        dayHigh,
        dayLow,
        marketValue,
        totalCost,
        unrealizedPnl,
        unrealizedPnlPercent,
        dayChange,
        dayChangePercent,
        weightPercent: 0,
        openLotsCount: lots.length,
        brokers: Array.from(brokerSet),
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
        holdingsMarketValue > 0
          ? Number(((h.marketValue / holdingsMarketValue) * 100).toFixed(2))
          : 0;
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
          holdingsMarketValue > 0
            ? Number(((marketValue / holdingsMarketValue) * 100).toFixed(2))
            : 0,
      }))
      .sort((a, b) => b.marketValue - a.marketValue);

    const segmentAllocations: SegmentAllocation[] = Array.from(segmentMap.entries())
      .map(([segment, val]) => ({
        segment,
        label: SEGMENT_LABELS[segment],
        marketValue: Number(val.mv.toFixed(2)),
        unrealizedPnl: Number(val.pnl.toFixed(2)),
        weightPercent:
          holdingsMarketValue > 0
            ? Number(((val.mv / holdingsMarketValue) * 100).toFixed(2))
            : 0,
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
        brokerSource: l.broker_source || 'KitePulse Direct',
        acquiredAt: l.acquired_at,
      })),
      bankAccounts: bankRows.map((b) => this.mapBankRow(b)),
      bankTransactions: bankTxRows.map((t) => this.mapBankTxRow(t)),
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
      brokerSource: row.broker_source || 'KitePulse Direct',
      createdAt: row.created_at,
    };
  }

  private mapBankRow(row: RawBankRow): BankAccount {
    return {
      id: row.id,
      bankName: row.bank_name,
      accountNumberMasked: row.account_number_masked,
      ifscCode: row.ifsc_code,
      upiId: row.upi_id,
      balance: row.balance,
      isPrimaryThreeInOne: row.is_primary === 1,
    };
  }

  private mapBankTxRow(row: RawBankTxRow): BankTransaction {
    return {
      id: row.id,
      bankAccountId: row.bank_account_id,
      bankName: row.bank_name,
      type: row.type,
      method: row.method,
      amount: row.amount,
      referenceNote: row.reference_note,
      createdAt: row.created_at,
    };
  }
}
