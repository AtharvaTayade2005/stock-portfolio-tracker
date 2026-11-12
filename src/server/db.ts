import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { SYMBOL_MAP } from '../shared/catalog.js';

export function createDatabase(dbPath?: string): DatabaseSync {
  const resolvedPath =
    dbPath ?? process.env.SQLITE_DB_PATH ?? path.resolve(process.cwd(), 'data', 'portfolio.sqlite');

  if (resolvedPath !== ':memory:') {
    const dir = path.dirname(resolvedPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  const db = new DatabaseSync(resolvedPath);

  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;

    CREATE TABLE IF NOT EXISTS accounts (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      cash_balance REAL NOT NULL CHECK (cash_balance >= 0),
      realized_pnl REAL NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      idempotency_key TEXT NOT NULL UNIQUE,
      symbol TEXT NOT NULL,
      side TEXT NOT NULL CHECK (side IN ('BUY', 'SELL')),
      quantity REAL NOT NULL CHECK (quantity > 0),
      execution_price REAL NOT NULL CHECK (execution_price > 0),
      total_notional REAL NOT NULL CHECK (total_notional > 0),
      realized_pnl REAL NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_orders_symbol_created ON orders(symbol, created_at DESC);

    CREATE TABLE IF NOT EXISTS tax_lots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      symbol TEXT NOT NULL,
      initial_qty REAL NOT NULL CHECK (initial_qty > 0),
      remaining_qty REAL NOT NULL CHECK (remaining_qty >= 0),
      buy_price REAL NOT NULL CHECK (buy_price > 0),
      acquired_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_tax_lots_fifo ON tax_lots(symbol, remaining_qty, acquired_at ASC, id ASC);

    CREATE TABLE IF NOT EXISTS price_alerts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      symbol TEXT NOT NULL,
      direction TEXT NOT NULL CHECK (direction IN ('ABOVE', 'BELOW')),
      target_price REAL NOT NULL CHECK (target_price > 0),
      status TEXT NOT NULL CHECK (status IN ('ACTIVE', 'TRIGGERED')) DEFAULT 'ACTIVE',
      note TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      triggered_at TEXT,
      triggered_price REAL
    );

    CREATE INDEX IF NOT EXISTS idx_price_alerts_active ON price_alerts(symbol, status);
  `);

  seedInitialDataIfEmpty(db);
  return db;
}

export function seedInitialDataIfEmpty(db: DatabaseSync): void {
  // Check if any legacy non-INR symbol exists in tax_lots; if so, migrate cleanly to Indian Market seed
  const sampleLot = db.prepare('SELECT symbol FROM tax_lots LIMIT 1').get() as
    | { symbol: string }
    | undefined;
  if (sampleLot && !SYMBOL_MAP.has(sampleLot.symbol)) {
    db.exec('DELETE FROM price_alerts; DELETE FROM tax_lots; DELETE FROM orders; DELETE FROM accounts;');
  }

  const existing = db.prepare('SELECT id FROM accounts WHERE id = 1').get() as { id: number } | undefined;
  if (existing) return;

  const now = new Date().toISOString();

  db.exec('BEGIN IMMEDIATE');
  try {
    // Seed ₹14,65,200.00 available margin + ~₹11,48,000 deployed across Large/Mid/Small Cap, F&O, ETF & Mutual Funds
    db.prepare(
      'INSERT INTO accounts (id, cash_balance, realized_pnl, updated_at) VALUES (1, ?, 38450.00, ?)'
    ).run(1465200.0, now);

    const seedLots: Array<{
      symbol: string;
      qty: number;
      price: number;
      acquiredOffsetMin: number;
      idempotencyKey: string;
    }> = [
      // Large Cap Equities (NSE / BSE)
      { symbol: 'RELIANCE', qty: 120, price: 1242.0, acquiredOffsetMin: 360, idempotencyKey: 'seed-inr-rel-1' },
      { symbol: 'RELIANCE', qty: 60, price: 1268.5, acquiredOffsetMin: 180, idempotencyKey: 'seed-inr-rel-2' },
      { symbol: 'TCS', qty: 35, price: 3980.0, acquiredOffsetMin: 300, idempotencyKey: 'seed-inr-tcs-1' },
      { symbol: 'HDFCBANK', qty: 90, price: 1695.0, acquiredOffsetMin: 260, idempotencyKey: 'seed-inr-hdfc-1' },
      { symbol: 'SBIN', qty: 150, price: 812.0, acquiredOffsetMin: 220, idempotencyKey: 'seed-inr-sbin-1' },

      // Mid Cap Equities
      { symbol: 'DIXON', qty: 8, price: 14650.0, acquiredOffsetMin: 200, idempotencyKey: 'seed-inr-dixon-1' },
      { symbol: 'TRENT', qty: 15, price: 6180.0, acquiredOffsetMin: 170, idempotencyKey: 'seed-inr-trent-1' },

      // Small Cap Equities
      { symbol: 'CDSL', qty: 55, price: 1540.0, acquiredOffsetMin: 150, idempotencyKey: 'seed-inr-cdsl-1' },
      { symbol: 'KPITTECH', qty: 40, price: 1365.0, acquiredOffsetMin: 130, idempotencyKey: 'seed-inr-kpit-1' },

      // F&O Derivatives (NFO)
      { symbol: 'NIFTY 24200 CE', qty: 50, price: 218.0, acquiredOffsetMin: 95, idempotencyKey: 'seed-inr-niftyce-1' },
      { symbol: 'NIFTY 24000 PE', qty: 25, price: 172.0, acquiredOffsetMin: 80, idempotencyKey: 'seed-inr-niftype-1' },

      // ETFs (NSE)
      { symbol: 'NIFTYBEES', qty: 300, price: 258.5, acquiredOffsetMin: 400, idempotencyKey: 'seed-inr-niftybees-1' },
      { symbol: 'GOLDBEES', qty: 500, price: 61.4, acquiredOffsetMin: 380, idempotencyKey: 'seed-inr-goldbees-1' },

      // Direct Mutual Funds (AMFI / Coin)
      { symbol: 'PPFAS-FLEXI', qty: 1200, price: 79.8, acquiredOffsetMin: 500, idempotencyKey: 'seed-inr-ppfas-1' },
      { symbol: 'QUANT-SMALL', qty: 350, price: 252.0, acquiredOffsetMin: 460, idempotencyKey: 'seed-inr-quant-1' },
    ];

    const insertOrder = db.prepare(`
      INSERT INTO orders (idempotency_key, symbol, side, quantity, execution_price, total_notional, realized_pnl, created_at)
      VALUES (?, ?, 'BUY', ?, ?, ?, 0, ?)
    `);

    const insertLot = db.prepare(`
      INSERT INTO tax_lots (symbol, initial_qty, remaining_qty, buy_price, acquired_at)
      VALUES (?, ?, ?, ?, ?)
    `);

    for (const lot of seedLots) {
      const acquiredAt = new Date(Date.now() - lot.acquiredOffsetMin * 60_000).toISOString();
      const notional = Number((lot.qty * lot.price).toFixed(2));
      insertOrder.run(lot.idempotencyKey, lot.symbol, lot.qty, lot.price, notional, acquiredAt);
      insertLot.run(lot.symbol, lot.qty, lot.qty, lot.price, acquiredAt);
    }

    const insertAlert = db.prepare(`
      INSERT INTO price_alerts (symbol, direction, target_price, status, note, created_at)
      VALUES (?, ?, ?, 'ACTIVE', ?, ?)
    `);

    insertAlert.run('RELIANCE', 'ABOVE', 1295.0, 'NSE Cash breakout above ₹1,295 resistance', now);
    insertAlert.run('HDFCBANK', 'BELOW', 1745.0, 'Support zone retest alert', now);
    insertAlert.run('NIFTY 24200 CE', 'ABOVE', 260.0, 'NFO Call option momentum target', now);

    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
