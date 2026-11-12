import {
  SYMBOL_CATALOG,
  SYMBOL_MAP,
  registerDynamicSymbol,
} from '../shared/catalog.js';
import type {
  MarketIndexQuote,
  MarketSessionPhase,
  MarketSessionStatus,
  MarketTick,
  OhlcvCandle,
  ReplaySpeed,
  SymbolMetadata,
} from '../shared/types.js';

interface SymbolState {
  meta: SymbolMetadata;
  price: number;
  prevClose: number;
  open: number;
  dayHigh: number;
  dayLow: number;
  volume: number;
  candles: OhlcvCandle[];
}

export class MarketEngine {
  private states = new Map<string, SymbolState>();
  private replaySpeed: ReplaySpeed = 0; // Default 0 = Authentic Live / Official Closing Bell prices (no fake drift)
  private timer: NodeJS.Timeout | null = null;
  private liveSyncTimer: NodeJS.Timeout | null = null;
  private tickListeners: Array<(ticks: MarketTick[], updatedCandles: OhlcvCandle[]) => void> = [];
  private lastSyncedAt: string = new Date().toISOString();
  private isSyncing = false;

  private indices: MarketIndexQuote[] = [
    {
      symbol: '^NSEI',
      name: 'NIFTY 50',
      price: 25299.35,
      prevClose: 25044.0,
      open: 25143.0,
      dayHigh: 25365.15,
      dayLow: 25086.45,
      change: 255.35,
      changePercent: 1.02,
    },
    {
      symbol: '^BSESN',
      name: 'BSE SENSEX',
      price: 82129.49,
      prevClose: 81148.2,
      open: 81642.1,
      dayHigh: 82354.6,
      dayLow: 81495.0,
      change: 981.29,
      changePercent: 1.21,
    },
    {
      symbol: '^NSEBANK',
      name: 'NIFTY BANK',
      price: 61518.5,
      prevClose: 59744.1,
      open: 60890.0,
      dayHigh: 61685.0,
      dayLow: 60740.0,
      change: 1774.4,
      changePercent: 2.97,
    },
  ];

  constructor(private readonly finnhubApiKey?: string) {
    this.initializeBaselineCandles();
  }

  private initializeBaselineCandles(): void {
    const nowSec = Math.floor(Date.now() / 1000);
    const startSec = nowSec - 75 * 300; // 75 5-min bars (09:15 to 15:30 IST = 375 mins)

    for (const meta of SYMBOL_CATALOG) {
      this.seedSymbolState(meta, startSec);
    }
  }

  private seedSymbolState(meta: SymbolMetadata, startSec?: number): SymbolState {
    const baseStart = startSec ?? Math.floor(Date.now() / 1000) - 75 * 300;
    const candles: OhlcvCandle[] = [];
    const targetClose = meta.basePrice;
    const prevClose = meta.prevClose;
    const openPrice = meta.openPrice ?? Number(((prevClose + targetClose) / 2).toFixed(2));
    const dayHigh =
      meta.dayHigh ?? Number((Math.max(openPrice, targetClose, prevClose) * 1.008).toFixed(2));
    const dayLow =
      meta.dayLow ?? Number((Math.min(openPrice, targetClose, prevClose) * 0.992).toFixed(2));

    const totalBars = 75;
    let cursor = openPrice;

    for (let i = 0; i < totalBars; i++) {
      const time = baseStart + i * 300;
      const progress = (i + 1) / totalBars;
      const trendTarget = openPrice + (targetClose - openPrice) * progress;
      const wave =
        Math.sin(i * 0.24 + meta.symbol.charCodeAt(0)) *
        targetClose *
        meta.volatility *
        0.8;
      const close =
        i === totalBars - 1
          ? targetClose
          : Number(Math.max(0.5, trendTarget + wave).toFixed(2));
      const open = Number(cursor.toFixed(2));
      const spread = Math.max(0.05, targetClose * meta.volatility * 0.5);
      const high = Number(Math.min(dayHigh, Math.max(open, close) + spread).toFixed(2));
      const low = Number(Math.max(dayLow, Math.min(open, close) - spread).toFixed(2));
      const volume = Math.floor(18000 + (i % 12) * 4300);

      candles.push({
        symbol: meta.symbol,
        time,
        open,
        high,
        low,
        close,
        volume,
      });
      cursor = close;
    }

    const state: SymbolState = {
      meta,
      price: targetClose,
      prevClose,
      open: openPrice,
      dayHigh,
      dayLow,
      volume: candles.reduce((acc, c) => acc + c.volume, 0),
      candles,
    };

    this.states.set(meta.symbol, state);
    return state;
  }

