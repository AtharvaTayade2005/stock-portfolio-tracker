import { SEGMENT_LABELS } from './catalog.js';
import { computeAllIndicators } from './indicators.js';
import type {
  InstrumentSegment,
  MarketExchange,
  MarketTick,
  OhlcvCandle,
  PortfolioSnapshot,
  SymbolMetadata,
} from './types.js';

export type AllocationDriftStatus = 'WITHIN_BAND' | 'OVERWEIGHT_DRIFT' | 'UNDERWEIGHT_DRIFT';

export interface SegmentDriftItem {
  segment: InstrumentSegment;
  label: string;
  currentMarketValueINR: number;
  currentWeightPercent: number;
  targetWeightPercent: number;
  driftPercent: number;
  rebalanceDeltaINR: number;
  status: AllocationDriftStatus;
  objectiveNote: string;
}

export interface AllocationDriftReport {
  holdingsMarketValueINR: number;
  driftThresholdPercent: number;
  driftedSegmentsCount: number;
  requiresRebalancing: boolean;
  items: SegmentDriftItem[];
}

export type TechnicalSignalTag =
  | 'EMA_GOLDEN_CROSS'
  | 'EMA_DEATH_CROSS'
  | 'RSI_OVERSOLD_35'
  | 'RSI_OVERBOUGHT_68'
  | 'BOLLINGER_UPPER_BREAK'
  | 'BOLLINGER_LOWER_TOUCH';

export interface TechnicalScannerMatch {
  symbol: string;
  name: string;
  exchange: MarketExchange;
  segment: InstrumentSegment;
  ltp: number;
  changePercent: number;
  sma20: number;
  ema12: number;
  ema26: number;
  rsi14: number;
  bbUpper: number;
  bbLower: number;
  signals: TechnicalSignalTag[];
  regime: 'MOMENTUM_EXPANSION' | 'MEAN_REVERSION_ZONE' | 'NEUTRAL_TREND';
  objectiveSummary: string;
}

export const DEFAULT_TARGET_WEIGHTS: Record<InstrumentSegment, number> = {
  LARGE_CAP: 50,
  MID_CAP: 15,
  SMALL_CAP: 10,
  COMMODITY: 15,
  ETF: 5,
  MUTUAL_FUND: 5,
  FNO: 0,
};

/**
 * Evaluates actual portfolio segment weights against user-defined target allocation bands
 * and flags objective percentage deviations exceeding `driftThresholdPercent`.
 */
export function computeAllocationDriftReport(
  portfolio: PortfolioSnapshot,
  customTargets?: Partial<Record<InstrumentSegment, number>>,
  driftThresholdPercent = 5
): AllocationDriftReport {
  const threshold = Math.max(1, Math.min(25, driftThresholdPercent || 5));
  const valueBySegment = new Map<InstrumentSegment, number>();

  for (const h of portfolio.holdings) {
    valueBySegment.set(h.segment, (valueBySegment.get(h.segment) ?? 0) + h.marketValue);
  }

  const totalHoldings = portfolio.holdingsMarketValue;
  const items: SegmentDriftItem[] = (Object.keys(DEFAULT_TARGET_WEIGHTS) as InstrumentSegment[]).map(
    (segment) => {
      const targetWeightPercent = customTargets?.[segment] ?? DEFAULT_TARGET_WEIGHTS[segment];
      const currentMarketValueINR = Number((valueBySegment.get(segment) ?? 0).toFixed(2));
      const currentWeightPercent =
        totalHoldings > 0 ? Number(((currentMarketValueINR / totalHoldings) * 100).toFixed(2)) : 0;
      const driftPercent = Number((currentWeightPercent - targetWeightPercent).toFixed(2));
      const rebalanceDeltaINR = Number(
        ((targetWeightPercent / 100) * totalHoldings - currentMarketValueINR).toFixed(2)
      );

      let status: AllocationDriftStatus = 'WITHIN_BAND';
      let objectiveNote = `Within ±${threshold}% target band (${currentWeightPercent.toFixed(1)}% vs ${targetWeightPercent}%).`;

      if (totalHoldings === 0) {
        status = 'WITHIN_BAND';
        objectiveNote = `No active holdings deployed yet; target weight configured at ${targetWeightPercent}%.`;
      } else if (driftPercent > threshold) {
        status = 'OVERWEIGHT_DRIFT';
        objectiveNote = `+${driftPercent.toFixed(1)}% above target band; objective delta trims ₹${Math.abs(
          rebalanceDeltaINR
        ).toLocaleString('en-IN')}.`;
      } else if (driftPercent < -threshold) {
        status = 'UNDERWEIGHT_DRIFT';
        objectiveNote = `${driftPercent.toFixed(1)}% below target band; objective delta adds ₹${Math.abs(
          rebalanceDeltaINR
        ).toLocaleString('en-IN')}.`;
      }

      return {
        segment,
        label: SEGMENT_LABELS[segment],
        currentMarketValueINR,
        currentWeightPercent,
        targetWeightPercent,
        driftPercent,
        rebalanceDeltaINR,
        status,
        objectiveNote,
      };
    }
  );

  const driftedSegmentsCount = items.filter((item) => item.status !== 'WITHIN_BAND').length;

  return {
    holdingsMarketValueINR: Number(totalHoldings.toFixed(2)),
    driftThresholdPercent: threshold,
    driftedSegmentsCount,
    requiresRebalancing: totalHoldings > 0 && driftedSegmentsCount > 0,
    items,
  };
}

