export type MarketExchange = 'NSE' | 'BSE' | 'NFO' | 'MCX' | 'AMFI';

export type InstrumentSegment =
  | 'LARGE_CAP'
  | 'MID_CAP'
  | 'SMALL_CAP'
  | 'COMMODITY'
  | 'FNO'
  | 'ETF'
  | 'MUTUAL_FUND';

export type BrokerSource =
  | 'KitePulse Direct'
  | 'SBI Securities'
  | 'HDFC Sky'
  | 'Groww'
  | 'Zerodha Kite'
  | 'Angel One';

export type MarketSessionPhase = 'PRE_OPEN' | 'LIVE_TRADING' | 'POST_CLOSE' | 'CLOSED_WEEKEND';

export interface MarketSessionStatus {
  phase: MarketSessionPhase;
  label: string;
  istTime: string;
  isLiveHours: boolean; // true during 09:15 - 15:30 IST Mon-Fri
  replayOverride: boolean;
  lastSyncedAt: string;
}

export interface MarketIndexQuote {
  symbol: string;
  name: string;
  price: number;
  prevClose: number;
  open: number;
  dayHigh: number;
  dayLow: number;
  change: number;
  changePercent: number;
}

export interface SymbolMetadata {
  symbol: string;
  yahooSymbol?: string;
  amfiCode?: string;
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
    | 'Equity Mutual Fund'
    | 'Gold, Silver & Commodities';
  currency: 'INR';
  basePrice: number; // Real 3:30 PM closing price in ₹ (INR)
  prevClose: number; // Real previous session closing price in ₹ (INR)
  openPrice?: number;
  dayHigh?: number;
  dayLow?: number;
  lotSize: number; // 1 for Cash/ETF/MF; 15/25/250 for NSE F&O
  beta: number;
  volatility: number;
  expiry?: string;
  derivativeType?: 'FUT' | 'CE' | 'PE';
  strikePrice?: number;
}

export interface MarketTick {
  symbol: string;
  price: number;
  prevClose: number;
  open: number;
  dayHigh: number;
  dayLow: number;
  change: number;
  changePercent: number;
  volume: number;
  bid: number;
  ask: number;
  timestamp: number;
  source: 'NSE_LIVE_SYNC' | 'REPLAY' | 'FINNHUB_LIVE';
}

export interface OhlcvCandle {
  symbol: string;
  time: number; // Unix timestamp in seconds
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
  brokerSource?: BrokerSource;
  useThreeInOneBankId?: number;
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
  brokerSource: BrokerSource;
  createdAt: string;
}

export interface TaxLot {
  id: number;
  symbol: string;
  initialQty: number;
  remainingQty: number;
  buyPrice: number;
  brokerSource: BrokerSource;
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
  prevClose: number;
  openPrice: number;
  dayHigh: number;
  dayLow: number;
  marketValue: number;
  totalCost: number;
  unrealizedPnl: number;
  unrealizedPnlPercent: number;
  dayChange: number;
  dayChangePercent: number;
  weightPercent: number;
  openLotsCount: number;
  brokers: BrokerSource[];
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

export interface BankAccount {
  id: number;
  bankName: string;
  accountNumberMasked: string;
  ifscCode: string;
  upiId: string;
  balance: number;
  isPrimaryThreeInOne: boolean;
}

export interface BankTransaction {
  id: number;
  bankAccountId: number;
  bankName: string;
  type: 'DEPOSIT_TO_DEMAT' | 'WITHDRAW_TO_BANK' | 'THREE_IN_ONE_BUY_DEBIT' | 'THREE_IN_ONE_SELL_CREDIT';
  method: 'UPI' | 'NETBANKING' | 'IMPS' | 'ASBA_3IN1';
  amount: number;
  referenceNote: string;
  createdAt: string;
}

export interface ExternalHoldingImportItem {
  symbol: string;
  quantity: number;
  buyPrice: number;
  brokerSource: BrokerSource;
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
  bankAccounts: BankAccount[];
  bankTransactions: BankTransaction[];
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
  impactScore: number;
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

export interface RagContextChunk {
  chunkId: string;
  sourceTable: string;
  title: string;
  similarityScore: number;
  content: string;
}

export interface CopilotProposedAction {
  symbol: string;
  side: OrderSide;
  quantity: number;
  rationale: string;
}

export interface AiCopilotAnalysis {
  engineMode: 'GEMINI_LIVE' | 'DETERMINISTIC_QUANT_FALLBACK';
  modelUsed: string;
  generatedAt: string;
  riskScore: number;
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
  ragChunksUsed?: RagContextChunk[];
  proposedActions?: CopilotProposedAction[];
}

export type WsServerMessage =
  | {
      type: 'INITIAL_STATE';
      ticks: MarketTick[];
      indices: MarketIndexQuote[];
      session: MarketSessionStatus;
      replaySpeed: ReplaySpeed;
    }
  | {
      type: 'TICK_BATCH';
      ticks: MarketTick[];
      indices: MarketIndexQuote[];
      session: MarketSessionStatus;
      updatedCandles: OhlcvCandle[];
    }
  | { type: 'ALERT_TRIGGERED'; alert: PriceAlert; tick: MarketTick }
  | { type: 'REPLAY_SPEED_CHANGED'; replaySpeed: ReplaySpeed; session: MarketSessionStatus };