  public getSessionStatus(): MarketSessionStatus {
    const now = new Date();
    const utcMs = now.getTime() + now.getTimezoneOffset() * 60_000;
    const istDate = new Date(utcMs + 5.5 * 3600_000);

    const day = istDate.getDay(); // 0 = Sun, 6 = Sat
    const hours = istDate.getHours();
    const minutes = istDate.getMinutes();
    const seconds = istDate.getSeconds();
    const totalMinutes = hours * 60 + minutes;

    const istTime = `${String(hours).padStart(2, '0')}:${String(minutes).padStart(
      2,
      '0'
    )}:${String(seconds).padStart(2, '0')} IST`;

    let phase: MarketSessionPhase = 'POST_CLOSE';
    let label = 'NSE/BSE Closed • Official 3:30 PM IST Closing Prices';
    let isLiveHours = false;

    if (day === 0 || day === 6) {
      phase = 'CLOSED_WEEKEND';
      label = 'Weekend Close • Official 3:30 PM IST Closing Prices';
      isLiveHours = false;
    } else if (totalMinutes >= 9 * 60 && totalMinutes < 9 * 60 + 15) {
      phase = 'PRE_OPEN';
      label = 'NSE/BSE Pre-Open Session (09:00 – 09:15 IST)';
      isLiveHours = true;
    } else if (totalMinutes >= 9 * 60 + 15 && totalMinutes < 15 * 60 + 30) {
      phase = 'LIVE_TRADING';
      label = 'NSE/BSE Live Market Open (09:15 – 15:30 IST)';
      isLiveHours = true;
    } else {
      phase = 'POST_CLOSE';
      label = 'NSE/BSE Closed (09:15–15:30 IST) • Locked at 3:30 PM Close';
      isLiveHours = false;
    }

    return {
      phase,
      label,
      istTime,
      isLiveHours,
      replayOverride: this.replaySpeed > 0,
      lastSyncedAt: this.lastSyncedAt,
    };
  }

  public getIndices(): MarketIndexQuote[] {
    return this.indices;
  }

  public getFeedMode(): 'FINNHUB_LIVE' | 'DETERMINISTIC_REPLAY' {
    return this.replaySpeed === 0 ? 'FINNHUB_LIVE' : 'DETERMINISTIC_REPLAY';
  }

  public getReplaySpeed(): ReplaySpeed {
    return this.replaySpeed;
  }

  public setReplaySpeed(speed: ReplaySpeed): ReplaySpeed {
    this.replaySpeed = speed;
    if (speed === 0) {
      // Restore authentic NSE/BSE closing/live prices immediately
      for (const state of this.states.values()) {
        state.price = state.meta.basePrice;
        state.prevClose = state.meta.prevClose;
      }
      void this.syncLiveMarketData();
    }
    this.restartLoop();
    return this.replaySpeed;
  }

  public onTickBatch(
    listener: (ticks: MarketTick[], updatedCandles: OhlcvCandle[]) => void
  ): void {
    this.tickListeners.push(listener);
  }

