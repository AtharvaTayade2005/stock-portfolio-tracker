import { computeAllIndicators } from '../../shared/indicators.js';
import type { OhlcvCandle } from '../../shared/types.js';

export interface WorkerRequestMessage {
  symbol: string;
  candles: OhlcvCandle[];
}

self.onmessage = (event: MessageEvent<WorkerRequestMessage>) => {
  const { symbol, candles } = event.data;
  if (!symbol || !Array.isArray(candles)) return;

  const summary = computeAllIndicators(symbol, candles);
  self.postMessage(summary);
};
