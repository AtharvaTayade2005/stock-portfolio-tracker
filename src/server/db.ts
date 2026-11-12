import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

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
      broker_source TEXT NOT NULL DEFAULT 'KitePulse Direct',
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_orders_symbol_created ON orders(symbol, created_at DESC);

    CREATE TABLE IF NOT EXISTS tax_lots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      symbol TEXT NOT NULL,
      initial_qty REAL NOT NULL CHECK (initial_qty > 0),
      remaining_qty REAL NOT NULL CHECK (remaining_qty >= 0),
      buy_price REAL NOT NULL CHECK (buy_price > 0),
      broker_source TEXT NOT NULL DEFAULT 'KitePulse Direct',
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

    CREATE TABLE IF NOT EXISTS bank_accounts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      bank_name TEXT NOT NULL,
      account_number_masked TEXT NOT NULL,
      ifsc_code TEXT NOT NULL,
      upi_id TEXT NOT NULL,
      balance REAL NOT NULL CHECK (balance >= 0),
      is_primary INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS bank_transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      bank_account_id INTEGER NOT NULL,
      bank_name TEXT NOT NULL,
      type TEXT NOT NULL,
      method TEXT NOT NULL,
      amount REAL NOT NULL CHECK (amount > 0),
      reference_note TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL
    );
  `);

  try {
    db.exec(`ALTER TABLE orders ADD COLUMN broker_source TEXT NOT NULL DEFAULT 'KitePulse Direct';`);
  } catch {
    // Column exists
  }
  try {
    db.exec(`ALTER TABLE tax_lots ADD COLUMN broker_source TEXT NOT NULL DEFAULT 'KitePulse Direct';`);
  } catch {
    // Column exists
  }

  seedInitialDataIfEmpty(db);
  return db;
}

export function seedInitialDataIfEmpty(db: DatabaseSync): void {
  // Purge any legacy pre-seeded Phase 1 holdings so the portfolio starts 100% empty as requested
  const legacySeedOrder = db
    .prepare("SELECT id FROM orders WHERE idempotency_key LIKE 'seed-%' LIMIT 1")
    .get() as { id: number } | undefined;

  if (legacySeedOrder) {
    db.exec(`
      DELETE FROM price_alerts;
      DELETE FROM tax_lots;
      DELETE FROM orders;
      DELETE FROM accounts;
    `);
  }

  const now = new Date().toISOString();

  const existingAccount = db.prepare('SELECT id FROM accounts WHERE id = 1').get() as
    | { id: number }
    | undefined;

  if (!existingAccount) {
    db.exec('BEGIN IMMEDIATE');
    try {
      // Start with ₹5,00,000.00 available Demat margin and 0 pre-seeded stock holdings
      db.prepare(
        'INSERT INTO accounts (id, cash_balance, realized_pnl, updated_at) VALUES (1, ?, 0.00, ?)'
      ).run(500000.0, now);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }

  const existingBanks = db.prepare('SELECT COUNT(*) as cnt FROM bank_accounts').get() as {
    cnt: number;
  };

  if (existingBanks.cnt === 0) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const insertBank = db.prepare(`
        INSERT INTO bank_accounts (
          bank_name, account_number_masked, ifsc_code, upi_id, balance, is_primary
        ) VALUES (?, ?, ?, ?, ?, ?)
      `);

      insertBank.run(
        'State Bank of India (SBI 3-in-1)',
        'XXXX-XXXX-4829',
        'SBIN0000300',
        'atharva.sbi@oksbi',
        1250000.0,
        1
      );
      insertBank.run(
        'HDFC Bank (Sky 3-in-1)',
        'XXXX-XXXX-9104',
        'HDFC0000240',
        'atharva.hdfc@okhdfcbank',
        840000.0,
        0
      );
      insertBank.run(
        'ICICI Bank Savings',
        'XXXX-XXXX-3318',
        'ICIC0000004',
        'atharva@icici',
        420000.0,
        0
      );

      db.prepare(`
        INSERT INTO bank_transactions (
          bank_account_id, bank_name, type, method, amount, reference_note, created_at
        ) VALUES (1, 'State Bank of India (SBI 3-in-1)', 'DEPOSIT_TO_DEMAT', 'UPI', 500000.0, 'Initial 3-in-1 Demat Margin Allocation (UTR: 431789204112)', ?)
      `).run(now);

      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }
}