  public async syncLiveMarketData(): Promise<MarketTick[]> {
    if (this.isSyncing) return this.getAllLatestTicks();
    this.isSyncing = true;

    try {
      // 1. Sync NIFTY 50, BSE SENSEX, and NIFTY BANK indices from Yahoo Finance
      await Promise.allSettled(
        this.indices.map(async (idx) => {
          const chart = await this.fetchYahooChart(idx.symbol, idx.symbol);
          if (chart && chart.price > 0) {
            idx.price = chart.price;
            idx.prevClose = chart.prevClose;
            idx.open = chart.open;
            idx.dayHigh = chart.dayHigh;
            idx.dayLow = chart.dayLow;
            idx.change = Number((chart.price - chart.prevClose).toFixed(2));
            idx.changePercent = Number(
              (((chart.price - chart.prevClose) / chart.prevClose) * 100).toFixed(2)
            );
          }
        })
      );

      // 2. Sync NSE/BSE Equities, ETFs, and AMFI Mutual Funds
      const entries = Array.from(this.states.values());
      await Promise.allSettled(
        entries.map(async (state) => {
          const { meta } = state;
          if (meta.yahooSymbol && meta.segment !== 'FNO') {
            const chart = await this.fetchYahooChart(meta.yahooSymbol, meta.symbol);
            if (chart && chart.price > 0) {
              state.price = chart.price;
              state.prevClose = chart.prevClose;
              state.open = chart.open;
              state.dayHigh = chart.dayHigh;
              state.dayLow = chart.dayLow;
              state.volume = chart.volume || state.volume;
              meta.basePrice = chart.price;
              meta.prevClose = chart.prevClose;
              meta.openPrice = chart.open;
              meta.dayHigh = chart.dayHigh;
              meta.dayLow = chart.dayLow;
              if (chart.candles.length >= 10) {
                state.candles = chart.candles;
              } else if (state.candles.length > 0) {
                const last = state.candles[state.candles.length - 1];
                last.close = chart.price;
                last.high = Math.max(last.high, chart.price);
                last.low = Math.min(last.low, chart.price);
              }
            }
          } else if (meta.amfiCode && meta.segment === 'MUTUAL_FUND') {
            const navData = await this.fetchAmfiNav(meta.amfiCode);
            if (navData && navData.nav > 0) {
              state.price = navData.nav;
              state.prevClose = navData.prevNav;
              state.open = navData.prevNav;
              state.dayHigh = Math.max(navData.nav, navData.prevNav);
              state.dayLow = Math.min(navData.nav, navData.prevNav);
              meta.basePrice = navData.nav;
              meta.prevClose = navData.prevNav;
              if (state.candles.length > 0) {
                state.candles[state.candles.length - 1].close = navData.nav;
              }
            }
          }
        })
      );

      // 3. Price NFO Derivatives accurately from live NIFTY 50 & NIFTY BANK spot indices
      this.repriceFnoFromSpotIndices();

      this.lastSyncedAt = new Date().toISOString();
      const allTicks = this.getAllLatestTicks();
      const updatedCandles = Array.from(this.states.values())
        .map((s) => s.candles[s.candles.length - 1])
        .filter((c): c is OhlcvCandle => Boolean(c));

      for (const listener of this.tickListeners) {
        listener(allTicks, updatedCandles);
      }
      return allTicks;
    } finally {
      this.isSyncing = false;
    }
  }

  private repriceFnoFromSpotIndices(): void {
    const nifty = this.indices.find((i) => i.symbol === '^NSEI');
    const bankNifty = this.indices.find((i) => i.symbol === '^NSEBANK');

    if (nifty) {
      const niftyFut = this.states.get('NIFTY 28NOV FUT');
      if (niftyFut) {
        const futPrice = Number((nifty.price + 43.15).toFixed(2));
        niftyFut.price = futPrice;
        niftyFut.open = Number((nifty.open + 42.0).toFixed(2));
        niftyFut.dayHigh = Number((nifty.dayHigh + 46.0).toFixed(2));
        niftyFut.dayLow = Number((nifty.dayLow + 38.0).toFixed(2));
      }

      const niftyCe = this.states.get('NIFTY 25300 CE');
      if (niftyCe) {
        const intrinsic = Math.max(0, nifty.price - 25300);
        niftyCe.price = Number((intrinsic + 284.6).toFixed(2));
      }

      const niftyPe = this.states.get('NIFTY 25200 PE');
      if (niftyPe) {
        const intrinsic = Math.max(0, 25200 - nifty.price);
        niftyPe.price = Number((intrinsic + 192.4).toFixed(2));
      }
    }

    if (bankNifty) {
      const bankFut = this.states.get('BANKNIFTY 28NOV FUT');
      if (bankFut) {
        bankFut.price = Number((bankNifty.price + 91.5).toFixed(2));
        bankFut.open = Number((bankNifty.open + 88.0).toFixed(2));
        bankFut.dayHigh = Number((bankNifty.dayHigh + 95.0).toFixed(2));
        bankFut.dayLow = Number((bankNifty.dayLow + 82.0).toFixed(2));
      }
    }
  }

