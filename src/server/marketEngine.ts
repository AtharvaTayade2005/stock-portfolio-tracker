import WebSocket from 'ws';
import { SYMBOL_CATALOG, SYMBOL_MAP } from '../shared/catalog.js';
import type { MarketTick, OhlcvCandle, ReplaySpeed, SymbolMetadata } from '../shared/types.js';

/**
 * Deterministic Mulberry32 PRNG so historical candle seeding and replay mode
 * produce repeatable, realistic price paths across restarts.
 */
function createSeededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Box-Muller transform converting uniform [0,1) samples into standard normal N(0,1).
 */
function sampleStandardNormal(rng: () => number): number {
  const u1 = Math.max(1e-7, rng());
  const u2 = Math.max(1e-7, rng());
  return Math.sqrt(-2.0 * Math.log(u1)) * Math.cos(2.0 * Math.PI * u2);
}

export type TickListener = (ticks: MarketTick[], updatedCandles: OhlcvCandle[]) => void;

export class MarketEngine {
  private readonly latestTicks = new Map<string, MarketTick>();
  private readonly candlesBySymbol = new Map<string, OhlcvCandle[]>();
  private readonly tickCountBySymbol = new Map<string, number>();
  private readonly rng = createSeededRandom(20261112);

  private replaySpeed: ReplaySpeed = 1;
  private replayTimer: NodeJS.Timeout | null = null;
  private finnhubWs: WebSocket | null = null;
  private readonly listeners = new Set<TickListener>();
  private readonly maxCandlesPerSymbol = 220;

  constructor(private readonly finnhubApiKey?: string) {
    this.seedHistoricalCandles(140);
  }

  public start(): void {
    this.restartReplayLoop();
    if (this.finnhubApiKey && this.finnhubApiKey.trim().length > 0) {
      this.connectFinnhubUpstream(this.finnhubApiKey.trim());
    }
  }

  public stop(): void {
    if (this.replayTimer) {
      clearInterval(this.replayTimer);
      this.replayTimer = null;
    }
    if (this.finnhubWs) {
      this.finnhubWs.close();
      this.finnhubWs = null;
    }
  }

