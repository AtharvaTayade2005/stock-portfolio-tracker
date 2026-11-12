import type { IndicatorPoint, IndicatorSummary, OhlcvCandle } from './types.js';

/**
 * Computes Simple Moving Average (SMA) in O(N) time using a sliding window sum.
 * Avoids naive O(N * period) nested loop summation.
 */
export function computeSMA(closes: number[], period: number): Array<number | null> {
  const result: Array<number | null> = new Array(closes.length).fill(null);
  if (period <= 0 || closes.length < period) return result;

  let windowSum = 0;
  for (let i = 0; i < closes.length; i++) {
    windowSum += closes[i];
    if (i >= period) {
      windowSum -= closes[i - period];
    }
    if (i >= period - 1) {
      result[i] = Number((windowSum / period).toFixed(4));
    }
  }
  return result;
}

/**
 * Computes Exponential Moving Average (EMA) in O(N) time.
 * Multiplier k = 2 / (period + 1), seeded by the initial `period` SMA.
 */
export function computeEMA(closes: number[], period: number): Array<number | null> {
  const result: Array<number | null> = new Array(closes.length).fill(null);
  if (period <= 0 || closes.length < period) return result;

  const k = 2 / (period + 1);
  let initialSum = 0;
  for (let i = 0; i < period; i++) {
    initialSum += closes[i];
  }

  let prevEma = initialSum / period;
  result[period - 1] = Number(prevEma.toFixed(4));

  for (let i = period; i < closes.length; i++) {
    const currentEma = (closes[i] - prevEma) * k + prevEma;
    result[i] = Number(currentEma.toFixed(4));
    prevEma = currentEma;
  }
  return result;
}

/**
 * Computes J. Welles Wilder's Relative Strength Index (RSI) in O(N) time.
 * Formula:
 *   RS = SmoothedAvgGain / SmoothedAvgLoss
 *   RSI = 100 - (100 / (1 + RS))
 */
export function computeWilderRSI(closes: number[], period = 14): Array<number | null> {
  const result: Array<number | null> = new Array(closes.length).fill(null);
  if (closes.length <= period) return result;

  let gainSum = 0;
  let lossSum = 0;

  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) gainSum += diff;
    else lossSum += Math.abs(diff);
  }

  let avgGain = gainSum / period;
  let avgLoss = lossSum / period;

  const calcRsi = (gain: number, loss: number): number => {
    if (loss === 0) return 100;
    const rs = gain / loss;
    return Number((100 - 100 / (1 + rs)).toFixed(2));
  };

  result[period] = calcRsi(avgGain, avgLoss);

  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    const currentGain = diff > 0 ? diff : 0;
    const currentLoss = diff < 0 ? Math.abs(diff) : 0;

    avgGain = (avgGain * (period - 1) + currentGain) / period;
    avgLoss = (avgLoss * (period - 1) + currentLoss) / period;

    result[i] = calcRsi(avgGain, avgLoss);
  }

  return result;
}

/**
 * Computes Bollinger Bands (Middle = 20-period SMA, Upper = SMA + 2*sigma, Lower = SMA - 2*sigma).
 * Uses two-pass window deviation around the sliding mean to avoid floating-point cancellation on high-priced stocks.
 */
export function computeBollingerBands(
  closes: number[],
  period = 20,
  multiplier = 2
): {
  upper: Array<number | null>;
  middle: Array<number | null>;
  lower: Array<number | null>;
} {
  const upper: Array<number | null> = new Array(closes.length).fill(null);
  const middle = computeSMA(closes, period);
  const lower: Array<number | null> = new Array(closes.length).fill(null);

  if (closes.length < period) {
    return { upper, middle, lower };
  }

  for (let i = period - 1; i < closes.length; i++) {
    const mean = middle[i]!;
    let sumSqDiff = 0;
    for (let j = i - period + 1; j <= i; j++) {
      const diff = closes[j] - mean;
      sumSqDiff += diff * diff;
    }
    const stdDev = Math.sqrt(sumSqDiff / period);
    upper[i] = Number((mean + multiplier * stdDev).toFixed(4));
    lower[i] = Number((mean - multiplier * stdDev).toFixed(4));
  }

  return { upper, middle, lower };
}

