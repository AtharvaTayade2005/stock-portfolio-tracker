import type { DatabaseSync } from 'node:sqlite';
import { SYMBOL_MAP } from '../shared/catalog.js';
import type { AlertDirection, MarketTick, PriceAlert } from '../shared/types.js';

interface RawAlertRow {
  id: number;
  symbol: string;
  direction: AlertDirection;
  target_price: number;
  status: 'ACTIVE' | 'TRIGGERED';
  note: string;
  created_at: string;
  triggered_at: string | null;
  triggered_price: number | null;
}

export class AlertEngine {
  /**
   * O(1) symbol-keyed lookup bucket for active price alerts so incoming ticks never scan the database.
   */
  private readonly activeBySymbol = new Map<string, PriceAlert[]>();

  constructor(private readonly db: DatabaseSync) {
    this.reloadActiveCache();
  }

  public reloadActiveCache(): void {
    this.activeBySymbol.clear();
    const rows = this.db
      .prepare("SELECT * FROM price_alerts WHERE status = 'ACTIVE' ORDER BY id ASC")
      .all() as unknown as RawAlertRow[];

    for (const row of rows) {
      const alert = this.mapRow(row);
      const list = this.activeBySymbol.get(alert.symbol) ?? [];
      list.push(alert);
      this.activeBySymbol.set(alert.symbol, list);
    }
  }

  public listAlerts(): PriceAlert[] {
    const rows = this.db
      .prepare('SELECT * FROM price_alerts ORDER BY status ASC, id DESC LIMIT 50')
      .all() as unknown as RawAlertRow[];
    return rows.map((r) => this.mapRow(r));
  }

  public createAlert(input: {
    symbol: string;
    direction: AlertDirection;
    targetPrice: number;
    note?: string;
  }): PriceAlert {
    if (!SYMBOL_MAP.has(input.symbol)) {
      throw new Error(`Unknown symbol: ${input.symbol}`);
    }
    if (input.direction !== 'ABOVE' && input.direction !== 'BELOW') {
      throw new Error('Alert direction must be ABOVE or BELOW.');
    }
    if (!Number.isFinite(input.targetPrice) || input.targetPrice <= 0) {
      throw new Error('Target price must be a positive number.');
    }

    const now = new Date().toISOString();
    const cleanNote = (input.note ?? '').trim().slice(0, 140);

    const res = this.db
      .prepare(
        `INSERT INTO price_alerts (symbol, direction, target_price, status, note, created_at)
         VALUES (?, ?, ?, 'ACTIVE', ?, ?)`
      )
      .run(input.symbol, input.direction, Number(input.targetPrice.toFixed(2)), cleanNote, now);

    const createdRow = this.db
      .prepare('SELECT * FROM price_alerts WHERE id = ?')
      .get(Number(res.lastInsertRowid)) as unknown as RawAlertRow;

    const alert = this.mapRow(createdRow);
    const list = this.activeBySymbol.get(alert.symbol) ?? [];
    list.push(alert);
    this.activeBySymbol.set(alert.symbol, list);

    return alert;
  }

  public deleteAlert(id: number): boolean {
    const res = this.db.prepare('DELETE FROM price_alerts WHERE id = ?').run(id);
    this.reloadActiveCache();
    return res.changes > 0;
  }

  /**
   * Evaluates a market tick in O(1) symbol bucket lookup time.
   * Returns any alerts that crossed their threshold on this tick.
   */
  public evaluateTick(tick: MarketTick): PriceAlert[] {
    const bucket = this.activeBySymbol.get(tick.symbol);
    if (!bucket || bucket.length === 0) return [];

    const triggered: PriceAlert[] = [];
    const remaining: PriceAlert[] = [];
    const now = new Date().toISOString();

    const updateStmt = this.db.prepare(
      `UPDATE price_alerts
       SET status = 'TRIGGERED', triggered_at = ?, triggered_price = ?
       WHERE id = ?`
    );

    for (const alert of bucket) {
      const hitAbove = alert.direction === 'ABOVE' && tick.price >= alert.targetPrice;
      const hitBelow = alert.direction === 'BELOW' && tick.price <= alert.targetPrice;

      if (hitAbove || hitBelow) {
        updateStmt.run(now, tick.price, alert.id);
        triggered.push({
          ...alert,
          status: 'TRIGGERED',
          triggeredAt: now,
          triggeredPrice: tick.price,
        });
      } else {
        remaining.push(alert);
      }
    }

    if (triggered.length > 0) {
      this.activeBySymbol.set(tick.symbol, remaining);
    }

    return triggered;
  }

  private mapRow(row: RawAlertRow): PriceAlert {
    return {
      id: row.id,
      symbol: row.symbol,
      direction: row.direction,
      targetPrice: row.target_price,
      status: row.status,
      note: row.note,
      createdAt: row.created_at,
      triggeredAt: row.triggered_at,
      triggeredPrice: row.triggered_price,
    };
  }
}
