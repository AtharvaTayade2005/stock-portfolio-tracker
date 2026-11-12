export type MarketExchange = 'NSE' | 'BSE' | 'NFO' | 'AMFI';

export type InstrumentSegment =
  | 'LARGE_CAP'
  | 'MID_CAP'
  | 'SMALL_CAP'
  | 'FNO'
  | 'ETF'
  | 'MUTUAL_FUND';

export interface SymbolMetadata {
  symbol: string;
  name: string;
  exchange: MarketExchange;
  segment: InstrumentSegment;
  sector:
    | 'Banking & Finance'
    | 'IT Services'
    | 'Energy & Conglomerate'
    | 'Auto & Engineering'
    | 'Consumer & Electronics'
    | 'Capital Markets'
    | 'Index Derivatives'
    | 'Passive ETF'
    | 'Equity Mutual Fund';
  currency: 'INR';
  basePrice: number; // Price in ₹ (INR)
  lotSize: number; // 1 for Cash/ETF/MF; 15/25/250 for NSE F&O
  beta: number;
  volatility: number;
  expiry?: string;
  derivativeType?: 'FUT' | 'CE' | 'PE';
}

export interface MarketTick {
  symbol: string;
  price: number;
  prevClose: number;
  change: number;
  changePercent: number;
  volume: number;
  bid: number;
  ask: number;
  timestamp: number;
  source: 'REPLAY' | 'FINNHUB_LIVE';
}

export interface OhlcvCandle {
  symbol: string;
  time: number; // Unix timestamp in seconds (bucketed to 60s)
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export type ReplaySpeed = 0 | 1 | 5 | 10;

export type OrderSide = 'BUY' | 'SELL';

export interface OrderRequest {
  symbol: string;
  side: OrderSide;
  quantity: number;
  idempotencyKey: string;
}

export interface OrderRecord {
  id: number;
  idempotencyKey: string;
  symbol: string;
  side: OrderSide;
  quantity: number;
  executionPrice: number;
  totalNotional: number;
  realizedPnl: number;
  createdAt: string;
}

export interface TaxLot {
  id: number;
  symbol: string;
  initialQty: number;
  remainingQty: number;
  buyPrice: number;
  acquiredAt: string;
}

export interface HoldingPosition {
  symbol: string;
  name: string;
  segment: InstrumentSegment;
  sector: SymbolMetadata['sector'];
  exchange: MarketExchange;
  lotSize: number;
  beta: number;
  quantity: number;
  avgCostBasis: number; // FIFO weighted average of remaining open lots
  currentPrice: number;
  marketValue: number;
  totalCost: number;
  unrealizedPnl: number;
  unrealizedPnlPercent: number;
  dayChangePercent: number;
  weightPercent: number;
  openLotsCount: number;
}

export interface SectorAllocation {
  sector: string;
  marketValue: number;
  weightPercent: number;
}

export interface SegmentAllocation {
  segment: InstrumentSegment;
  label: string;
  marketValue: number;
  unrealizedPnl: number;
  weightPercent: number;
}

export interface PortfolioSnapshot {
  cashBalance: number;
  holdingsMarketValue: number;
  totalEquity: number;
  totalCostBasis: number;
  totalUnrealizedPnl: number;
  totalUnrealizedPnlPercent: number;
  totalRealizedPnl: number;
  portfolioBeta: number;
  holdings: HoldingPosition[];
  sectorAllocations: SectorAllocation[];
  segmentAllocations: SegmentAllocation[];
  recentOrders: OrderRecord[];
  openTaxLots: TaxLot[];
}

export type AlertDirection = 'ABOVE' | 'BELOW';
export type AlertStatus = 'ACTIVE' | 'TRIGGERED';

export interface PriceAlert {
  id: number;
  symbol: string;
  direction: AlertDirection;
  targetPrice: number;
  status: AlertStatus;
  note: string;
  createdAt: string;
  triggeredAt: string | null;
  triggeredPrice: number | null;
}

export interface NewsItem {
  id: string;
  symbol: string;
  headline: string;
  summary: string;
  source: string;
  publishedAt: string;
  sentiment: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
  impactScore: number; // 1 to 10
}

export interface IndicatorPoint {
  time: number;
  sma20: number | null;
  sma50: number | null;
  ema12: number | null;
  ema26: number | null;
  rsi14: number | null;
  bbUpper: number | null;
  bbMiddle: number | null;
  bbLower: number | null;
}

export interface IndicatorSummary {
  symbol: string;
  latestClose: number;
  sma20: number | null;
  sma50: number | null;
  ema12: number | null;
  ema26: number | null;
  rsi14: number | null;
  bbUpper: number | null;
  bbMiddle: number | null;
  bbLower: number | null;
  bbPercentB: number | null;
  bbBandwidthPercent: number | null;
  signal: 'OVERBOUGHT' | 'OVERSOLD' | 'BULLISH_TREND' | 'BEARISH_TREND' | 'NEUTRAL';
  computeTimeMs: number;
  points: IndicatorPoint[];
}

export interface StressScenarioImpact {
  scenarioName: string;
  estimatedPnlImpact: number;
  estimatedPnlPercent: number;
  mostVulnerableSymbol: string;
  explanation: string;
}

export interface AiCopilotAnalysis {
  engineMode: 'GEMINI_LIVE' | 'DETERMINISTIC_QUANT_FALLBACK';
  modelUsed: string;
  generatedAt: string;
  riskScore: number; // 1 (Low) to 100 (Extreme)
  riskLabel: 'CONSERVATIVE' | 'MODERATE' | 'AGGRESSIVE' | 'CONCENTRATED_HIGH_BETA';
  executiveSummary: string;
  concentrationFindings: string[];
  newsCorrelations: Array<{
    symbol: string;
    sentiment: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
    portfolioWeightPercent: number;
    thesis: string;
  }>;
  stressTestScenarios: StressScenarioImpact[];
  actionableRebalancing: string[];
  queryAnswer?: string;
}

export type WsServerMessage =
  | {
      type: 'INITIAL_STATE';
      ticks: MarketTick[];
      replaySpeed: ReplaySpeed;
      feedMode: 'REPLAY' | 'FINNHUB_LIVE';
    }
  | { type: 'TICK_BATCH'; ticks: MarketTick[]; updatedCandles: OhlcvCandle[] }
  | { type: 'ALERT_TRIGGERED'; alert: PriceAlert; tick: MarketTick }
  | { type: 'REPLAY_SPEED_CHANGED'; replaySpeed: ReplaySpeed };