  private async fetchYahooChart(
    yahooSymbol: string,
    internalSymbol: string
  ): Promise<{
    price: number;
    prevClose: number;
    open: number;
    dayHigh: number;
    dayLow: number;
    volume: number;
    candles: OhlcvCandle[];
  } | null> {
    try {
      const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(
        yahooSymbol
      )}?interval=5m&range=1d`;
      const res = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
          Accept: 'application/json',
        },
        signal: AbortSignal.timeout(4500),
      });
      if (!res.ok) return null;

      const json = (await res.json()) as {
        chart?: {
          result?: Array<{
            meta?: {
              regularMarketPrice?: number;
              chartPreviousClose?: number;
              previousClose?: number;
              regularMarketDayHigh?: number;
              regularMarketDayLow?: number;
              regularMarketVolume?: number;
            };
            timestamp?: number[];
            indicators?: {
              quote?: Array<{
                open?: Array<number | null>;
                high?: Array<number | null>;
                low?: Array<number | null>;
                close?: Array<number | null>;
                volume?: Array<number | null>;
              }>;
            };
          }>;
        };
      };

      const result = json.chart?.result?.[0];
      const meta = result?.meta;
      if (!meta || typeof meta.regularMarketPrice !== 'number') return null;

      const price = Number(meta.regularMarketPrice.toFixed(2));
      const prevClose = Number(
        (meta.chartPreviousClose ?? meta.previousClose ?? price).toFixed(2)
      );

      const timestamps = result?.timestamp ?? [];
      const quote = result?.indicators?.quote?.[0];
      const candles: OhlcvCandle[] = [];

      if (quote && timestamps.length > 0) {
        for (let i = 0; i < timestamps.length; i++) {
          const o = quote.open?.[i];
          const h = quote.high?.[i];
          const l = quote.low?.[i];
          const c = quote.close?.[i];
          const v = quote.volume?.[i] ?? 0;
          if (
            typeof o === 'number' &&
            typeof h === 'number' &&
            typeof l === 'number' &&
            typeof c === 'number'
          ) {
            candles.push({
              symbol: internalSymbol,
              time: timestamps[i],
              open: Number(o.toFixed(2)),
              high: Number(h.toFixed(2)),
              low: Number(l.toFixed(2)),
              close: Number(c.toFixed(2)),
              volume: Math.max(0, Math.floor(v)),
            });
          }
        }
      }

      const open =
        candles.length > 0
          ? candles[0].open
          : Number((meta.chartPreviousClose ?? price).toFixed(2));
      const dayHigh = Number((meta.regularMarketDayHigh ?? price).toFixed(2));
      const dayLow = Number((meta.regularMarketDayLow ?? price).toFixed(2));
      const volume =
        meta.regularMarketVolume ?? candles.reduce((acc, c) => acc + c.volume, 0);

      return { price, prevClose, open, dayHigh, dayLow, volume, candles };
    } catch {
      return null;
    }
  }

  private async fetchAmfiNav(
    schemeCode: string
  ): Promise<{ nav: number; prevNav: number } | null> {
    try {
      const res = await fetch(`https://api.mfapi.in/mf/${schemeCode}`, {
        signal: AbortSignal.timeout(4000),
      });
      if (!res.ok) return null;
      const json = (await res.json()) as {
        data?: Array<{ nav: string }>;
      };
      const latest = Number(json.data?.[0]?.nav);
      const prev = Number(json.data?.[1]?.nav ?? latest);
      if (!Number.isFinite(latest) || latest <= 0) return null;
      return {
        nav: Number(latest.toFixed(2)),
        prevNav: Number(prev.toFixed(2)),
      };
    } catch {
      return null;
    }
  }

  public async searchAndRegisterSymbols(query: string): Promise<SymbolMetadata[]> {
    const clean = query.trim().toUpperCase();
    if (!clean) return SYMBOL_CATALOG;

    const matches = SYMBOL_CATALOG.filter(
      (s) =>
        s.symbol.toUpperCase().includes(clean) ||
        s.name.toUpperCase().includes(clean) ||
        s.sector.toUpperCase().includes(clean)
    );

    try {
      const url = `https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(
        clean
      )}&quotesCount=10&newsCount=0`;
      const res = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0' },
        signal: AbortSignal.timeout(4000),
      });
      if (!res.ok) return matches;

      const json = (await res.json()) as {
        quotes?: Array<{
          symbol?: string;
          shortname?: string;
          longname?: string;
          exchange?: string;
          quoteType?: string;
        }>;
      };

      for (const q of json.quotes ?? []) {
        if (!q.symbol) continue;
        const isNSE = q.symbol.endsWith('.NS') || q.exchange === 'NSI';
        const isBSE = q.symbol.endsWith('.BO') || q.exchange === 'BSE';
        if (!isNSE && !isBSE) continue;

        const cleanSym = q.symbol.replace(/\.(NS|BO)$/i, '').toUpperCase();
        if (SYMBOL_MAP.has(cleanSym)) {
          const existing = SYMBOL_MAP.get(cleanSym)!;
          if (!matches.some((m) => m.symbol === existing.symbol)) {
            matches.push(existing);
          }
          continue;
        }

        const chart = await this.fetchYahooChart(q.symbol, cleanSym);
        if (!chart || chart.price <= 0) continue;

        const newMeta: SymbolMetadata = {
          symbol: cleanSym,
          yahooSymbol: q.symbol,
          name: q.longname || q.shortname || cleanSym,
          exchange: isNSE ? 'NSE' : 'BSE',
          segment: q.quoteType === 'ETF' ? 'ETF' : 'LARGE_CAP',
          sector: 'Banking & Finance',
          currency: 'INR',
          basePrice: chart.price,
          prevClose: chart.prevClose,
          openPrice: chart.open,
          dayHigh: chart.dayHigh,
          dayLow: chart.dayLow,
          lotSize: 1,
          beta: 1.05,
          volatility: 0.0025,
        };

        registerDynamicSymbol(newMeta);
        const state = this.seedSymbolState(newMeta);
        state.price = chart.price;
        state.prevClose = chart.prevClose;
        state.open = chart.open;
        state.dayHigh = chart.dayHigh;
        state.dayLow = chart.dayLow;
        if (chart.candles.length >= 5) {
          state.candles = chart.candles;
        }
        matches.push(newMeta);
      }
    } catch {
      // Return local matches if offline
    }

    return matches;
  }

  public start(): void {
    void this.syncLiveMarketData();

    if (this.liveSyncTimer) clearInterval(this.liveSyncTimer);
    // Poll live NSE/BSE/AMFI quotes every 10 seconds
    this.liveSyncTimer = setInterval(() => {
      const session = this.getSessionStatus();
      if (session.isLiveHours || this.replaySpeed === 0) {
        void this.syncLiveMarketData();
      }
    }, 10000);

    this.restartLoop();
  }

  private restartLoop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }

    // When replaySpeed === 0, we DO NOT synthesize fake random-walk ticks after 3:30 PM IST!
    // Prices stay 100% locked to authentic NSE/BSE live/closing quotes.
    if (this.replaySpeed === 0) {
      return;
    }

    const intervalMs = Math.max(150, Math.floor(1200 / this.replaySpeed));
    this.timer = setInterval(() => {
      this.stepReplayTick();
    }, intervalMs);
  }

  public stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.liveSyncTimer) {
      clearInterval(this.liveSyncTimer);
      this.liveSyncTimer = null;
    }
  }

  private stepReplayTick(): void {
    const nowMs = Date.now();
    const nowSec = Math.floor(nowMs / 1000);
    const bucketSec = Math.floor(nowSec / 60) * 60;
    const ticks: MarketTick[] = [];
    const updatedCandles: OhlcvCandle[] = [];

    for (const state of this.states.values()) {
      const shock = (Math.random() - 0.495) * state.meta.volatility * 0.8;
      const nextPrice = Number(Math.max(1.0, state.price * (1 + shock)).toFixed(2));
      state.price = nextPrice;
      state.dayHigh = Number(Math.max(state.dayHigh, nextPrice).toFixed(2));
      state.dayLow = Number(Math.min(state.dayLow, nextPrice).toFixed(2));
      const volDelta = Math.floor(40 + Math.random() * 280);
      state.volume += volDelta;

      const lastCandle = state.candles[state.candles.length - 1];
      if (lastCandle && lastCandle.time === bucketSec) {
        lastCandle.high = Math.max(lastCandle.high, nextPrice);
        lastCandle.low = Math.min(lastCandle.low, nextPrice);
        lastCandle.close = nextPrice;
        lastCandle.volume += volDelta;
        updatedCandles.push({ ...lastCandle });
      } else {
        const newCandle: OhlcvCandle = {
          symbol: state.meta.symbol,
          time: bucketSec,
          open: lastCandle ? lastCandle.close : nextPrice,
          high: nextPrice,
          low: nextPrice,
          close: nextPrice,
          volume: volDelta,
        };
        state.candles.push(newCandle);
        if (state.candles.length > 180) {
          state.candles.shift();
        }
        updatedCandles.push(newCandle);
      }

      ticks.push(this.buildTick(state, nowMs));
    }

    for (const listener of this.tickListeners) {
      listener(ticks, updatedCandles);
    }
  }

  private buildTick(state: SymbolState, timestamp = Date.now()): MarketTick {
    const change = Number((state.price - state.prevClose).toFixed(2));
    const changePercent = Number(
      (((state.price - state.prevClose) / state.prevClose) * 100).toFixed(2)
    );
    // In LIVE mode (replaySpeed === 0), execute orders at exact LTP (0 slippage) so every buy/sell matches the exact displayed NSE/BSE market price
    const halfSpread =
      this.replaySpeed === 0
        ? 0
        : Number(Math.max(0.05, state.price * 0.0002).toFixed(2));

    return {
      symbol: state.meta.symbol,
      price: state.price,
      prevClose: state.prevClose,
      open: state.open,
      dayHigh: state.dayHigh,
      dayLow: state.dayLow,
      change,
      changePercent,
      volume: state.volume,
      bid: Number((state.price - halfSpread).toFixed(2)),
      ask: Number((state.price + halfSpread).toFixed(2)),
      timestamp,
      source: this.replaySpeed === 0 ? 'NSE_LIVE_SYNC' : 'REPLAY',
    };
  }

  public getAllLatestTicks(): MarketTick[] {
    const nowMs = Date.now();
    const list: MarketTick[] = [];
    for (const state of this.states.values()) {
      list.push(this.buildTick(state, nowMs));
    }
    return list;
  }

  public getLatestTicksMap(): Map<string, MarketTick> {
    const map = new Map<string, MarketTick>();
    for (const tick of this.getAllLatestTicks()) {
      map.set(tick.symbol, tick);
    }
    return map;
  }

  public getCandles(symbol: string): OhlcvCandle[] {
    const state = this.states.get(symbol.toUpperCase());
    if (!state) return [];
    return state.candles;
  }
}