/**
 * Vectorized non-advisory technical scanner that inspects OHLCV candle series across the catalog
 * to detect EMA(12/26) crossovers, Wilder RSI(14) extremes, and Bollinger Band (20, 2σ) touches.
 */
export function scanCatalogTechnicalSignals(
  symbols: SymbolMetadata[],
  candlesBySymbol: Record<string, OhlcvCandle[]>,
  ticksBySymbol?: Map<string, MarketTick>
): TechnicalScannerMatch[] {
  const matches: TechnicalScannerMatch[] = [];

  for (const sym of symbols) {
    const candles = candlesBySymbol[sym.symbol] || [];
    if (candles.length < 26) continue;

    const summary = computeAllIndicators(sym.symbol, candles);
    const liveTick = ticksBySymbol?.get(sym.symbol);
    const ltp = liveTick ? liveTick.price : summary.latestClose || sym.basePrice;
    const changePercent = liveTick
      ? liveTick.changePercent
      : sym.prevClose > 0
        ? Number((((ltp - sym.prevClose) / sym.prevClose) * 100).toFixed(2))
        : 0;

    const sma20 = summary.sma20 ?? ltp;
    const ema12 = summary.ema12 ?? ltp;
    const ema26 = summary.ema26 ?? ltp;
    const rsi14 = summary.rsi14 ?? 50;
    const bbUpper = summary.bbUpper ?? ltp * 1.02;
    const bbLower = summary.bbLower ?? ltp * 0.98;

    const signals: TechnicalSignalTag[] = [];
    if (ema12 > ema26 && summary.latestClose > sma20) {
      signals.push('EMA_GOLDEN_CROSS');
    } else if (ema12 < ema26 && summary.latestClose < sma20) {
      signals.push('EMA_DEATH_CROSS');
    }

    if (rsi14 <= 35) {
      signals.push('RSI_OVERSOLD_35');
    } else if (rsi14 >= 68) {
      signals.push('RSI_OVERBOUGHT_68');
    }

    if (summary.latestClose >= bbUpper) {
      signals.push('BOLLINGER_UPPER_BREAK');
    } else if (summary.latestClose <= bbLower) {
      signals.push('BOLLINGER_LOWER_TOUCH');
    }

    let regime: TechnicalScannerMatch['regime'] = 'NEUTRAL_TREND';
    if (signals.includes('RSI_OVERSOLD_35') || signals.includes('RSI_OVERBOUGHT_68')) {
      regime = 'MEAN_REVERSION_ZONE';
    } else if (signals.includes('EMA_GOLDEN_CROSS') || signals.includes('BOLLINGER_UPPER_BREAK')) {
      regime = 'MOMENTUM_EXPANSION';
    }

    const objectiveSummary =
      signals.length > 0
        ? `Triggered ${signals.join(', ')} (EMA12 ₹${ema12.toFixed(1)} vs EMA26 ₹${ema26.toFixed(
            1
          )}, RSI ${rsi14.toFixed(1)}).`
        : `Trading inside 2σ Bollinger envelope with neutral RSI (${rsi14.toFixed(1)}).`;

    matches.push({
      symbol: sym.symbol,
      name: sym.name,
      exchange: sym.exchange,
      segment: sym.segment,
      ltp,
      changePercent,
      sma20: Number(sma20.toFixed(2)),
      ema12: Number(ema12.toFixed(2)),
      ema26: Number(ema26.toFixed(2)),
      rsi14: Number(rsi14.toFixed(2)),
      bbUpper: Number(bbUpper.toFixed(2)),
      bbLower: Number(bbLower.toFixed(2)),
      signals,
      regime,
      objectiveSummary,
    });
  }

  return matches.sort((a, b) => {
    if (b.signals.length !== a.signals.length) {
      return b.signals.length - a.signals.length;
    }
    return Math.abs(b.changePercent) - Math.abs(a.changePercent);
  });
}