  public onTickBatch(listener: TickListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  public getReplaySpeed(): ReplaySpeed {
    return this.replaySpeed;
  }

  public getFeedMode(): 'REPLAY' | 'FINNHUB_LIVE' {
    return this.finnhubApiKey && this.finnhubApiKey.trim().length > 0 ? 'FINNHUB_LIVE' : 'REPLAY';
  }

  public setReplaySpeed(speed: ReplaySpeed): ReplaySpeed {
    this.replaySpeed = speed;
    this.restartReplayLoop();
    return this.replaySpeed;
  }

  public getLatestTicksMap(): Map<string, MarketTick> {
    return this.latestTicks;
  }

  public getAllLatestTicks(): MarketTick[] {
    return SYMBOL_CATALOG.map((meta) => this.latestTicks.get(meta.symbol)!).filter(Boolean);
  }

  public getCandles(symbol: string): OhlcvCandle[] {
    return this.candlesBySymbol.get(symbol) ?? [];
  }

  /**
   * Seeds 140 historical 1-minute OHLCV candles per symbol using Geometric Brownian Motion
   * with slight mean-reverting cyclical momentum so technical indicators (SMA/EMA/RSI/BB)
   * are immediately populated on startup.
   */
  private seedHistoricalCandles(count: number): void {
    const nowSec = Math.floor(Date.now() / 1000);
    const startSec = nowSec - count * 60;

    for (const meta of SYMBOL_CATALOG) {
      const candles: OhlcvCandle[] = [];
      let price = meta.basePrice * 0.985;

      for (let i = 0; i < count; i++) {
        const candleTime = startSec + i * 60;
        const open = Number(price.toFixed(2));

        // Add subtle sinusoidal regime + stochastic GBM shock
        const wave = Math.sin(i / 14) * meta.volatility * 0.35;
        const z = sampleStandardNormal(this.rng);
        const returnPct = wave + meta.volatility * z;
        const close = Number(Math.max(1, open * (1 + returnPct)).toFixed(2));

        const intraSpread = Math.abs(close - open) + open * meta.volatility * (0.4 + this.rng() * 0.8);
        const high = Number((Math.max(open, close) + intraSpread * 0.55).toFixed(2));
        const low = Number(Math.max(0.5, Math.min(open, close) - intraSpread * 0.55).toFixed(2));
        const volume = Math.floor(12000 + this.rng() * 48000);

        candles.push({
          symbol: meta.symbol,
          time: candleTime,
          open,
          high,
          low,
          close,
          volume,
        });

        price = close;
      }

      this.candlesBySymbol.set(meta.symbol, candles);
      this.tickCountBySymbol.set(meta.symbol, 0);

      const lastCandle = candles[candles.length - 1];
      const prevClose = meta.basePrice;
      const change = Number((lastCandle.close - prevClose).toFixed(2));
      const changePercent = Number(((change / prevClose) * 100).toFixed(2));
      const halfSpread = Number(Math.max(0.01, lastCandle.close * 0.0003).toFixed(2));

      this.latestTicks.set(meta.symbol, {
        symbol: meta.symbol,
        price: lastCandle.close,
        prevClose,
        change,
        changePercent,
        volume: lastCandle.volume,
        bid: Number((lastCandle.close - halfSpread).toFixed(2)),
        ask: Number((lastCandle.close + halfSpread).toFixed(2)),
        timestamp: Date.now(),
        source: 'REPLAY',
      });
    }
  }

  private restartReplayLoop(): void {
    if (this.replayTimer) {
      clearInterval(this.replayTimer);
      this.replayTimer = null;
    }

    if (this.replaySpeed === 0) return;

    // 1x = 1000ms, 5x = 240ms, 10x = 120ms tick interval
    const intervalMs =
      this.replaySpeed === 10 ? 120 : this.replaySpeed === 5 ? 240 : 1000;

    this.replayTimer = setInterval(() => {
      this.stepReplayTicks();
    }, intervalMs);
  }

  /**
   * Advances a subset of symbols on each tick cycle and notifies WebSocket fan-out listeners.
   */
  public stepReplayTicks(): { ticks: MarketTick[]; updatedCandles: OhlcvCandle[] } {
    const updatedTicks: MarketTick[] = [];
    const updatedCandles: OhlcvCandle[] = [];

    for (const meta of SYMBOL_CATALOG) {
      // Update ~65% of symbols on each sub-second pulse for organic market tape cadence
      if (this.rng() < 0.35) continue;

      const currentTick = this.latestTicks.get(meta.symbol)!;
      const candles = this.candlesBySymbol.get(meta.symbol)!;
      const lastCandle = candles[candles.length - 1];

      // Mean reversion toward basePrice * 1.01 + stochastic normal shock
      const anchor = meta.basePrice * 1.01;
      const pull = ((anchor - currentTick.price) / anchor) * 0.015;
      const shock = sampleStandardNormal(this.rng) * meta.volatility * 0.45;
      const nextPrice = Number(
        Math.max(1, currentTick.price * (1 + pull + shock)).toFixed(2)
      );

      const tradeVol = Math.floor(150 + this.rng() * 1400);
      const updatedCandle = this.applyTradeToCandles(meta, candles, lastCandle, nextPrice, tradeVol);

      const change = Number((nextPrice - meta.basePrice).toFixed(2));
      const changePercent = Number(((change / meta.basePrice) * 100).toFixed(2));
      const halfSpread = Number(Math.max(0.01, nextPrice * 0.0003).toFixed(2));

      const nextTick: MarketTick = {
        symbol: meta.symbol,
        price: nextPrice,
        prevClose: meta.basePrice,
        change,
        changePercent,
        volume: updatedCandle.volume,
        bid: Number((nextPrice - halfSpread).toFixed(2)),
        ask: Number((nextPrice + halfSpread).toFixed(2)),
        timestamp: Date.now(),
        source: 'REPLAY',
      };

      this.latestTicks.set(meta.symbol, nextTick);
      updatedTicks.push(nextTick);
      updatedCandles.push(updatedCandle);
    }

    if (updatedTicks.length > 0) {
      for (const listener of this.listeners) {
        listener(updatedTicks, updatedCandles);
      }
    }

    return { ticks: updatedTicks, updatedCandles };
  }

  private applyTradeToCandles(
    meta: SymbolMetadata,
    candles: OhlcvCandle[],
    lastCandle: OhlcvCandle,
    price: number,
    volumeDelta: number
  ): OhlcvCandle {
    const tickCount = (this.tickCountBySymbol.get(meta.symbol) ?? 0) + 1;
    this.tickCountBySymbol.set(meta.symbol, tickCount);

    // Roll over to a new 1-minute candle every 16 ticks so users see live candle formation in replay mode
    if (tickCount % 16 === 0) {
      const nextCandle: OhlcvCandle = {
        symbol: meta.symbol,
        time: lastCandle.time + 60,
        open: lastCandle.close,
        high: Math.max(lastCandle.close, price),
        low: Math.min(lastCandle.close, price),
        close: price,
        volume: volumeDelta,
      };
      candles.push(nextCandle);
      if (candles.length > this.maxCandlesPerSymbol) {
        candles.shift();
      }
      return nextCandle;
    }

    lastCandle.close = price;
    lastCandle.high = Math.max(lastCandle.high, price);
    lastCandle.low = Math.min(lastCandle.low, price);
    lastCandle.volume += volumeDelta;
    return { ...lastCandle };
  }

  /**
   * Optional single upstream Finnhub WebSocket connection (Fan-Out Pattern).
   * One backend socket ingests Finnhub trades and broadcasts to N browser clients.
   */
  private connectFinnhubUpstream(apiKey: string): void {
    const url = `wss://ws.finnhub.io?token=${encodeURIComponent(apiKey)}`;
    const ws = new WebSocket(url);
    this.finnhubWs = ws;

    ws.on('open', () => {
      for (const meta of SYMBOL_CATALOG) {
        if (meta.exchange !== 'NSE') {
          ws.send(JSON.stringify({ type: 'subscribe', symbol: meta.symbol }));
        }
      }
    });

    ws.on('message', (raw) => {
      try {
        const parsed = JSON.parse(String(raw)) as {
          type?: string;
          data?: Array<{ s: string; p: number; v: number; t: number }>;
        };
        if (parsed.type !== 'trade' || !Array.isArray(parsed.data)) return;

        const updatedTicks: MarketTick[] = [];
        const updatedCandles: OhlcvCandle[] = [];

        for (const trade of parsed.data) {
          const meta = SYMBOL_MAP.get(trade.s);
          if (!meta) continue;

          const price = Number(trade.p.toFixed(2));
          const candles = this.candlesBySymbol.get(meta.symbol)!;
          const lastCandle = candles[candles.length - 1];
          const updatedCandle = this.applyTradeToCandles(
            meta,
            candles,
            lastCandle,
            price,
            Math.max(1, Math.round(trade.v))
          );

          const change = Number((price - meta.basePrice).toFixed(2));
          const changePercent = Number(((change / meta.basePrice) * 100).toFixed(2));
          const halfSpread = Number(Math.max(0.01, price * 0.0003).toFixed(2));

          const tick: MarketTick = {
            symbol: meta.symbol,
            price,
            prevClose: meta.basePrice,
            change,
            changePercent,
            volume: updatedCandle.volume,
            bid: Number((price - halfSpread).toFixed(2)),
            ask: Number((price + halfSpread).toFixed(2)),
            timestamp: trade.t || Date.now(),
            source: 'FINNHUB_LIVE',
          };

          this.latestTicks.set(meta.symbol, tick);
          updatedTicks.push(tick);
          updatedCandles.push(updatedCandle);
        }

        if (updatedTicks.length > 0) {
          for (const listener of this.listeners) {
            listener(updatedTicks, updatedCandles);
          }
        }
      } catch {
        // Ignore malformed upstream frames
      }
    });

    ws.on('error', () => {
      // Replay engine remains active if Finnhub connection drops
    });
  }
}