/**
 * Master indicator pipeline invoked inside the Browser Web Worker (or server tests).
 */
export function computeAllIndicators(symbol: string, candles: OhlcvCandle[]): IndicatorSummary {
  const start = performance.now();
  const closes = candles.map((c) => c.close);

  const sma20 = computeSMA(closes, 20);
  const sma50 = computeSMA(closes, 50);
  const ema12 = computeEMA(closes, 12);
  const ema26 = computeEMA(closes, 26);
  const rsi14 = computeWilderRSI(closes, 14);
  const bb = computeBollingerBands(closes, 20, 2);

  const points: IndicatorPoint[] = candles.map((c, idx) => ({
    time: c.time,
    sma20: sma20[idx],
    sma50: sma50[idx],
    ema12: ema12[idx],
    ema26: ema26[idx],
    rsi14: rsi14[idx],
    bbUpper: bb.upper[idx],
    bbMiddle: bb.middle[idx],
    bbLower: bb.lower[idx],
  }));

  const lastIdx = candles.length - 1;
  const latestClose = lastIdx >= 0 ? candles[lastIdx].close : 0;
  const latestSma20 = lastIdx >= 0 ? sma20[lastIdx] : null;
  const latestSma50 = lastIdx >= 0 ? sma50[lastIdx] : null;
  const latestEma12 = lastIdx >= 0 ? ema12[lastIdx] : null;
  const latestEma26 = lastIdx >= 0 ? ema26[lastIdx] : null;
  const latestRsi14 = lastIdx >= 0 ? rsi14[lastIdx] : null;
  const latestBbUpper = lastIdx >= 0 ? bb.upper[lastIdx] : null;
  const latestBbMiddle = lastIdx >= 0 ? bb.middle[lastIdx] : null;
  const latestBbLower = lastIdx >= 0 ? bb.lower[lastIdx] : null;

  let bbPercentB: number | null = null;
  let bbBandwidthPercent: number | null = null;

  if (
    latestBbUpper !== null &&
    latestBbLower !== null &&
    latestBbMiddle !== null &&
    latestBbUpper > latestBbLower &&
    latestBbMiddle > 0
  ) {
    bbPercentB = Number(
      ((latestClose - latestBbLower) / (latestBbUpper - latestBbLower)).toFixed(3)
    );
    bbBandwidthPercent = Number(
      (((latestBbUpper - latestBbLower) / latestBbMiddle) * 100).toFixed(2)
    );
  }

  let signal: IndicatorSummary['signal'] = 'NEUTRAL';
  if (latestRsi14 !== null && latestRsi14 >= 70) {
    signal = 'OVERBOUGHT';
  } else if (latestRsi14 !== null && latestRsi14 <= 30) {
    signal = 'OVERSOLD';
  } else if (latestSma20 !== null && latestSma50 !== null && latestSma20 > latestSma50) {
    signal = 'BULLISH_TREND';
  } else if (latestSma20 !== null && latestSma50 !== null && latestSma20 < latestSma50) {
    signal = 'BEARISH_TREND';
  }

  const computeTimeMs = Number((performance.now() - start).toFixed(2));

  return {
    symbol,
    latestClose,
    sma20: latestSma20,
    sma50: latestSma50,
    ema12: latestEma12,
    ema26: latestEma26,
    rsi14: latestRsi14,
    bbUpper: latestBbUpper,
    bbMiddle: latestBbMiddle,
    bbLower: latestBbLower,
    bbPercentB,
    bbBandwidthPercent,
    signal,
    computeTimeMs,
    points,
  };
}
