import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity,
  AlertTriangle,
  ArrowDownRight,
  ArrowRightLeft,
  ArrowUpRight,
  Bell,
  Building2,
  CheckCircle2,
  Clock,
  CreditCard,
  Download,
  Flame,
  FolderInput,
  Landmark,
  Layers,
  Plus,
  RefreshCw,
  RotateCcw,
  Search,
  ShieldAlert,
  Sparkles,
  TrendingDown,
  TrendingUp,
  Trash2,
  Upload,
  Wallet,
} from 'lucide-react';
import { formatINR, SEGMENT_LABELS } from '../shared/catalog.js';
import type {
  AiCopilotAnalysis,
  AlertDirection,
  BrokerSource,
  ExternalHoldingImportItem,
  IndicatorSummary,
  InstrumentSegment,
  MarketIndexQuote,
  MarketSessionStatus,
  MarketTick,
  NewsItem,
  OhlcvCandle,
  OrderSide,
  PortfolioSnapshot,
  PriceAlert,
  ReplaySpeed,
  SymbolMetadata,
  WsServerMessage,
} from '../shared/types.js';
import { computeAllIndicators } from '../shared/indicators.js';
import {
  calculateIndianStatutoryCharges,
  computeIndianCapitalGainsTax,
  generateMarketDepthLadder,
} from '../shared/indianTaxAndCharges.js';
import { computeQuantRiskMetrics } from '../shared/quantRiskEngine.js';
import { CandlestickChart } from './components/CandlestickChart.js';
import { StepUpSipAndCsvPanel } from './components/StepUpSipAndCsvPanel.js';
import { RebalanceAndScannerPanel } from './components/RebalanceAndScannerPanel.js';
import { PhoneOtpLoginView, type AuthSessionState } from './components/PhoneOtpLoginView.js';

type ActiveTab =
  | 'HOLDINGS_AND_LOTS'
  | 'TERMINAL'
  | 'BANK_AND_FUNDS'
  | 'BROKER_IMPORT'
  | 'TAX_AND_CONTRACT_NOTE'
  | 'MARKET_NEWS'
  | 'AI_COPILOT'
  | 'ALERTS_AND_ORDERS';

const TAB_TO_ROUTE: Record<ActiveTab, string> = {
  HOLDINGS_AND_LOTS: '/portfolio',
  TERMINAL: '/terminal',
  BANK_AND_FUNDS: '/funds',
  BROKER_IMPORT: '/import',
  TAX_AND_CONTRACT_NOTE: '/tax',
  MARKET_NEWS: '/news',
  AI_COPILOT: '/copilot',
  ALERTS_AND_ORDERS: '/orders',
};

const ROUTE_TO_TAB: Record<string, ActiveTab> = {
  '/': 'HOLDINGS_AND_LOTS',
  '/portfolio': 'HOLDINGS_AND_LOTS',
  '/terminal': 'TERMINAL',
  '/funds': 'BANK_AND_FUNDS',
  '/import': 'BROKER_IMPORT',
  '/tax': 'TAX_AND_CONTRACT_NOTE',
  '/news': 'MARKET_NEWS',
  '/copilot': 'AI_COPILOT',
  '/orders': 'ALERTS_AND_ORDERS',
};

type SegmentFilter = 'ALL' | InstrumentSegment;

type RbacRole = 'OWNER_ADMIN' | 'PORTFOLIO_IMPORTER' | 'AUDITOR_READ_ONLY';

interface BrokerNotificationReceipt {
  notificationId: string;
  broker: string;
  cdslBoId: string;
  rbacRole: RbacRole;
  pbkdf2DigestPrefix?: string;
  securityAuditId?: string;
  exportedHoldingsCount: number;
  status: 'BROKER_NOTIFIED_200_OK';
  timestamp: string;
  message: string;
}

export const App: React.FC = () => {
  const [symbols, setSymbols] = useState<SymbolMetadata[]>([]);
  const [ticks, setTicks] = useState<Record<string, MarketTick>>({});
  const [indices, setIndices] = useState<MarketIndexQuote[]>([]);
  const [session, setSession] = useState<MarketSessionStatus | null>(null);
  const [selectedSymbol, setSelectedSymbol] = useState<string>('RELIANCE');
  const [candles, setCandles] = useState<OhlcvCandle[]>([]);
  const [indicators, setIndicators] = useState<IndicatorSummary | null>(null);
  const [portfolio, setPortfolio] = useState<PortfolioSnapshot | null>(null);
  const [alerts, setAlerts] = useState<PriceAlert[]>([]);
  const [news, setNews] = useState<NewsItem[]>([]);
  const [aiAnalysis, setAiAnalysis] = useState<AiCopilotAnalysis | null>(null);

  const [activeTab, setActiveTab] = useState<ActiveTab>(() => {
    const path = typeof window !== 'undefined' ? window.location.pathname : '/portfolio';
    return ROUTE_TO_TAB[path] ?? 'HOLDINGS_AND_LOTS';
  });
  const [isLoginRoute, setIsLoginRoute] = useState<boolean>(() => {
    return typeof window !== 'undefined' && window.location.pathname === '/login';
  });
  const [authSession, setAuthSession] = useState<AuthSessionState | null>(null);

  const navigateToTab = useCallback((tab: ActiveTab) => {
    setIsLoginRoute(false);
    setActiveTab(tab);
    const targetRoute = TAB_TO_ROUTE[tab];
    if (typeof window !== 'undefined' && window.location.pathname !== targetRoute) {
      window.history.pushState({}, '', targetRoute);
    }
  }, []);

  const navigateToLogin = useCallback(() => {
    setIsLoginRoute(true);
    if (typeof window !== 'undefined' && window.location.pathname !== '/login') {
      window.history.pushState({}, '', '/login');
    }
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (window.location.pathname === '/') {
      window.history.replaceState({}, '', '/portfolio');
    }
    const handlePopState = () => {
      const p = window.location.pathname;
      if (p === '/login') {
        setIsLoginRoute(true);
      } else {
        setIsLoginRoute(false);
        setActiveTab(ROUTE_TO_TAB[p] ?? 'HOLDINGS_AND_LOTS');
      }
    };
    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, []);
  const [segmentFilter, setSegmentFilter] = useState<SegmentFilter>('ALL');
  const [brokerFilter, setBrokerFilter] = useState<'ALL' | BrokerSource>('ALL');
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [isSearchingLive, setIsSearchingLive] = useState<boolean>(false);
  const [isSyncingMarket, setIsSyncingMarket] = useState<boolean>(false);
  const [replaySpeed, setReplaySpeed] = useState<ReplaySpeed>(0);
  const [wsConnected, setWsConnected] = useState<boolean>(false);

  // Chart Overlays
  const [showSma, setShowSma] = useState<boolean>(true);
  const [showEma, setShowEma] = useState<boolean>(true);
  const [showBollinger, setShowBollinger] = useState<boolean>(true);

  // Order Ticket State (Bullish BUY = Emerald Green, Bearish SELL = Crimson Red)
  const [orderSide, setOrderSide] = useState<OrderSide>('BUY');
  const [orderQty, setOrderQty] = useState<string>('1');
  const [orderBrokerSource, setOrderBrokerSource] = useState<BrokerSource>('KitePulse Direct');
  const [useThreeInOneAutoDebit, setUseThreeInOneAutoDebit] = useState<boolean>(false);
  const [selectedThreeInOneBankId, setSelectedThreeInOneBankId] = useState<number>(1);
  const [orderStatus, setOrderStatus] = useState<{
    type: 'IDLE' | 'SUBMITTING' | 'SUCCESS' | 'ERROR';
    message: string;
  }>({ type: 'IDLE', message: '' });

  // Bank & 3-in-1 Funds State
  const [transferBankId, setTransferBankId] = useState<number>(1);
  const [transferDirection, setTransferDirection] = useState<
    'DEPOSIT_TO_DEMAT' | 'WITHDRAW_TO_BANK'
  >('DEPOSIT_TO_DEMAT');
  const [transferMethod, setTransferMethod] = useState<
    'UPI' | 'NETBANKING' | 'IMPS' | 'ASBA_3IN1'
  >('UPI');
  const [transferAmount, setTransferAmount] = useState<string>('50000');
  const [transferNote, setTransferNote] = useState<string>('');
  const [bankActionBanner, setBankActionBanner] = useState<string>('');

  // Link New Indian Bank State
  const [newBankName, setNewBankName] = useState<string>('Axis Bank Burgundy');
  const [newBankAcct, setNewBankAcct] = useState<string>('XXXX-XXXX-6721');
  const [newBankIfsc, setNewBankIfsc] = useState<string>('UTIB0000124');
  const [newBankUpi, setNewBankUpi] = useState<string>('atharva@okaxis');
  const [newBankBalance, setNewBankBalance] = useState<string>('350000');

  // External Broker Portfolio Import + RBAC & CDSL Verification State
  const [rbacRole, setRbacRole] = useState<RbacRole>('OWNER_ADMIN');
  const [selectedImportBroker, setSelectedImportBroker] =
    useState<Exclude<BrokerSource, 'KitePulse Direct'>>('SBI Securities');
  const [cdslBoId, setCdslBoId] = useState<string>('1208160098412231');
  const [cdslTpin, setCdslTpin] = useState<string>('482910');
  const [otpCode, setOtpCode] = useState<string>('839201');
  const [csvImportText, setCsvImportText] = useState<string>('');
  const [importBanner, setImportBanner] = useState<string>('');
  const [brokerNotifications, setBrokerNotifications] = useState<BrokerNotificationReceipt[]>([]);

  // Price Alert Form
  const [alertDirection, setAlertDirection] = useState<AlertDirection>('ABOVE');
  const [alertTargetPrice, setAlertTargetPrice] = useState<string>('');
  const [alertNote, setAlertNote] = useState<string>('');
  const [toastAlert, setToastAlert] = useState<PriceAlert | null>(null);

  // AI Copilot State
  const [copilotQuestion, setCopilotQuestion] = useState<string>('');
  const [copilotLoading, setCopilotLoading] = useState<boolean>(false);

  // Price flash state
  const [flashMap, setFlashMap] = useState<Record<string, 'UP' | 'DOWN'>>({});
  const workerRef = useRef<Worker | null>(null);
  const selectedSymbolRef = useRef<string>(selectedSymbol);
  selectedSymbolRef.current = selectedSymbol;

  useEffect(() => {
    try {
      const worker = new Worker(
        new URL('./workers/indicators.worker.ts', import.meta.url),
        { type: 'module' }
      );
      worker.onmessage = (event: MessageEvent<{ type: string; summary: IndicatorSummary }>) => {
        if (
          event.data?.type === 'INDICATORS_RESULT' &&
          event.data.summary.symbol === selectedSymbolRef.current
        ) {
          setIndicators(event.data.summary);
        }
      };
      workerRef.current = worker;
      return () => worker.terminate();
    } catch {
      workerRef.current = null;
    }
  }, []);

  const dispatchIndicatorComputation = useCallback(
    (sym: string, series: OhlcvCandle[]) => {
      if (series.length === 0) return;
      if (workerRef.current) {
        workerRef.current.postMessage({
          type: 'COMPUTE_INDICATORS',
          symbol: sym,
          candles: series,
        });
      } else {
        setIndicators(computeAllIndicators(sym, series));
      }
    },
    []
  );

  const fetchPortfolio = useCallback(async () => {
    try {
      const res = await fetch('/api/portfolio');
      if (res.ok) {
        const data = (await res.json()) as PortfolioSnapshot;
        setPortfolio(data);
        if (data.bankAccounts.length > 0) {
          setTransferBankId((prev) => prev || data.bankAccounts[0].id);
          setSelectedThreeInOneBankId((prev) => prev || data.bankAccounts[0].id);
        }
      }
    } catch {
      // ignore transient error
    }
  }, []);

  const fetchCandlesForSymbol = useCallback(
    async (sym: string) => {
      try {
        const res = await fetch(`/api/candles?symbol=${encodeURIComponent(sym)}`);
        if (res.ok) {
          const data = (await res.json()) as { symbol: string; candles: OhlcvCandle[] };
          setCandles(data.candles);
          dispatchIndicatorComputation(sym, data.candles);
        }
      } catch {
        // ignore
      }
    },
    [dispatchIndicatorComputation]
  );

  useEffect(() => {
    const bootstrap = async () => {
      try {
        const [catRes, portRes, alertRes, newsRes] = await Promise.all([
          fetch('/api/catalog'),
          fetch('/api/portfolio'),
          fetch('/api/alerts'),
          fetch('/api/news'),
        ]);

        if (catRes.ok) {
          const catData = (await catRes.json()) as {
            symbols: SymbolMetadata[];
            ticks: MarketTick[];
            indices?: MarketIndexQuote[];
            session?: MarketSessionStatus;
            replaySpeed: ReplaySpeed;
          };
          setSymbols(catData.symbols);
          setReplaySpeed(catData.replaySpeed);
          if (catData.indices) setIndices(catData.indices);
          if (catData.session) setSession(catData.session);
          const map: Record<string, MarketTick> = {};
          for (const t of catData.ticks) map[t.symbol] = t;
          setTicks(map);
        }

        if (portRes.ok) {
          const portData = (await portRes.json()) as PortfolioSnapshot;
          setPortfolio(portData);
        }

        if (alertRes.ok) {
          const alertData = (await alertRes.json()) as { alerts: PriceAlert[] };
          setAlerts(alertData.alerts);
        }

        if (newsRes.ok) {
          const newsData = (await newsRes.json()) as { news: NewsItem[] };
          setNews(newsData.news);
        }
      } catch {
        // ignore
      }
    };

    void bootstrap();
  }, []);

  useEffect(() => {
    void fetchCandlesForSymbol(selectedSymbol);
    const meta = symbols.find((s) => s.symbol === selectedSymbol);
    if (meta) {
      setOrderQty(String(meta.lotSize));
    }
  }, [selectedSymbol, fetchCandlesForSymbol, symbols]);

  // WebSocket Live Stream
  useEffect(() => {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/ws`;
    let ws: WebSocket | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

    const connect = () => {
      ws = new WebSocket(wsUrl);
      ws.onopen = () => setWsConnected(true);
      ws.onclose = () => {
        setWsConnected(false);
        reconnectTimer = setTimeout(connect, 2000);
      };
      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data as string) as WsServerMessage;
          if (msg.type === 'INITIAL_STATE') {
            setReplaySpeed(msg.replaySpeed);
            if (msg.indices) setIndices(msg.indices);
            if (msg.session) setSession(msg.session);
            const nextMap: Record<string, MarketTick> = {};
            for (const t of msg.ticks) nextMap[t.symbol] = t;
            setTicks(nextMap);
          } else if (msg.type === 'TICK_BATCH') {
            if (msg.indices) setIndices(msg.indices);
            if (msg.session) setSession(msg.session);
            setTicks((prev) => {
              const next = { ...prev };
              const flashes: Record<string, 'UP' | 'DOWN'> = {};
              for (const t of msg.ticks) {
                const old = prev[t.symbol];
                if (old && t.price !== old.price) {
                  flashes[t.symbol] = t.price > old.price ? 'UP' : 'DOWN';
                }
                next[t.symbol] = t;
              }
              if (Object.keys(flashes).length > 0) {
                setFlashMap((f) => ({ ...f, ...flashes }));
              }
              return next;
            });

            const activeUpdate = msg.updatedCandles.find(
              (c) => c.symbol === selectedSymbolRef.current
            );
            if (activeUpdate) {
              setCandles((prev) => {
                if (prev.length === 0) return [activeUpdate];
                const last = prev[prev.length - 1];
                const updated =
                  last.time === activeUpdate.time
                    ? [...prev.slice(0, -1), activeUpdate]
                    : [...prev.slice(-179), activeUpdate];
                dispatchIndicatorComputation(selectedSymbolRef.current, updated);
                return updated;
              });
            }
          } else if (msg.type === 'ALERT_TRIGGERED') {
            setToastAlert(msg.alert);
            setAlerts((prev) =>
              prev.map((a) => (a.id === msg.alert.id ? msg.alert : a))
            );
          } else if (msg.type === 'REPLAY_SPEED_CHANGED') {
            setReplaySpeed(msg.replaySpeed);
            if (msg.session) setSession(msg.session);
          }
        } catch {
          // ignore
        }
      };
    };

    connect();
    return () => {
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (ws) ws.close();
    };
  }, [dispatchIndicatorComputation]);

  // Live Universal NSE/BSE Search
  useEffect(() => {
    const q = searchQuery.trim();
    if (q.length < 2) return;
    const timer = setTimeout(async () => {
      setIsSearchingLive(true);
      try {
        const res = await fetch(`/api/market/search?q=${encodeURIComponent(q)}`);
        if (res.ok) {
          const data = (await res.json()) as {
            allSymbols: SymbolMetadata[];
            ticks: MarketTick[];
          };
          if (data.allSymbols) setSymbols(data.allSymbols);
          if (data.ticks) {
            const map: Record<string, MarketTick> = {};
            for (const t of data.ticks) map[t.symbol] = t;
            setTicks((prev) => ({ ...prev, ...map }));
          }
        }
      } catch {
        // ignore
      } finally {
        setIsSearchingLive(false);
      }
    }, 350);
    return () => clearTimeout(timer);
  }, [searchQuery]);

  // Real-Time Portfolio Valuation Synced to Live NSE/BSE Ticks
  const livePortfolio = useMemo((): PortfolioSnapshot | null => {
    if (!portfolio) return null;
    let holdingsMarketValue = 0;
    let totalCostBasis = 0;

    const updatedHoldings = portfolio.holdings.map((h) => {
      const liveTick = ticks[h.symbol];
      const currentPrice = liveTick ? liveTick.price : h.currentPrice;
      const prevClose = liveTick ? liveTick.prevClose : h.prevClose;
      const openPrice = liveTick ? liveTick.open : h.openPrice;
      const dayHigh = liveTick ? liveTick.dayHigh : h.dayHigh;
      const dayLow = liveTick ? liveTick.dayLow : h.dayLow;
      const dayChange = liveTick ? liveTick.change : h.dayChange;
      const dayChangePercent = liveTick ? liveTick.changePercent : h.dayChangePercent;
      const marketValue = Number((h.quantity * currentPrice).toFixed(2));
      const unrealizedPnl = Number((marketValue - h.totalCost).toFixed(2));
      const unrealizedPnlPercent =
        h.totalCost > 0 ? Number(((unrealizedPnl / h.totalCost) * 100).toFixed(2)) : 0;

      holdingsMarketValue += marketValue;
      totalCostBasis += h.totalCost;

      return {
        ...h,
        currentPrice,
        prevClose,
        openPrice,
        dayHigh,
        dayLow,
        dayChange,
        dayChangePercent,
        marketValue,
        unrealizedPnl,
        unrealizedPnlPercent,
      };
    });

    holdingsMarketValue = Number(holdingsMarketValue.toFixed(2));
    totalCostBasis = Number(totalCostBasis.toFixed(2));
    const totalEquity = Number((portfolio.cashBalance + holdingsMarketValue).toFixed(2));
    const totalUnrealizedPnl = Number((holdingsMarketValue - totalCostBasis).toFixed(2));
    const totalUnrealizedPnlPercent =
      totalCostBasis > 0 ? Number(((totalUnrealizedPnl / totalCostBasis) * 100).toFixed(2)) : 0;

    for (const h of updatedHoldings) {
      h.weightPercent =
        holdingsMarketValue > 0
          ? Number(((h.marketValue / holdingsMarketValue) * 100).toFixed(2))
          : 0;
    }

    return {
      ...portfolio,
      holdingsMarketValue,
      totalEquity,
      totalUnrealizedPnl,
      totalUnrealizedPnlPercent,
      holdings: updatedHoldings,
    };
  }, [portfolio, ticks]);

  // Bullish vs. Bearish Market Breadth Computation
  const marketBreadth = useMemo(() => {
    const list = Object.values(ticks);
    let bulls = 0;
    let bears = 0;
    for (const t of list) {
      if (t.changePercent >= 0) bulls++;
      else bears++;
    }
    const total = Math.max(1, bulls + bears);
    const bullPct = Math.round((bulls / total) * 100);
    const bearPct = 100 - bullPct;
    return { bulls, bears, bullPct, bearPct, isBullDominant: bullPct >= 50 };
  }, [ticks]);

  const activeTick = ticks[selectedSymbol];
  const activeMeta = symbols.find((s) => s.symbol === selectedSymbol);
  const activePosition = livePortfolio?.holdings.find((h) => h.symbol === selectedSymbol);
  const isSelectedStockBullish = (activeTick?.changePercent ?? 0) >= 0;

  const filteredWatchlist = useMemo(() => {
    return symbols.filter((s) => {
      const matchesSegment = segmentFilter === 'ALL' || s.segment === segmentFilter;
      const q = searchQuery.trim().toLowerCase();
      const matchesSearch =
        !q ||
        s.symbol.toLowerCase().includes(q) ||
        s.name.toLowerCase().includes(q) ||
        s.sector.toLowerCase().includes(q);
      return matchesSegment && matchesSearch;
    });
  }, [symbols, segmentFilter, searchQuery]);

  const filteredHoldings = useMemo(() => {
    if (!livePortfolio) return [];
    if (brokerFilter === 'ALL') return livePortfolio.holdings;
    return livePortfolio.holdings.filter((h) => h.brokers.includes(brokerFilter));
  }, [livePortfolio, brokerFilter]);

  const handleSyncMarketNow = async () => {
    setIsSyncingMarket(true);
    try {
      const res = await fetch('/api/market/sync', { method: 'POST' });
      if (res.ok) {
        const data = (await res.json()) as {
          ticks: MarketTick[];
          indices: MarketIndexQuote[];
          session: MarketSessionStatus;
          portfolio: PortfolioSnapshot;
        };
        const map: Record<string, MarketTick> = {};
        for (const t of data.ticks) map[t.symbol] = t;
        setTicks(map);
        setIndices(data.indices);
        setSession(data.session);
        setPortfolio(data.portfolio);
        await fetchCandlesForSymbol(selectedSymbol);
      }
    } finally {
      setIsSyncingMarket(false);
    }
  };

  const handleReplaySpeedChange = async (speed: ReplaySpeed) => {
    setReplaySpeed(speed);
    try {
      const res = await fetch('/api/replay/speed', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ speed }),
      });
      if (res.ok) {
        const data = (await res.json()) as {
          session: MarketSessionStatus;
          ticks: MarketTick[];
          portfolio: PortfolioSnapshot;
        };
        if (data.session) setSession(data.session);
        if (data.ticks) {
          const map: Record<string, MarketTick> = {};
          for (const t of data.ticks) map[t.symbol] = t;
          setTicks(map);
        }
        if (data.portfolio) setPortfolio(data.portfolio);
      }
    } catch {
      // ignore
    }
  };

  const handleOrderSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const qty = Number(orderQty);
    if (!Number.isFinite(qty) || qty <= 0) {
      setOrderStatus({ type: 'ERROR', message: 'Enter a valid positive quantity.' });
      return;
    }

    setOrderStatus({ type: 'SUBMITTING', message: 'Routing order to NSE/BSE ACID Ledger...' });
    const idempotencyKey = `${selectedSymbol}-${orderSide}-${qty}-${Date.now()}`;

    try {
      const res = await fetch('/api/orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          symbol: selectedSymbol,
          side: orderSide,
          quantity: qty,
          idempotencyKey,
          brokerSource: orderBrokerSource,
          useThreeInOneBankId: useThreeInOneAutoDebit ? selectedThreeInOneBankId : undefined,
        }),
      });

      const data = (await res.json()) as {
        error?: string;
        order?: { executionPrice: number; realizedPnl: number; brokerSource: string };
        portfolio?: PortfolioSnapshot;
      };

      if (!res.ok || data.error) {
        setOrderStatus({ type: 'ERROR', message: data.error || 'Order rejected.' });
        return;
      }

      if (data.portfolio) setPortfolio(data.portfolio);

      const execPrice = data.order?.executionPrice ?? activeTick?.price ?? 0;
      const pnlText =
        orderSide === 'SELL' && data.order
          ? ` | FIFO Realized P&L: ${data.order.realizedPnl >= 0 ? '+' : ''}${formatINR(
              data.order.realizedPnl
            )}`
          : '';
      const bankSweepText = useThreeInOneAutoDebit ? ' via 3-in-1 Bank ASBA' : '';

      setOrderStatus({
        type: 'SUCCESS',
        message: `${orderSide} ${qty} ${selectedSymbol} @ ${formatINR(
          execPrice
        )}${bankSweepText}${pnlText}`,
      });
    } catch {
      setOrderStatus({ type: 'ERROR', message: 'Network error executing order.' });
    }
  };

  const handleBankTransfer = async (e: React.FormEvent) => {
    e.preventDefault();
    const amt = Number(transferAmount);
    if (!Number.isFinite(amt) || amt <= 0) return;

    setBankActionBanner('Processing instant atomic bank ↔ demat settlement...');
    try {
      const res = await fetch('/api/banks/transfer', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          bankAccountId: transferBankId,
          direction: transferDirection,
          method: transferMethod,
          amount: amt,
          referenceNote: transferNote,
        }),
      });
      const data = (await res.json()) as {
        error?: string;
        portfolio?: PortfolioSnapshot;
        transaction?: { referenceNote: string };
      };
      if (!res.ok || data.error) {
        setBankActionBanner(`Error: ${data.error || 'Transfer failed'}`);
        return;
      }
      if (data.portfolio) setPortfolio(data.portfolio);
      setTransferNote('');
      setBankActionBanner(
        `Success: ${
          transferDirection === 'DEPOSIT_TO_DEMAT' ? 'Added' : 'Withdrew'
        } ${formatINR(amt)} via ${transferMethod}.`
      );
    } catch {
      setBankActionBanner('Error communicating with banking gateway.');
    }
  };

  const handleLinkNewBank = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const res = await fetch('/api/banks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          bankName: newBankName,
          accountNumberMasked: newBankAcct,
          ifscCode: newBankIfsc,
          upiId: newBankUpi,
          initialBalance: Number(newBankBalance) || 100000,
          isPrimaryThreeInOne: false,
        }),
      });
      const data = (await res.json()) as { portfolio?: PortfolioSnapshot; error?: string };
      if (res.ok && data.portfolio) {
        setPortfolio(data.portfolio);
        setBankActionBanner(`Linked ${newBankName} (${newBankIfsc}) for 3-in-1 Demat settlements!`);
      }
    } catch {
      // ignore
    }
  };

  const handleImportCsvSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const lines = csvImportText
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
    const items: ExternalHoldingImportItem[] = [];
    for (const line of lines) {
      const [sym, qtyStr, priceStr, brokerStr] = line.split(',').map((s) => s.trim());
      if (!sym || !qtyStr || !priceStr) continue;
      items.push({
        symbol: sym.toUpperCase(),
        quantity: Number(qtyStr),
        buyPrice: Number(priceStr),
        brokerSource: (brokerStr as BrokerSource) || selectedImportBroker,
      });
    }
    if (items.length === 0) {
      setImportBanner(
        'Enter at least one holding row (SYMBOL,QUANTITY,BUY_PRICE) to authenticate and import.'
      );
      return;
    }
    try {
      const res = await fetch('/api/portfolio/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          items,
          auth: {
            rbacRole,
            cdslBoId,
            cdslTpin,
            otpCode,
          },
        }),
      });
      const data = (await res.json()) as {
        importedCount?: number;
        portfolio?: PortfolioSnapshot;
        brokerNotifications?: BrokerNotificationReceipt[];
        error?: string;
      };
      if (!res.ok || data.error) {
        setImportBanner(`Error: ${data.error || 'Import verification failed.'}`);
        return;
      }
      if (data.portfolio) {
        setPortfolio(data.portfolio);
      }
      if (data.brokerNotifications && data.brokerNotifications.length > 0) {
        setBrokerNotifications((prev) => [...data.brokerNotifications!, ...prev]);
      }
      setCsvImportText('');
      setImportBanner(
        `RBAC & CDSL TPIN Verified (${rbacRole}): Imported ${data.importedCount} holdings and dispatched export notification webhook to ${selectedImportBroker}.`
      );
    } catch {
      setImportBanner('Network error communicating with broker verification gateway.');
    }
  };

  const handleResetPortfolio = async () => {
    const res = await fetch('/api/portfolio/reset', { method: 'POST' });
    if (res.ok) {
      const data = (await res.json()) as { portfolio: PortfolioSnapshot };
      setPortfolio(data.portfolio);
      setImportBanner('Portfolio cleared to 0 holdings.');
    }
  };

  const handleCreateAlert = async (e: React.FormEvent) => {
    e.preventDefault();
    const target = Number(alertTargetPrice);
    if (!Number.isFinite(target) || target <= 0) return;

    const res = await fetch('/api/alerts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        symbol: selectedSymbol,
        direction: alertDirection,
        targetPrice: target,
        note: alertNote.trim() || `${selectedSymbol} ${alertDirection} ${formatINR(target)}`,
      }),
    });
    if (res.ok) {
      const data = (await res.json()) as { alerts: PriceAlert[] };
      setAlerts(data.alerts);
      setAlertTargetPrice('');
      setAlertNote('');
    }
  };

  const handleDeleteAlert = async (id: number) => {
    const res = await fetch(`/api/alerts/${id}`, { method: 'DELETE' });
    if (res.ok) {
      const data = (await res.json()) as { alerts: PriceAlert[] };
      setAlerts(data.alerts);
    }
  };

  const runCopilotAudit = useCallback(async (question?: string) => {
    setCopilotLoading(true);
    try {
      const res = await fetch('/api/copilot/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question }),
      });
      if (res.ok) {
        const data = (await res.json()) as AiCopilotAnalysis;
        setAiAnalysis(data);
      }
    } finally {
      setCopilotLoading(false);
    }
  }, []);

  useEffect(() => {
    if (activeTab === 'AI_COPILOT' && !aiAnalysis && !copilotLoading) {
      void runCopilotAudit();
    }
  }, [activeTab, aiAnalysis, copilotLoading, runCopilotAudit]);

  const estimatedOrderNotional = useMemo(() => {
    const qty = Number(orderQty);
    if (!Number.isFinite(qty) || qty <= 0 || !activeTick) return 0;
    const execPrice = orderSide === 'BUY' ? activeTick.ask : activeTick.bid;
    return Number((qty * execPrice).toFixed(2));
  }, [orderQty, activeTick, orderSide]);

  const totalLinkedBankBalance = useMemo(() => {
    if (!livePortfolio) return 0;
    return livePortfolio.bankAccounts.reduce((acc, b) => acc + b.balance, 0);
  }, [livePortfolio]);

  const statutoryBreakdown = useMemo(() => {
    const qty = Number(orderQty);
    const execPrice =
      orderSide === 'BUY'
        ? activeTick?.ask ?? activeMeta?.basePrice ?? 0
        : activeTick?.bid ?? activeMeta?.basePrice ?? 0;
    return calculateIndianStatutoryCharges(
      orderSide,
      activeMeta?.segment ?? 'LARGE_CAP',
      activeMeta?.exchange ?? 'NSE',
      Number.isFinite(qty) && qty > 0 ? qty : 0,
      execPrice
    );
  }, [orderSide, orderQty, activeTick, activeMeta]);

  const taxReport = useMemo(() => {
    if (!livePortfolio) return null;
    return computeIndianCapitalGainsTax(livePortfolio.holdings, livePortfolio.totalRealizedPnl);
  }, [livePortfolio]);

  const marketDepth = useMemo(() => {
    return generateMarketDepthLadder(activeTick, activeMeta?.basePrice ?? 1000);
  }, [activeTick, activeMeta]);

  const quantRisk = useMemo(() => {
    if (!livePortfolio) return null;
    return computeQuantRiskMetrics(livePortfolio);
  }, [livePortfolio]);

  if (isLoginRoute) {
    return (
      <div className="min-h-screen agy-ambient-bg bg-[#070B12] text-slate-100 flex items-center justify-center p-4 selection:bg-emerald-600 selection:text-white">
        <div className="w-full max-w-md">
          <PhoneOtpLoginView
            onLoginSuccess={(sess) => {
              setAuthSession(sess);
              setRbacRole(sess.rbacRole);
              navigateToTab('HOLDINGS_AND_LOTS');
            }}
            onSkipToPortfolio={() => navigateToTab('HOLDINGS_AND_LOTS')}
          />
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen agy-ambient-bg bg-[#070B12] text-slate-100 flex flex-col selection:bg-emerald-600 selection:text-white">
      {/* ================= TOP COMMAND BAR ================= */}
      <header className="sticky top-0 z-30 agy-header-glass bg-[#0B1320]/85 text-white border-b border-slate-800 shadow-lg">
        <div className="px-4 py-2.5 flex flex-wrap items-center justify-between gap-3">
          {/* Brand + Live NSE/BSE Indices */}
          <div className="flex items-center gap-4 flex-wrap">
            <div className="flex items-center gap-2.5">
              <div className="w-8 h-8 rounded-lg bg-emerald-500/15 border border-emerald-500/30 flex items-center justify-center">
                <Flame className="w-4 h-4 text-[#00D09C]" />
              </div>
              <div>
                <div className="flex items-center gap-2">
                  <span className="font-semibold tracking-tight text-base text-white">
                    KitePulse
                  </span>
                </div>
                <p className="text-[11px] text-slate-400">
                  NSE, BSE, MCX & Mutual Fund Portfolio Tracker
                </p>
              </div>
            </div>

            {/* Live Authentic Indian Market Indices (NIFTY 50, SENSEX, NIFTY BANK) */}
            <div className="hidden xl:flex items-center gap-2.5 pl-3 border-l border-slate-800">
              {indices.map((idx) => {
                const isUp = idx.change >= 0;
                return (
                  <div
                    key={idx.symbol}
                    className={`px-3 py-1.5 rounded-lg border flex items-center gap-2.5 ${
                      isUp
                        ? 'bg-emerald-950/30 border-emerald-500/25'
                        : 'bg-rose-950/30 border-rose-500/25'
                    }`}
                  >
                    <div>
                      <div className="flex items-center gap-1.5">
                        <span className="text-xs font-medium text-slate-200">
                          {idx.name}
                        </span>
                      </div>
                      <div className="flex items-center gap-2 mt-0.5 font-mono text-xs">
                        <span className="font-semibold text-white">
                          {idx.price.toLocaleString('en-IN', {
                            minimumFractionDigits: 2,
                            maximumFractionDigits: 2,
                          })}
                        </span>
                        <span
                          className={`text-[11px] font-medium ${
                            isUp ? 'text-[#00D09C]' : 'text-[#FB7185]'
                          }`}
                        >
                          {isUp ? '+' : ''}
                          {idx.change.toFixed(2)} ({isUp ? '+' : ''}
                          {idx.changePercent.toFixed(2)}%)
                        </span>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Right Status: Market Session (09:15 - 15:30 IST) + Live Sync + Market Mode */}
          <div className="flex items-center gap-3 flex-wrap">
            {session && (
              <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-slate-900/90 border border-slate-800">
                <Clock className="w-3.5 h-3.5 text-amber-400" />
                <div className="text-xs">
                  <div className="flex items-center gap-1.5">
                    <span
                      className={`w-2 h-2 rounded-full ${
                        session.isLiveHours
                          ? 'bg-[#00D09C] animate-pulse'
                          : 'bg-amber-400'
                      }`}
                    />
                    <span className="font-medium text-amber-300">{session.istTime}</span>
                    <span className="text-slate-500">•</span>
                    <span className="text-slate-300">{session.label}</span>
                  </div>
                </div>
              </div>
            )}

            <button
              onClick={navigateToLogin}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border transition cursor-pointer ${
                isLoginRoute
                  ? 'bg-[#00B386] text-slate-950 border-[#00D09C]'
                  : 'bg-slate-900 hover:bg-slate-800 text-slate-200 border-slate-700'
              }`}
            >
              <span>
                {authSession ? `${authSession.maskedPhone} • ${authSession.rbacRole}` : 'Phone & OTP Login'}
              </span>
            </button>

            <button
              onClick={handleSyncMarketNow}
              disabled={isSyncingMarket}
              title="Fetch latest real-time NSE/BSE/AMFI prices from exchange feed"
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-emerald-600 hover:bg-emerald-500 text-white shadow-sm transition cursor-pointer disabled:opacity-50"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${isSyncingMarket ? 'animate-spin' : ''}`} />
              <span>{isSyncingMarket ? 'Syncing...' : 'Refresh Quotes'}</span>
            </button>

            <div className="flex items-center gap-1.5 bg-slate-900 border border-slate-800 rounded-lg px-2 py-1">
              <span className="text-xs text-slate-400">
                Feed:
              </span>
              {([0, 1, 5, 10] as ReplaySpeed[]).map((spd) => (
                <button
                  key={spd}
                  onClick={() => handleReplaySpeedChange(spd)}
                  className={`px-2.5 py-1 text-xs font-medium rounded-md transition cursor-pointer ${
                    replaySpeed === spd
                      ? spd === 0
                        ? 'bg-[#00B386] text-white'
                        : 'bg-amber-500 text-slate-950'
                      : 'text-slate-300 hover:text-white hover:bg-slate-800'
                  }`}
                >
                  {spd === 0 ? 'Live' : `${spd}x`}
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* ================= MARKET BREADTH & PORTFOLIO SUMMARY RIBBON ================= */}
        <div className="bg-[#0D1626] px-4 py-1.5 border-t border-slate-800/80 flex flex-wrap items-center justify-between gap-4 text-xs">
          <div className="flex items-center gap-3 flex-1 min-w-[280px]">
            <span className="flex items-center gap-1 font-medium text-[#00D09C]">
              <TrendingUp className="w-3.5 h-3.5" />
              Advancing: {marketBreadth.bulls} ({marketBreadth.bullPct}%)
            </span>
            <div className="flex-1 h-2 rounded-full bg-[#E11D48]/80 overflow-hidden flex max-w-xs">
              <div
                className="h-full bg-[#00D09C] transition-all duration-500"
                style={{ width: `${marketBreadth.bullPct}%` }}
              />
            </div>
            <span className="flex items-center gap-1 font-medium text-[#FB7185]">
              <TrendingDown className="w-3.5 h-3.5" />
              Declining: {marketBreadth.bears} ({marketBreadth.bearPct}%)
            </span>
          </div>

          {/* Live Portfolio Summary Strip in Header */}
          {livePortfolio && (
            <div className="flex items-center gap-5 font-mono text-xs">
              <div>
                <span className="text-slate-400 mr-1.5">Holdings:</span>
                <span className="font-semibold text-white">
                  {livePortfolio.holdings.length}
                </span>
              </div>
              <div>
                <span className="text-slate-400 mr-1.5">Current Value:</span>
                <span className="font-semibold text-white">
                  {formatINR(livePortfolio.holdingsMarketValue)}
                </span>
              </div>
              <div>
                <span className="text-slate-400 mr-1.5">Total P&L:</span>
                <span
                  className={`font-semibold ${
                    livePortfolio.totalUnrealizedPnl >= 0
                      ? 'text-[#00D09C]'
                      : 'text-[#FB7185]'
                  }`}
                >
                  {livePortfolio.totalUnrealizedPnl >= 0 ? '+' : ''}
                  {formatINR(livePortfolio.totalUnrealizedPnl)} (
                  {livePortfolio.totalUnrealizedPnl >= 0 ? '+' : ''}
                  {livePortfolio.totalUnrealizedPnlPercent.toFixed(2)}%)
                </span>
              </div>
              <div>
                <span className="text-slate-400 mr-1.5">Available Margin:</span>
                <span className="font-semibold text-amber-400">
                  {formatINR(livePortfolio.cashBalance)}
                </span>
              </div>
              <div className="hidden md:block">
                <span className="text-slate-400 mr-1.5">Linked Banks:</span>
                <span className="font-semibold text-[#00D09C]">
                  {formatINR(totalLinkedBankBalance)}
                </span>
              </div>
            </div>
          )}
        </div>

        {/* ================= TOP WEBSITE NAVIGATION BAR (DEDICATED ROUTE BUTTONS) ================= */}
        <nav
          aria-label="Primary website routes"
          className="bg-[#090F1A]/95 px-4 py-2 border-t border-slate-800/80 flex items-center gap-2 flex-wrap"
        >
          <span className="text-[11px] font-medium text-slate-400 mr-1 hidden sm:inline">
            Navigate:
          </span>
          {(
            [
              ['HOLDINGS_AND_LOTS', 'Portfolio', Layers],
              ['TERMINAL', 'Stocks & Charts', Activity],
              ['BANK_AND_FUNDS', '3-in-1 Bank & UPI', Landmark],
              ['BROKER_IMPORT', 'Broker Import', FolderInput],
              ['TAX_AND_CONTRACT_NOTE', 'SEBI Tax & Note', ShieldAlert],
              ['MARKET_NEWS', 'Market News', Flame],
              ['AI_COPILOT', 'RAG Risk Copilot', Sparkles],
              ['ALERTS_AND_ORDERS', 'Orders & Alerts', Bell],
            ] as Array<[ActiveTab, string, React.ComponentType<{ className?: string }>]>
          ).map(([tabId, label, Icon]) => {
            const active = !isLoginRoute && activeTab === tabId;
            return (
              <button
                key={tabId}
                type="button"
                onClick={() => navigateToTab(tabId)}
                className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border transition cursor-pointer ${
                  active
                    ? 'bg-[#00D09C] text-slate-950 font-semibold border-[#00D09C] shadow-sm'
                    : 'bg-[#111A2B]/90 hover:bg-slate-800 text-slate-200 border-slate-700/80'
                }`}
              >
                <Icon className="w-3.5 h-3.5" />
                <span>{label}</span>
              </button>
            );
          })}
        </nav>
      </header>

      {/* Alert Triggered Banner */}
      {toastAlert && (
        <div className="bg-amber-950/80 border-b border-amber-500/40 px-4 py-2 flex items-center justify-between text-xs text-amber-200">
          <div className="flex items-center gap-2 font-medium">
            <Bell className="w-4 h-4 text-amber-400 animate-bounce" />
            <span>
              <strong>PRICE ALERT TRIGGERED:</strong> {toastAlert.symbol} crossed{' '}
              {toastAlert.direction} {formatINR(toastAlert.targetPrice)} (Exec Price:{' '}
              {formatINR(toastAlert.triggeredPrice ?? toastAlert.targetPrice)}) —{' '}
              {toastAlert.note}
            </span>
          </div>
          <button
            onClick={() => setToastAlert(null)}
            className="text-amber-300 hover:underline font-semibold cursor-pointer"
          >
            Dismiss
          </button>
        </div>
      )}

      {/* ================= MAIN WORKSPACE GRID ================= */}
      <div className="flex-1 grid grid-cols-1 lg:grid-cols-12 gap-0">
        {/* LEFT COLUMN (3 COLS): UNIVERSAL NSE/BSE WATCHLIST WITH BULL/BEAR BARS */}
        <aside className="lg:col-span-3 bg-[#0B111E] border-r border-slate-800 flex flex-col h-[calc(100vh-88px)] sticky top-[88px]">
          <div className="p-3 border-b border-slate-800 bg-[#0D1526] space-y-2.5">
            <div className="relative">
              <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search any NSE/BSE stock (e.g. TATASTEEL, ITC, HAL, SBIN)..."
                className="w-full pl-9 pr-3 py-2 text-xs bg-[#070B12] border border-slate-700 rounded-lg text-slate-100 placeholder:text-slate-500 focus:outline-none focus:border-emerald-500 focus:ring-2 focus:ring-emerald-500/20"
              />
              {isSearchingLive && (
                <span className="absolute right-2.5 top-1/2 -translate-y-1/2 text-[10px] font-mono text-[#00D09C] animate-pulse">
                  NSE Lookup...
                </span>
              )}
            </div>

            {/* Segment Filter Pills */}
            <div className="flex items-center gap-1 overflow-x-auto pb-1">
              {(
                [
                  ['ALL', 'All'],
                  ['COMMODITY', 'Gold, Silver & Commodities'],
                  ['LARGE_CAP', 'Large Cap'],
                  ['MID_CAP', 'Mid Cap'],
                  ['SMALL_CAP', 'Small Cap'],
                  ['FNO', 'F&O'],
                  ['ETF', 'ETF'],
                  ['MUTUAL_FUND', 'Mutual Funds'],
                ] as Array<[SegmentFilter, string]>
              ).map(([seg, label]) => (
                <button
                  key={seg}
                  onClick={() => setSegmentFilter(seg)}
                  className={`px-2.5 py-1 rounded-md text-[11px] font-semibold whitespace-nowrap transition cursor-pointer ${
                    segmentFilter === seg
                      ? 'bg-[#00B386] text-slate-950 font-bold shadow-xs'
                      : 'bg-[#111A2B] text-slate-300 border border-slate-800 hover:bg-slate-800'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          {/* Watchlist Items */}
          <div className="flex-1 overflow-y-auto divide-y divide-slate-800/70">
            {filteredWatchlist.map((meta) => {
              const tick = ticks[meta.symbol];
              const price = tick ? tick.price : meta.basePrice;
              const change = tick ? tick.change : Number((meta.basePrice - meta.prevClose).toFixed(2));
              const changePct = tick
                ? tick.changePercent
                : Number((((meta.basePrice - meta.prevClose) / meta.prevClose) * 100).toFixed(2));
              const isUp = change >= 0;
              const isSelected = selectedSymbol === meta.symbol;
              const flash = flashMap[meta.symbol];
              const held = livePortfolio?.holdings.find((h) => h.symbol === meta.symbol);

              return (
                <button
                  key={meta.symbol}
                  onClick={() => {
                    setSelectedSymbol(meta.symbol);
                    navigateToTab('TERMINAL');
                  }}
                  className={`w-full text-left px-3.5 py-2.5 transition flex items-center justify-between gap-2 cursor-pointer border-l-4 ${
                    isSelected
                      ? isUp
                        ? 'bg-emerald-950/40 border-l-[#00D09C]'
                        : 'bg-rose-950/40 border-l-[#FB7185]'
                      : isUp
                        ? 'hover:bg-slate-900/80 border-l-[#059669]/40'
                        : 'hover:bg-slate-900/80 border-l-[#E11D48]/40'
                  } ${
                    flash === 'UP'
                      ? 'bg-emerald-900/30'
                      : flash === 'DOWN'
                        ? 'bg-rose-900/30'
                        : ''
                  }`}
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-1.5">
                      <span className="font-bold text-xs text-slate-100 truncate">
                        {meta.symbol}
                      </span>
                      <span className="text-[10px] font-mono px-1.5 py-0.2 rounded bg-slate-800 text-slate-300 border border-slate-700">
                        {meta.exchange}
                      </span>
                      {held && (
                        <span className="text-[10px] font-mono px-1.5 py-0.2 rounded bg-amber-500/20 text-amber-300 border border-amber-500/30 font-semibold">
                          Qty: {held.quantity}
                        </span>
                      )}
                    </div>
                    <p className="text-[11px] text-slate-400 truncate mt-0.5">{meta.name}</p>
                  </div>

                  <div className="text-right font-mono shrink-0">
                    <div
                      className={`text-xs font-bold ${
                        isUp ? 'text-[#00D09C]' : 'text-[#FB7185]'
                      }`}
                    >
                      {formatINR(price)}
                    </div>
                    <div
                      className={`text-[11px] font-semibold flex items-center justify-end gap-0.5 ${
                        isUp ? 'text-[#00D09C]' : 'text-[#FB7185]'
                      }`}
                    >
                      {isUp ? (
                        <ArrowUpRight className="w-3 h-3" />
                      ) : (
                        <ArrowDownRight className="w-3 h-3" />
                      )}
                      <span>
                        {isUp ? '+' : ''}
                        {change.toFixed(2)} ({isUp ? '+' : ''}
                        {changePct.toFixed(2)}%)
                      </span>
                    </div>
                  </div>
                </button>
              );
            })}
          </div>
        </aside>

        {/* CENTER COLUMN (6 COLS): NAVIGATION ROUTES + LOGIN / PORTFOLIO / TERMINAL / RAG COPILOT */}
        <main className="lg:col-span-6 flex flex-col bg-[#070B12] min-h-[calc(100vh-88px)]">
          {/* Multi-Route Navigation Bar (Main Route: /portfolio) */}
          <div className="bg-[#0B111E] border-b border-slate-800 px-4 flex items-center gap-1 overflow-x-auto">
            {(
              [
                [
                  'HOLDINGS_AND_LOTS',
                  `Portfolio (${livePortfolio?.holdings.length ?? 0})`,
                  Layers,
                ],
                ['TERMINAL', 'Stocks & Charts', Activity],
                ['BANK_AND_FUNDS', '3-in-1 Bank & UPI', Landmark],
                ['BROKER_IMPORT', 'Broker Import', FolderInput],
                ['TAX_AND_CONTRACT_NOTE', 'SEBI Tax & Note', ShieldAlert],
                ['MARKET_NEWS', `Market News (${news.length})`, Flame],
                ['AI_COPILOT', 'RAG Risk Copilot', Sparkles],
                ['ALERTS_AND_ORDERS', `Orders & Alerts (${alerts.length})`, Bell],
              ] as Array<[ActiveTab, string, React.ComponentType<{ className?: string }>]>
            ).map(([tabId, label, Icon]) => {
              const active = !isLoginRoute && activeTab === tabId;
              return (
                <button
                  key={tabId}
                  onClick={() => navigateToTab(tabId)}
                  className={`flex items-center gap-1.5 px-3 py-3 text-xs font-semibold border-b-2 whitespace-nowrap transition cursor-pointer ${
                    active
                      ? 'border-[#00D09C] text-[#00D09C] bg-emerald-950/30'
                      : 'border-transparent text-slate-400 hover:text-slate-100 hover:bg-slate-900/60'
                  }`}
                >
                  <Icon className="w-3.5 h-3.5" />
                  <span>{label}</span>
                </button>
              );
            })}
          </div>

          <div
            key={activeTab}
            className="p-4 space-y-4 flex-1 agy-panel-enter"
          >
            {/* ================= TAB 1: LIVE TERMINAL & REAL-TIME OHLC CHART ================= */}
            {activeTab === 'TERMINAL' && activeMeta && (
              <>
                {/* Selected Instrument Real-Time Bull/Bear Header Card */}
                <div
                  className={`rounded-xl bg-[#0D1421] border p-4 shadow-md ${
                    isSelectedStockBullish
                      ? 'border-emerald-500/40'
                      : 'border-rose-500/40'
                  }`}
                >
                  <div className="flex flex-wrap items-start justify-between gap-4">
                    <div>
                      <div className="flex items-center gap-2 flex-wrap">
                        <h1 className="text-xl font-extrabold tracking-tight text-white">
                          {activeMeta.symbol}
                        </h1>
                        <span className="text-xs font-mono font-bold px-2 py-0.5 rounded bg-slate-800 text-slate-200 border border-slate-700">
                          {activeMeta.exchange}
                        </span>
                        <span
                          className={`text-xs font-mono font-bold px-2.5 py-0.5 rounded-full flex items-center gap-1 ${
                            isSelectedStockBullish
                              ? 'bg-emerald-950/80 text-[#00D09C] border border-emerald-500/40'
                              : 'bg-rose-950/80 text-[#FB7185] border border-rose-500/40'
                          }`}
                        >
                          {isSelectedStockBullish ? (
                            <>
                              <TrendingUp className="w-3.5 h-3.5" /> Bullish Trend
                            </>
                          ) : (
                            <>
                              <TrendingDown className="w-3.5 h-3.5" /> Bearish Trend
                            </>
                          )}
                        </span>
                        <span className="text-xs text-slate-400 font-medium">
                          {SEGMENT_LABELS[activeMeta.segment]} • Lot Size: {activeMeta.lotSize}
                        </span>
                      </div>
                      <p className="text-xs text-slate-400 mt-1">{activeMeta.name}</p>
                    </div>

                    <div className="text-right font-mono">
                      <div
                        className={`text-2xl font-extrabold ${
                          isSelectedStockBullish ? 'text-[#00D09C]' : 'text-[#FB7185]'
                        }`}
                      >
                        {formatINR(activeTick?.price ?? activeMeta.basePrice)}
                      </div>
                      <div
                        className={`text-xs font-bold ${
                          isSelectedStockBullish ? 'text-[#00D09C]' : 'text-[#FB7185]'
                        }`}
                      >
                        {(activeTick?.change ?? 0) >= 0 ? '+' : ''}
                        {(activeTick?.change ?? 0).toFixed(2)} (
                        {(activeTick?.changePercent ?? 0) >= 0 ? '+' : ''}
                        {(activeTick?.changePercent ?? 0).toFixed(2)}%) Today
                      </div>
                    </div>
                  </div>

                  {/* Authentic Real-Time NSE/BSE Session OHLC Strip (Open / High / Low / Prev. Close) */}
                  <div className="grid grid-cols-2 sm:grid-cols-5 gap-2.5 mt-4 pt-3 border-t border-slate-800 font-mono text-xs">
                    <div className="bg-[#111A2B] rounded-lg px-3 py-2 border border-slate-800">
                      <div className="text-[11px] text-slate-400">Open (09:15 IST)</div>
                      <div className="font-semibold text-slate-100 mt-0.5">
                        {formatINR(activeTick?.open ?? activeMeta.prevClose)}
                      </div>
                    </div>
                    <div className="bg-emerald-950/30 rounded-lg px-3 py-2 border border-emerald-500/30">
                      <div className="text-[11px] text-emerald-400">Day High</div>
                      <div className="font-semibold text-[#00D09C] mt-0.5">
                        {formatINR(activeTick?.dayHigh ?? activeMeta.basePrice)}
                      </div>
                    </div>
                    <div className="bg-rose-950/30 rounded-lg px-3 py-2 border border-rose-500/30">
                      <div className="text-[11px] text-rose-400">Day Low</div>
                      <div className="font-semibold text-[#FB7185] mt-0.5">
                        {formatINR(activeTick?.dayLow ?? activeMeta.basePrice)}
                      </div>
                    </div>
                    <div className="bg-[#111A2B] rounded-lg px-3 py-2 border border-slate-800">
                      <div className="text-[11px] text-slate-400">Prev. Close</div>
                      <div className="font-semibold text-slate-100 mt-0.5">
                        {formatINR(activeTick?.prevClose ?? activeMeta.prevClose)}
                      </div>
                    </div>
                    <div className="bg-amber-950/30 rounded-lg px-3 py-2 border border-amber-500/30">
                      <div className="text-[11px] text-amber-400">3:30 Close / LTP</div>
                      <div className="font-semibold text-amber-300 mt-0.5">
                        {formatINR(activeTick?.price ?? activeMeta.basePrice)}
                      </div>
                    </div>
                  </div>
                </div>

                {/* Interactive HTML5 Candlestick + Technical Indicator Chart */}
                <CandlestickChart
                  symbol={selectedSymbol}
                  candles={candles}
                  indicators={indicators}
                  showSma={showSma}
                  showEma={showEma}
                  showBollinger={showBollinger}
                  onToggleSma={() => setShowSma((s) => !s)}
                  onToggleEma={() => setShowEma((s) => !s)}
                  onToggleBollinger={() => setShowBollinger((s) => !s)}
                />
              </>
            )}

            {/* ================= TAB 2: HOLDINGS & FIFO TAX LOTS ================= */}
            {activeTab === 'HOLDINGS_AND_LOTS' && livePortfolio && (
              <div className="space-y-4">
                <div className="bg-[#0D1421] rounded-xl border border-slate-800 p-4 space-y-2.5">
                  <div className="flex items-center justify-between gap-2 flex-wrap">
                    <h2 className="text-xs font-semibold text-slate-200">
                      Quick Route Navigation
                    </h2>
                    <span className="text-[11px] text-slate-400">
                      Jump directly to any page in your multi-route workspace
                    </span>
                  </div>
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                    <button
                      type="button"
                      onClick={() => navigateToTab('TERMINAL')}
                      className="flex items-center gap-2 px-3 py-2 rounded-lg bg-[#111A2B] hover:bg-slate-800 border border-slate-700/80 text-xs font-medium text-slate-200 transition cursor-pointer"
                    >
                      <Activity className="w-3.5 h-3.5 text-[#00D09C] shrink-0" />
                      <span className="truncate">Stocks & Charts</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => navigateToTab('BANK_AND_FUNDS')}
                      className="flex items-center gap-2 px-3 py-2 rounded-lg bg-[#111A2B] hover:bg-slate-800 border border-slate-700/80 text-xs font-medium text-slate-200 transition cursor-pointer"
                    >
                      <Landmark className="w-3.5 h-3.5 text-sky-400 shrink-0" />
                      <span className="truncate">3-in-1 Bank & UPI</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => navigateToTab('BROKER_IMPORT')}
                      className="flex items-center gap-2 px-3 py-2 rounded-lg bg-[#111A2B] hover:bg-slate-800 border border-slate-700/80 text-xs font-medium text-slate-200 transition cursor-pointer"
                    >
                      <FolderInput className="w-3.5 h-3.5 text-amber-400 shrink-0" />
                      <span className="truncate">Broker Import</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => navigateToTab('TAX_AND_CONTRACT_NOTE')}
                      className="flex items-center gap-2 px-3 py-2 rounded-lg bg-[#111A2B] hover:bg-slate-800 border border-slate-700/80 text-xs font-medium text-slate-200 transition cursor-pointer"
                    >
                      <ShieldAlert className="w-3.5 h-3.5 text-rose-400 shrink-0" />
                      <span className="truncate">SEBI Tax & Note</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => navigateToTab('AI_COPILOT')}
                      className="flex items-center gap-2 px-3 py-2 rounded-lg bg-[#111A2B] hover:bg-slate-800 border border-slate-700/80 text-xs font-medium text-slate-200 transition cursor-pointer"
                    >
                      <Sparkles className="w-3.5 h-3.5 text-[#00D09C] shrink-0" />
                      <span className="truncate">RAG Risk Copilot</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => navigateToTab('MARKET_NEWS')}
                      className="flex items-center gap-2 px-3 py-2 rounded-lg bg-[#111A2B] hover:bg-slate-800 border border-slate-700/80 text-xs font-medium text-slate-200 transition cursor-pointer"
                    >
                      <Flame className="w-3.5 h-3.5 text-orange-400 shrink-0" />
                      <span className="truncate">Market News</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => navigateToTab('ALERTS_AND_ORDERS')}
                      className="flex items-center gap-2 px-3 py-2 rounded-lg bg-[#111A2B] hover:bg-slate-800 border border-slate-700/80 text-xs font-medium text-slate-200 transition cursor-pointer"
                    >
                      <Bell className="w-3.5 h-3.5 text-amber-300 shrink-0" />
                      <span className="truncate">Orders & Alerts</span>
                    </button>
                  </div>
                </div>

                <div className="bg-[#0D1421] rounded-xl border border-slate-800 p-4 flex flex-wrap items-center justify-between gap-3">
                  <div className="flex items-center gap-1.5 flex-wrap">
                    <span className="text-xs font-bold text-slate-300 mr-1">Broker Filter:</span>
                    {(
                      [
                        'ALL',
                        'KitePulse Direct',
                        'SBI Securities',
                        'HDFC Sky',
                        'Groww',
                        'Zerodha Kite',
                      ] as const
                    ).map((b) => (
                      <button
                        key={b}
                        onClick={() => setBrokerFilter(b)}
                        className={`px-2.5 py-1 rounded-md text-xs font-semibold transition cursor-pointer ${
                          brokerFilter === b
                            ? 'bg-[#00B386] text-slate-950 font-bold'
                            : 'bg-[#111A2B] text-slate-300 border border-slate-800 hover:bg-slate-800'
                        }`}
                      >
                        {b === 'ALL' ? 'All Demat Accounts' : b}
                      </button>
                    ))}
                  </div>

                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => navigateToTab('BROKER_IMPORT')}
                      className="px-3 py-1.5 rounded-lg text-xs font-bold bg-emerald-600 text-white hover:bg-emerald-500 cursor-pointer flex items-center gap-1"
                    >
                      <Plus className="w-3.5 h-3.5" /> Authenticated Broker Import
                    </button>
                    {livePortfolio.holdings.length > 0 && (
                      <button
                        onClick={handleResetPortfolio}
                        className="px-3 py-1.5 rounded-lg text-xs font-bold bg-rose-950/60 text-[#FB7185] border border-rose-500/40 hover:bg-rose-900/50 cursor-pointer flex items-center gap-1"
                      >
                        <RotateCcw className="w-3.5 h-3.5" /> Reset to Empty (0)
                      </button>
                    )}
                  </div>
                </div>

                {filteredHoldings.length === 0 ? (
                  <div className="bg-[#0D1421] rounded-xl border border-dashed border-slate-700 p-10 text-center space-y-3">
                    <Wallet className="w-10 h-10 text-[#00D09C] mx-auto" />
                    <h3 className="text-base font-bold text-white">
                      0 Active Holdings in Demat Ledger
                    </h3>
                    <p className="text-xs text-slate-400 max-w-md mx-auto">
                      No external or synthetic positions are pre-filled. Execute a live order on the
                      right or import your verified portfolio via RBAC + CDSL TPIN authentication.
                    </p>
                  </div>
                ) : (
                  <div className="bg-[#0D1421] rounded-xl border border-slate-800 overflow-hidden shadow-md">
                    <div className="px-4 py-3 border-b border-slate-800 flex items-center justify-between bg-[#111A2B]">
                      <h3 className="text-xs font-semibold text-slate-200">
                        Verified NSE/BSE Demat Holdings ({filteredHoldings.length})
                      </h3>
                      <span className="text-xs font-mono text-[#00D09C]">
                        Valued at Real-Time NSE/BSE LTP
                      </span>
                    </div>
                    <div className="overflow-x-auto">
                      <table className="w-full text-left border-collapse text-xs">
                        <thead>
                          <tr className="border-b border-slate-800 text-[11px] font-mono text-slate-400 bg-[#0B111E]">
                            <th className="py-2.5 px-3">Instrument / Broker</th>
                            <th className="py-2.5 px-3 text-right">Qty</th>
                            <th className="py-2.5 px-3 text-right">FIFO Avg Cost</th>
                            <th className="py-2.5 px-3 text-right">Live LTP</th>
                            <th className="py-2.5 px-3 text-right">Cur. Value</th>
                            <th className="py-2.5 px-3 text-right">Net P&L</th>
                            <th className="py-2.5 px-3 text-center">Trade</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-800/70 font-mono">
                          {filteredHoldings.map((h) => {
                            const isGain = h.unrealizedPnl >= 0;
                            return (
                              <tr
                                key={h.symbol}
                                className={`hover:bg-slate-900/60 transition ${
                                  isGain
                                    ? 'border-l-4 border-l-[#00D09C]'
                                    : 'border-l-4 border-l-[#FB7185]'
                                }`}
                              >
                                <td className="py-2.5 px-3 font-sans">
                                  <div className="flex items-center gap-1.5">
                                    <button
                                      onClick={() => {
                                        setSelectedSymbol(h.symbol);
                                        navigateToTab('TERMINAL');
                                      }}
                                      className="font-bold text-white hover:text-[#00D09C] cursor-pointer"
                                    >
                                      {h.symbol}
                                    </button>
                                    <span className="text-[10px] font-mono px-1.5 py-0.2 rounded bg-slate-800 text-slate-300">
                                      {h.exchange}
                                    </span>
                                  </div>
                                  <div className="flex flex-wrap gap-1 mt-1">
                                    {h.brokers.map((b) => (
                                      <span
                                        key={b}
                                        className="text-[10px] px-1.5 py-0.2 rounded bg-amber-500/15 text-amber-300 border border-amber-500/30 font-medium"
                                      >
                                        {b}
                                      </span>
                                    ))}
                                  </div>
                                </td>
                                <td className="py-2.5 px-3 text-right font-bold text-slate-100">
                                  {h.quantity}
                                </td>
                                <td className="py-2.5 px-3 text-right text-slate-300">
                                  {formatINR(h.avgCostBasis)}
                                </td>
                                <td className="py-2.5 px-3 text-right font-bold text-white">
                                  {formatINR(h.currentPrice)}
                                </td>
                                <td className="py-2.5 px-3 text-right font-bold text-white">
                                  {formatINR(h.marketValue)}
                                </td>
                                <td
                                  className={`py-2.5 px-3 text-right font-bold ${
                                    isGain ? 'text-[#00D09C]' : 'text-[#FB7185]'
                                  }`}
                                >
                                  <div>
                                    {isGain ? '+' : ''}
                                    {formatINR(h.unrealizedPnl)}
                                  </div>
                                  <div className="text-[10px]">
                                    ({isGain ? '+' : ''}
                                    {h.unrealizedPnlPercent.toFixed(2)}%)
                                  </div>
                                </td>
                                <td className="py-2.5 px-3 text-center font-sans">
                                  <div className="flex items-center justify-center gap-1">
                                    <button
                                      onClick={() => {
                                        setSelectedSymbol(h.symbol);
                                        setOrderSide('BUY');
                                      }}
                                      className="px-2.5 py-1 rounded text-[11px] font-semibold bg-[#059669] text-white hover:bg-emerald-500 cursor-pointer"
                                    >
                                      Buy
                                    </button>
                                    <button
                                      onClick={() => {
                                        setSelectedSymbol(h.symbol);
                                        setOrderSide('SELL');
                                      }}
                                      className="px-2.5 py-1 rounded text-[11px] font-semibold bg-[#E11D48] text-white hover:bg-rose-500 cursor-pointer"
                                    >
                                      Sell
                                    </button>
                                  </div>
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}

                <RebalanceAndScannerPanel
                  portfolio={livePortfolio}
                  onSelectSymbol={(sym) => {
                    setSelectedSymbol(sym);
                    navigateToTab('TERMINAL');
                  }}
                />
              </div>
            )}

            {/* ================= TAB 3: 3-IN-1 INDIAN BANK & DEMAT FUNDS LEDGER ================= */}
            {activeTab === 'BANK_AND_FUNDS' && livePortfolio && (
              <div className="space-y-4">
                {bankActionBanner && (
                  <div className="p-3 rounded-lg bg-emerald-950/60 border border-emerald-500/40 text-xs font-semibold text-emerald-200 flex items-center justify-between">
                    <span>{bankActionBanner}</span>
                    <button
                      onClick={() => setBankActionBanner('')}
                      className="text-[#00D09C] hover:underline cursor-pointer"
                    >
                      Close
                    </button>
                  </div>
                )}

                {/* Linked Indian Bank Accounts Cards */}
                <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                  {livePortfolio.bankAccounts.map((bank) => (
                    <div
                      key={bank.id}
                      className="bg-[#0D1421] rounded-xl border border-slate-800 p-4 shadow-md flex flex-col justify-between"
                    >
                      <div>
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-xs font-extrabold text-white">
                            {bank.bankName}
                          </span>
                          {bank.isPrimaryThreeInOne && (
                            <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-amber-500/20 text-amber-300 border border-amber-500/30 font-semibold">
                              Primary 3-in-1
                            </span>
                          )}
                        </div>
                        <div className="text-[11px] font-mono text-slate-400 mt-1">
                          A/C: {bank.accountNumberMasked} • IFSC: {bank.ifscCode}
                        </div>
                        <div className="text-[11px] font-mono text-[#00D09C] mt-0.5">
                          UPI: {bank.upiId}
                        </div>
                      </div>
                      <div className="mt-3 pt-2.5 border-t border-slate-800 flex items-baseline justify-between">
                        <span className="text-[11px] text-slate-400">Available Bank Bal:</span>
                        <span className="text-base font-mono font-extrabold text-[#00D09C]">
                          {formatINR(bank.balance)}
                        </span>
                      </div>
                    </div>
                  ))}
                </div>

                {/* Atomic Bank <-> Demat Transfer Form + Link New Indian Bank */}
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <form
                    onSubmit={handleBankTransfer}
                    className="bg-[#0D1421] rounded-xl border border-slate-800 p-4 space-y-3"
                  >
                    <div className="flex items-center gap-2">
                      <ArrowRightLeft className="w-4 h-4 text-[#00D09C]" />
                      <h3 className="text-sm font-bold text-white">
                        Instant Bank ↔ Demat Funds Transfer (UPI / IMPS / ASBA)
                      </h3>
                    </div>

                    <div className="grid grid-cols-2 gap-2">
                      <button
                        type="button"
                        onClick={() => setTransferDirection('DEPOSIT_TO_DEMAT')}
                        className={`py-2 rounded-lg text-xs font-bold border transition cursor-pointer ${
                          transferDirection === 'DEPOSIT_TO_DEMAT'
                            ? 'bg-[#059669] text-white border-[#00D09C]'
                            : 'bg-[#111A2B] text-slate-300 border-slate-800'
                        }`}
                      >
                        + Add Funds to Demat
                      </button>
                      <button
                        type="button"
                        onClick={() => setTransferDirection('WITHDRAW_TO_BANK')}
                        className={`py-2 rounded-lg text-xs font-bold border transition cursor-pointer ${
                          transferDirection === 'WITHDRAW_TO_BANK'
                            ? 'bg-[#E11D48] text-white border-[#FB7185]'
                            : 'bg-[#111A2B] text-slate-300 border-slate-800'
                        }`}
                      >
                        - Withdraw to Bank
                      </button>
                    </div>

                    <div>
                      <label className="block text-[11px] font-semibold text-slate-300 mb-1">
                        Select Linked Indian Bank Account
                      </label>
                      <select
                        value={transferBankId}
                        onChange={(e) => setTransferBankId(Number(e.target.value))}
                        className="w-full px-3 py-2 text-xs rounded-lg border border-slate-700 bg-[#070B12] text-slate-100 font-medium"
                      >
                        {livePortfolio.bankAccounts.map((b) => (
                          <option key={b.id} value={b.id}>
                            {b.bankName} ({b.accountNumberMasked}) — Bal: {formatINR(b.balance)}
                          </option>
                        ))}
                      </select>
                    </div>

                    <div className="grid grid-cols-2 gap-2">
                      <div>
                        <label className="block text-[11px] font-semibold text-slate-300 mb-1">
                          Payment Rail
                        </label>
                        <select
                          value={transferMethod}
                          onChange={(e) =>
                            setTransferMethod(
                              e.target.value as 'UPI' | 'NETBANKING' | 'IMPS' | 'ASBA_3IN1'
                            )
                          }
                          className="w-full px-3 py-2 text-xs rounded-lg border border-slate-700 bg-[#070B12] text-slate-100 font-mono"
                        >
                          <option value="UPI">UPI Instant (Zero Fee)</option>
                          <option value="ASBA_3IN1">3-in-1 Bank ASBA Sweep</option>
                          <option value="NETBANKING">NetBanking (NEFT/RTGS)</option>
                          <option value="IMPS">IMPS Immediate</option>
                        </select>
                      </div>
                      <div>
                        <label className="block text-[11px] font-semibold text-slate-300 mb-1">
                          Amount (₹ INR)
                        </label>
                        <input
                          type="number"
                          min="1"
                          step="any"
                          value={transferAmount}
                          onChange={(e) => setTransferAmount(e.target.value)}
                          className="w-full px-3 py-2 text-xs font-mono font-bold rounded-lg border border-slate-700 bg-[#070B12] text-white"
                        />
                      </div>
                    </div>

                    <button
                      type="submit"
                      className={`w-full py-2.5 rounded-lg text-xs font-bold text-white shadow-xs transition cursor-pointer ${
                        transferDirection === 'DEPOSIT_TO_DEMAT'
                          ? 'bg-[#059669] hover:bg-emerald-500'
                          : 'bg-[#E11D48] hover:bg-rose-500'
                      }`}
                    >
                      {transferDirection === 'DEPOSIT_TO_DEMAT'
                        ? `Instant Deposit ${formatINR(Number(transferAmount) || 0)} to Demat`
                        : `Instant Withdraw ${formatINR(Number(transferAmount) || 0)} to Bank`}
                    </button>
                  </form>

                  {/* Link Any Leading Indian Bank Form */}
                  <form
                    onSubmit={handleLinkNewBank}
                    className="bg-[#0D1421] rounded-xl border border-slate-800 p-4 space-y-2.5"
                  >
                    <div className="flex items-center gap-2">
                      <Building2 className="w-4 h-4 text-amber-400" />
                      <h3 className="text-sm font-bold text-white">
                        Link Another Indian Bank Account (SBI / HDFC / ICICI / Axis / Kotak / PNB)
                      </h3>
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      <div>
                        <label className="block text-[11px] text-slate-400 mb-0.5">Bank Name</label>
                        <input
                          type="text"
                          value={newBankName}
                          onChange={(e) => setNewBankName(e.target.value)}
                          className="w-full px-2.5 py-1.5 text-xs rounded border border-slate-700 bg-[#070B12] text-slate-100"
                        />
                      </div>
                      <div>
                        <label className="block text-[11px] text-slate-400 mb-0.5">IFSC Code</label>
                        <input
                          type="text"
                          value={newBankIfsc}
                          onChange={(e) => setNewBankIfsc(e.target.value)}
                          className="w-full px-2.5 py-1.5 text-xs font-mono rounded border border-slate-700 bg-[#070B12] text-slate-100"
                        />
                      </div>
                      <div>
                        <label className="block text-[11px] text-slate-400 mb-0.5">
                          Masked Account No.
                        </label>
                        <input
                          type="text"
                          value={newBankAcct}
                          onChange={(e) => setNewBankAcct(e.target.value)}
                          className="w-full px-2.5 py-1.5 text-xs font-mono rounded border border-slate-700 bg-[#070B12] text-slate-100"
                        />
                      </div>
                      <div>
                        <label className="block text-[11px] text-slate-400 mb-0.5">UPI ID</label>
                        <input
                          type="text"
                          value={newBankUpi}
                          onChange={(e) => setNewBankUpi(e.target.value)}
                          className="w-full px-2.5 py-1.5 text-xs font-mono rounded border border-slate-700 bg-[#070B12] text-slate-100"
                        />
                      </div>
                    </div>
                    <div>
                      <label className="block text-[11px] text-slate-400 mb-0.5">
                        Bank Balance (₹)
                      </label>
                      <input
                        type="number"
                        value={newBankBalance}
                        onChange={(e) => setNewBankBalance(e.target.value)}
                        className="w-full px-2.5 py-1.5 text-xs font-mono rounded border border-slate-700 bg-[#070B12] text-slate-100"
                      />
                    </div>
                    <button
                      type="submit"
                      className="w-full py-2 rounded-lg text-xs font-bold bg-[#111A2B] text-[#00D09C] border border-emerald-500/30 hover:bg-slate-800 cursor-pointer"
                    >
                      + Link Indian Bank Account via NPCI / AA
                    </button>
                  </form>
                </div>

                {/* Bank Passbook & 3-in-1 Settlement Audit Log */}
                <div className="bg-[#0D1421] rounded-xl border border-slate-800 overflow-hidden">
                  <div className="px-4 py-2.5 bg-[#111A2B] border-b border-slate-800 text-xs font-bold text-slate-200">
                    Bank ↔ Demat Double-Entry Passbook ({livePortfolio.bankTransactions.length})
                  </div>
                  <div className="divide-y divide-slate-800/70 max-h-60 overflow-y-auto text-xs">
                    {livePortfolio.bankTransactions.map((tx) => {
                      const isCreditToDemat =
                        tx.type === 'DEPOSIT_TO_DEMAT' || tx.type === 'THREE_IN_ONE_BUY_DEBIT';
                      return (
                        <div
                          key={tx.id}
                          className="px-4 py-2.5 flex items-center justify-between gap-2"
                        >
                          <div>
                            <div className="font-semibold text-slate-100">
                              {tx.bankName}{' '}
                              <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-slate-800 text-slate-300">
                                {tx.method}
                              </span>
                            </div>
                            <div className="text-[11px] text-slate-400">{tx.referenceNote}</div>
                          </div>
                          <div className="text-right font-mono">
                            <div
                              className={`font-bold ${
                                isCreditToDemat ? 'text-[#00D09C]' : 'text-[#FB7185]'
                              }`}
                            >
                              {formatINR(tx.amount)}
                            </div>
                            <div className="text-[10px] text-slate-500">
                              {new Date(tx.createdAt).toLocaleTimeString('en-IN')}
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>
            )}

            {/* ================= TAB 4: EXTERNAL BROKER PORTFOLIO IMPORTER (RBAC + CDSL TPIN + WEBHOOK ACK) ================= */}
            {activeTab === 'BROKER_IMPORT' && (
              <div className="space-y-4">
                {importBanner && (
                  <div className="p-3 rounded-lg bg-emerald-950/60 border border-emerald-500/40 text-xs font-medium text-emerald-200 flex items-center justify-between gap-2">
                    <span>{importBanner}</span>
                    <button
                      onClick={() => navigateToTab('HOLDINGS_AND_LOTS')}
                      className="px-2.5 py-1 rounded bg-[#059669] text-white font-semibold cursor-pointer shrink-0"
                    >
                      View Holdings →
                    </button>
                  </div>
                )}

                <form
                  onSubmit={handleImportCsvSubmit}
                  className="bg-[#0D1421] rounded-xl border border-slate-800 p-4 space-y-4"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-800 pb-3">
                    <div>
                      <h3 className="text-sm font-semibold text-white">
                        Authenticated External Broker Import (RBAC & CDSL TPIN Verification)
                      </h3>
                      <p className="text-xs text-slate-400 mt-0.5">
                        Verifies account ownership before importing and dispatches an export
                        notification receipt to your source broker.
                      </p>
                    </div>
                  </div>

                  {/* RBAC Role + Source Broker + CDSL Credentials Grid */}
                  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3">
                    <div>
                      <label className="block text-[11px] font-medium text-slate-300 mb-1">
                        RBAC Access Role
                      </label>
                      <select
                        value={rbacRole}
                        onChange={(e) => setRbacRole(e.target.value as RbacRole)}
                        className="w-full px-2.5 py-2 text-xs rounded-lg border border-slate-700 bg-[#070B12] text-slate-100"
                      >
                        <option value="OWNER_ADMIN">Owner Admin (Full Access)</option>
                        <option value="PORTFOLIO_IMPORTER">Verified Importer</option>
                        <option value="AUDITOR_READ_ONLY">Auditor (Read-Only)</option>
                      </select>
                    </div>

                    <div>
                      <label className="block text-[11px] font-medium text-slate-300 mb-1">
                        Source Demat Broker
                      </label>
                      <select
                        value={selectedImportBroker}
                        onChange={(e) =>
                          setSelectedImportBroker(
                            e.target.value as Exclude<BrokerSource, 'KitePulse Direct'>
                          )
                        }
                        className="w-full px-2.5 py-2 text-xs rounded-lg border border-slate-700 bg-[#070B12] text-slate-100"
                      >
                        <option value="Zerodha Kite">Zerodha Kite</option>
                        <option value="SBI Securities">SBI Securities</option>
                        <option value="HDFC Sky">HDFC Sky</option>
                        <option value="Groww">Groww</option>
                        <option value="Angel One">Angel One</option>
                      </select>
                    </div>

                    <div>
                      <label className="block text-[11px] font-medium text-slate-300 mb-1">
                        CDSL 16-Digit BOID
                      </label>
                      <input
                        type="text"
                        value={cdslBoId}
                        onChange={(e) => setCdslBoId(e.target.value)}
                        placeholder="1208160098412231"
                        className="w-full px-2.5 py-2 text-xs font-mono rounded-lg border border-slate-700 bg-[#070B12] text-slate-100"
                      />
                    </div>

                    <div>
                      <label className="block text-[11px] font-medium text-slate-300 mb-1">
                        CDSL 6-Digit TPIN
                      </label>
                      <input
                        type="password"
                        value={cdslTpin}
                        onChange={(e) => setCdslTpin(e.target.value)}
                        placeholder="••••••"
                        className="w-full px-2.5 py-2 text-xs font-mono rounded-lg border border-slate-700 bg-[#070B12] text-slate-100"
                      />
                    </div>

                    <div>
                      <label className="block text-[11px] font-medium text-slate-300 mb-1">
                        Broker 2FA OTP
                      </label>
                      <input
                        type="text"
                        value={otpCode}
                        onChange={(e) => setOtpCode(e.target.value)}
                        placeholder="6-digit OTP"
                        className="w-full px-2.5 py-2 text-xs font-mono rounded-lg border border-slate-700 bg-[#070B12] text-slate-100"
                      />
                    </div>
                  </div>

                  <div>
                    <label className="block text-xs font-medium text-slate-300 mb-1">
                      Holdings to Import (Format: <code className="font-mono text-[#00D09C]">SYMBOL,QUANTITY,AVG_BUY_PRICE</code> — one per line)
                    </label>
                    <textarea
                      rows={4}
                      value={csvImportText}
                      onChange={(e) => setCsvImportText(e.target.value)}
                      placeholder={'RELIANCE,15,1320.50\nSBIN,40,1045.00\nTCS,10,2425.00'}
                      className="w-full p-3 text-xs font-mono rounded-lg border border-slate-700 bg-[#070B12] text-slate-100 placeholder:text-slate-600 focus:outline-none focus:border-emerald-500"
                    />
                  </div>

                  <div className="flex items-center justify-between flex-wrap gap-2">
                    <span className="text-[11px] text-slate-400">
                      All imported shares are valued strictly at live NSE/BSE prices with zero synthetic data.
                    </span>
                    <button
                      type="submit"
                      className="px-4 py-2 rounded-lg text-xs font-semibold bg-[#059669] text-white hover:bg-emerald-500 cursor-pointer flex items-center gap-1.5"
                    >
                      <Upload className="w-3.5 h-3.5" />
                      <span>Verify Ownership & Import from {selectedImportBroker}</span>
                    </button>
                  </div>
                </form>

                {/* Outbound Broker Export Notification Audit Log */}
                <div className="bg-[#0D1421] rounded-xl border border-slate-800 overflow-hidden">
                  <div className="px-4 py-2.5 bg-[#111A2B] border-b border-slate-800 flex items-center justify-between text-xs font-semibold text-slate-200">
                    <span>Outbound Broker Export Notification Log ({brokerNotifications.length})</span>
                    <span className="text-[11px] font-mono text-[#00D09C]">
                      Bi-Directional CDSL Webhook Ack
                    </span>
                  </div>
                  {brokerNotifications.length === 0 ? (
                    <div className="p-6 text-center text-xs text-slate-400">
                      No external broker exports triggered yet in this session. When you import
                      holdings above, the source broker (Zerodha, SBI Securities, HDFC Sky, or
                      Groww) receives an immediate export notification receipt here.
                    </div>
                  ) : (
                    <div className="divide-y divide-slate-800/70 text-xs">
                      {brokerNotifications.map((n) => (
                        <div
                          key={n.notificationId}
                          className="p-3.5 flex flex-wrap items-center justify-between gap-2"
                        >
                          <div className="space-y-0.5">
                            <div className="flex flex-wrap items-center gap-2">
                              <span className="font-semibold text-white">{n.broker}</span>
                              <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-emerald-950/80 text-[#00D09C] border border-emerald-500/30">
                                {n.status}
                              </span>
                              <span className="text-[11px] font-mono text-slate-400">
                                ID: {n.notificationId} • BOID: {n.cdslBoId}
                              </span>
                              {n.pbkdf2DigestPrefix && (
                                <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-slate-800 text-amber-300 border border-slate-700">
                                  {n.pbkdf2DigestPrefix}
                                </span>
                              )}
                            </div>
                            <p className="text-slate-300">{n.message}</p>
                          </div>
                          <div className="text-right font-mono text-[11px] text-slate-400">
                            <div>Role: {n.rbacRole}</div>
                            <div>{new Date(n.timestamp).toLocaleTimeString('en-IN')}</div>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* ================= TAB 4B: SEBI CONTRACT NOTE & STCG/LTCG TAX ENGINE ================= */}
            {activeTab === 'TAX_AND_CONTRACT_NOTE' && taxReport && livePortfolio && (
              <div className="space-y-4">
                <div className="grid grid-cols-1 sm:grid-cols-4 gap-3 font-mono">
                  <div className="bg-[#0D1421] rounded-xl border border-slate-800 p-3.5">
                    <div className="text-[11px] text-slate-400">Realized STCG Gains</div>
                    <div className="text-base font-bold text-[#00D09C] mt-1">
                      {formatINR(taxReport.realizedStcgGross)}
                    </div>
                    <div className="text-[11px] text-slate-500 mt-0.5">Sec 111A (20% + 4% Cess)</div>
                  </div>
                  <div className="bg-[#0D1421] rounded-xl border border-rose-500/30 p-3.5">
                    <div className="text-[11px] text-rose-300">Est. STCG Tax Liability</div>
                    <div className="text-base font-bold text-[#FB7185] mt-1">
                      {formatINR(taxReport.estimatedStcgTax)}
                    </div>
                    <div className="text-[11px] text-slate-500 mt-0.5">Effective Rate: 20.8%</div>
                  </div>
                  <div className="bg-emerald-950/25 rounded-xl border border-emerald-500/30 p-3.5">
                    <div className="text-[11px] text-emerald-300">
                      Harvestable Tax Savings
                    </div>
                    <div className="text-base font-bold text-[#00D09C] mt-1">
                      {formatINR(taxReport.potentialTaxSavingsViaHarvesting)}
                    </div>
                    <div className="text-[11px] text-emerald-400/80 mt-0.5">
                      Via FIFO Loss Offset
                    </div>
                  </div>
                  <div className="bg-amber-950/25 rounded-xl border border-amber-500/30 p-3.5">
                    <div className="text-[11px] text-amber-300">
                      Sec 112A LTCG Exemption
                    </div>
                    <div className="text-base font-bold text-amber-400 mt-1">
                      {formatINR(taxReport.ltcgExemptionLimit)}
                    </div>
                    <div className="text-[11px] text-amber-400/80 mt-0.5">
                      12.5% above ₹1.25 Lakh
                    </div>
                  </div>
                </div>

                {/* Tax-Loss Harvesting Candidates */}
                <div className="bg-[#0D1421] rounded-xl border border-slate-800 p-4 space-y-2.5">
                  <h3 className="text-sm font-semibold text-white">
                    FIFO Tax-Loss Harvesting Opportunities (FY 2026-27)
                  </h3>
                  {taxReport.harvestCandidates.length === 0 ? (
                    <p className="text-xs text-slate-400">
                      Zero positions currently in unrealized loss.
                    </p>
                  ) : (
                    <div className="divide-y divide-slate-800 text-xs font-mono">
                      {taxReport.harvestCandidates.map((cand) => (
                        <div
                          key={cand.symbol}
                          className="py-2 flex items-center justify-between gap-2"
                        >
                          <div>
                            <span className="font-semibold text-white">{cand.symbol}</span>{' '}
                            <span className="text-slate-400">
                              ({cand.quantity} units @ avg {formatINR(cand.avgCostBasis)})
                            </span>
                          </div>
                          <div className="text-right">
                            <span className="text-[#FB7185] font-semibold mr-3">
                              Loss: -{formatINR(cand.unrealizedLoss)}
                            </span>
                            <span className="px-2 py-0.5 rounded bg-emerald-950/80 text-[#00D09C] border border-emerald-500/30 font-semibold">
                              Saves {formatINR(cand.potentialStcgTaxSaved)} STCG Tax
                            </span>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                {/* SEBI Statutory Contract Note Ledger */}
                <div className="bg-[#0D1421] rounded-xl border border-slate-800 overflow-hidden">
                  <div className="px-4 py-2.5 bg-[#111A2B] border-b border-slate-800 text-white text-xs font-semibold flex items-center justify-between">
                    <span>SEBI Electronic Contract Note & Statutory Breakdown</span>
                    <span className="text-[11px] font-mono text-[#00D09C]">
                      STT • Exchange Turnover • SEBI • Stamp Duty • 18% GST • CDSL DP
                    </span>
                  </div>
                  <div className="p-4 text-xs font-mono space-y-2">
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 bg-[#070B12] p-3 rounded-lg border border-slate-800">
                      <div>
                        <div className="text-[11px] text-slate-400">Selected Trade</div>
                        <div className="font-semibold text-white">
                          {orderSide} {orderQty} {selectedSymbol}
                        </div>
                      </div>
                      <div>
                        <div className="text-[11px] text-slate-400">STT / CTT</div>
                        <div className="font-semibold text-white">
                          {formatINR(statutoryBreakdown.stt)}
                        </div>
                      </div>
                      <div>
                        <div className="text-[11px] text-slate-400">
                          Stamp Duty + DP Charge
                        </div>
                        <div className="font-semibold text-white">
                          {formatINR(
                            statutoryBreakdown.stampDuty + statutoryBreakdown.dpCharge
                          )}
                        </div>
                      </div>
                      <div>
                        <div className="text-[11px] text-slate-400">
                          Total Statutory Charges
                        </div>
                        <div className="font-semibold text-[#FB7185]">
                          {formatINR(statutoryBreakdown.totalCharges)}
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* ================= TAB 4C: LIVE INDIAN STOCK MARKET & COMMODITY NEWS ================= */}
            {activeTab === 'MARKET_NEWS' && (
              <div className="space-y-4">
                <div className="bg-[#0D1421] rounded-xl border border-slate-800 p-4 flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <h3 className="text-sm font-semibold text-white">
                      Indian Stock Market & Commodity News
                    </h3>
                    <p className="text-xs text-slate-400 mt-0.5">
                      Live market headlines across NSE, BSE, MCX Gold & Silver, and Mutual Funds
                    </p>
                  </div>
                  <button
                    onClick={async () => {
                      const res = await fetch('/api/news');
                      if (res.ok) {
                        const data = (await res.json()) as { news: NewsItem[] };
                        setNews(data.news);
                      }
                    }}
                    className="px-3 py-1.5 rounded-lg text-xs font-semibold bg-[#059669] text-white hover:bg-emerald-500 cursor-pointer flex items-center gap-1.5"
                  >
                    <RefreshCw className="w-3.5 h-3.5" /> Refresh News
                  </button>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  {news.map((item) => {
                    const isBull = item.sentiment === 'BULLISH';
                    return (
                      <div
                        key={item.id}
                        className={`bg-[#0D1421] rounded-xl border border-slate-800 border-l-4 p-4 flex flex-col justify-between gap-3 ${
                          isBull ? 'border-l-[#00D09C]' : 'border-l-[#FB7185]'
                        }`}
                      >
                        <div>
                          <div className="flex items-center justify-between gap-2">
                            <div className="flex items-center gap-2">
                              <span className="px-2 py-0.5 rounded bg-slate-800 text-white text-xs font-semibold">
                                {item.symbol}
                              </span>
                              <span className="text-xs text-slate-400">
                                {item.source} • {item.publishedAt}
                              </span>
                            </div>
                            <span
                              className={`px-2 py-0.5 rounded-full text-xs font-medium ${
                                isBull
                                  ? 'bg-emerald-950/80 text-[#00D09C] border border-emerald-500/30'
                                  : 'bg-rose-950/80 text-[#FB7185] border border-rose-500/30'
                              }`}
                            >
                              {isBull ? 'Positive' : 'Negative'}
                            </span>
                          </div>
                          <h4 className="text-sm font-semibold text-white mt-2 leading-snug">
                            {item.headline}
                          </h4>
                          <p className="text-xs text-slate-400 mt-1.5 leading-relaxed">
                            {item.summary}
                          </p>
                        </div>
                        <div className="flex items-center justify-between pt-2 border-t border-slate-800">
                          <span className="text-xs text-slate-400">
                            Impact: <strong className="text-slate-200">{item.impactScore}/10</strong>
                          </span>
                          <button
                            onClick={() => {
                              setSelectedSymbol(item.symbol);
                              navigateToTab('TERMINAL');
                            }}
                            className={`px-3 py-1 rounded-lg text-xs font-semibold text-white cursor-pointer ${
                              isBull
                                ? 'bg-[#059669] hover:bg-emerald-500'
                                : 'bg-[#E11D48] hover:bg-rose-500'
                            }`}
                          >
                            View {item.symbol} →
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* ================= TAB 5: GEMINI 3.8 FLASH RISK COPILOT & QUANT VAR ENGINE ================= */}
            {activeTab === 'AI_COPILOT' && (
              <div className="space-y-4">
                {quantRisk && (
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 font-mono">
                    <div className="bg-[#0D1421] rounded-xl border border-slate-800 p-3.5">
                      <div className="text-[11px] text-slate-400">1-Day 95% VaR</div>
                      <div className="text-base font-bold text-[#FB7185] mt-1">
                        {formatINR(quantRisk.var95DailyINR)}
                      </div>
                      <div className="text-[11px] text-slate-500 mt-0.5">
                        10-Day VaR: {formatINR(quantRisk.var95TenDayINR)}
                      </div>
                    </div>
                    <div className="bg-[#0D1421] rounded-xl border border-slate-800 p-3.5">
                      <div className="text-[11px] text-slate-400">Sharpe Ratio (vs 6.8% G-Sec)</div>
                      <div className="text-base font-bold text-[#00D09C] mt-1">
                        {quantRisk.sharpeRatio.toFixed(2)}
                      </div>
                      <div className="text-[11px] text-slate-500 mt-0.5">
                        Sortino: {quantRisk.sortinoRatio.toFixed(2)}
                      </div>
                    </div>
                    <div className="bg-[#0D1421] rounded-xl border border-slate-800 p-3.5">
                      <div className="text-[11px] text-slate-400">Annualized Volatility</div>
                      <div className="text-base font-bold text-amber-400 mt-1">
                        {quantRisk.annualizedVolatilityPercent.toFixed(2)}%
                      </div>
                      <div className="text-[11px] text-slate-500 mt-0.5">
                        Daily: {quantRisk.dailyVolatilityPercent.toFixed(2)}%
                      </div>
                    </div>
                    <div className="bg-[#0D1421] rounded-xl border border-slate-800 p-3.5">
                      <div className="text-[11px] text-slate-400">HHI Concentration</div>
                      <div className="text-base font-bold text-white mt-1">
                        {quantRisk.hhiConcentrationIndex}
                      </div>
                      <div className="text-[11px] text-slate-500 mt-0.5">
                        Diversification: {quantRisk.diversificationScore}/100
                      </div>
                    </div>
                  </div>
                )}

                <div className="bg-[#0D1421] rounded-xl border border-slate-800 p-4 space-y-3">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <Sparkles className="w-4 h-4 text-[#00D09C]" />
                      <h3 className="text-sm font-semibold text-white">
                        Portfolio Risk & Stress-Test Analysis
                      </h3>
                    </div>
                    <button
                      onClick={() => runCopilotAudit(copilotQuestion)}
                      disabled={copilotLoading}
                      className="px-3 py-1.5 rounded-lg text-xs font-semibold bg-[#059669] text-white hover:bg-emerald-500 cursor-pointer disabled:opacity-50"
                    >
                      {copilotLoading ? 'Analyzing...' : 'Run Risk Audit'}
                    </button>
                  </div>

                  <div className="flex gap-2">
                    <input
                      type="text"
                      value={copilotQuestion}
                      onChange={(e) => setCopilotQuestion(e.target.value)}
                      placeholder="Ask e.g. 'What happens to my portfolio if Nifty 50 drops 4%?'"
                      className="flex-1 px-3 py-2 text-xs rounded-lg border border-slate-700 bg-[#070B12] text-slate-100 placeholder:text-slate-500"
                    />
                    <button
                      onClick={() => runCopilotAudit(copilotQuestion)}
                      className="px-4 py-2 rounded-lg text-xs font-semibold bg-[#111A2B] text-[#00D09C] border border-emerald-500/30 cursor-pointer"
                    >
                      Analyze
                    </button>
                  </div>

                  {aiAnalysis && (
                    <div className="space-y-3 pt-2">
                      <div className="p-3 rounded-lg bg-[#070B12] border border-slate-800 text-xs">
                        <div className="font-semibold text-white mb-1">
                          Summary ({aiAnalysis.modelUsed}):
                        </div>
                        <p className="text-slate-300">{aiAnalysis.executiveSummary}</p>
                        {aiAnalysis.queryAnswer && (
                          <p className="mt-2 font-medium text-[#00D09C] bg-emerald-950/40 p-2 rounded border border-emerald-500/30">
                            {aiAnalysis.queryAnswer}
                          </p>
                        )}
                      </div>

                      <div className="grid grid-cols-1 md:grid-cols-3 gap-2.5">
                        {aiAnalysis.stressTestScenarios.map((sc) => (
                          <div
                            key={sc.scenarioName}
                            className="p-3 rounded-lg border border-rose-500/30 bg-rose-950/20 text-xs"
                          >
                            <div className="font-semibold text-white">{sc.scenarioName}</div>
                            <div className="font-mono text-sm font-bold text-[#FB7185] mt-1">
                              {formatINR(sc.estimatedPnlImpact)} ({sc.estimatedPnlPercent}%)
                            </div>
                            <p className="text-[11px] text-slate-400 mt-1">{sc.explanation}</p>
                          </div>
                        ))}
                      </div>

                      {/* Inspectable Local SQLite RAG Retrieval Chunks */}
                      {aiAnalysis.ragChunksUsed && aiAnalysis.ragChunksUsed.length > 0 && (
                        <div className="bg-[#070B12] rounded-xl border border-slate-800 p-3.5 space-y-2">
                          <div className="flex items-center justify-between text-xs font-semibold text-slate-200">
                            <span>
                              4-Stage Local SQLite RAG Context Retrieval ({aiAnalysis.ragChunksUsed.length} chunks grounded)
                            </span>
                            <span className="text-[11px] text-[#00D09C]">Zero Hallucination Lock</span>
                          </div>
                          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-xs">
                            {aiAnalysis.ragChunksUsed.map((chunk) => (
                              <div
                                key={chunk.chunkId}
                                className="p-2.5 rounded-lg bg-[#0D1421] border border-slate-800 space-y-1"
                              >
                                <div className="flex items-center justify-between gap-2">
                                  <span className="font-semibold text-white">{chunk.title}</span>
                                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-950/70 text-[#00D09C] border border-emerald-500/30">
                                    Match {(chunk.similarityScore * 100).toFixed(0)}%
                                  </span>
                                </div>
                                <div className="text-[10px] text-amber-300/90">
                                  {chunk.chunkId} • Source: {chunk.sourceTable}
                                </div>
                                <p className="text-[11px] text-slate-400 leading-relaxed">
                                  {chunk.content}
                                </p>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}

                      {/* Human-in-the-Loop Copilot Trade Staging */}
                      {aiAnalysis.proposedActions && aiAnalysis.proposedActions.length > 0 && (
                        <div className="bg-[#070B12] rounded-xl border border-slate-800 p-3.5 space-y-2">
                          <div className="flex items-center justify-between text-xs font-semibold text-slate-200">
                            <span>Human-in-the-Loop Rebalance Proposals</span>
                            <span className="text-[11px] text-slate-400">
                              Staged for your manual approval (never auto-executed)
                            </span>
                          </div>
                          <div className="divide-y divide-slate-800 text-xs">
                            {aiAnalysis.proposedActions.map((act, idx) => (
                              <div
                                key={`${act.symbol}-${idx}`}
                                className="py-2 flex flex-wrap items-center justify-between gap-2"
                              >
                                <div>
                                  <span
                                    className={`px-1.5 py-0.5 rounded text-[10px] font-semibold mr-2 ${
                                      act.side === 'BUY'
                                        ? 'bg-emerald-950 text-[#00D09C] border border-emerald-500/30'
                                        : 'bg-rose-950 text-[#FB7185] border border-rose-500/30'
                                    }`}
                                  >
                                    {act.side} {act.quantity}
                                  </span>
                                  <span className="font-semibold text-white">{act.symbol}</span>
                                  <span className="text-slate-400 ml-2">{act.rationale}</span>
                                </div>
                                <button
                                  type="button"
                                  onClick={() => {
                                    setSelectedSymbol(act.symbol);
                                    setOrderSide(act.side);
                                    setOrderQty(String(act.quantity));
                                    navigateToTab('TERMINAL');
                                  }}
                                  className="px-2.5 py-1 rounded text-[11px] font-semibold bg-[#111A2B] text-[#00D09C] border border-emerald-500/30 hover:bg-slate-800 cursor-pointer"
                                >
                                  Stage in Order Ticket →
                                </button>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </div>

                {livePortfolio && (
                  <>
                    <RebalanceAndScannerPanel
                      portfolio={livePortfolio}
                      onSelectSymbol={(sym) => {
                        setSelectedSymbol(sym);
                        navigateToTab('TERMINAL');
                      }}
                    />
                    <StepUpSipAndCsvPanel portfolio={livePortfolio} taxReport={taxReport} />
                  </>
                )}
              </div>
            )}

            {/* ================= TAB 6: PRICE ALERTS & ACID ORDER BOOK ================= */}
            {activeTab === 'ALERTS_AND_ORDERS' && (
              <div className="space-y-4">
                <form
                  onSubmit={handleCreateAlert}
                  className="bg-[#0D1421] rounded-xl border border-slate-800 p-4 flex flex-wrap items-end gap-2.5"
                >
                  <div>
                    <label className="block text-[11px] font-medium text-slate-300 mb-1">
                      Symbol
                    </label>
                    <input
                      type="text"
                      readOnly
                      value={selectedSymbol}
                      className="px-3 py-1.5 text-xs font-mono font-semibold bg-[#070B12] text-white rounded border border-slate-700 w-28"
                    />
                  </div>
                  <div>
                    <label className="block text-[11px] font-medium text-slate-300 mb-1">
                      Condition
                    </label>
                    <select
                      value={alertDirection}
                      onChange={(e) => setAlertDirection(e.target.value as AlertDirection)}
                      className="px-3 py-1.5 text-xs rounded border border-slate-700 bg-[#070B12] text-slate-100"
                    >
                      <option value="ABOVE">Crosses Above</option>
                      <option value="BELOW">Drops Below</option>
                    </select>
                  </div>
                  <div>
                    <label className="block text-[11px] font-medium text-slate-300 mb-1">
                      Target Price (₹)
                    </label>
                    <input
                      type="number"
                      step="any"
                      value={alertTargetPrice}
                      onChange={(e) => setAlertTargetPrice(e.target.value)}
                      placeholder={String(activeTick?.price ?? 1000)}
                      className="px-3 py-1.5 text-xs font-mono rounded border border-slate-700 bg-[#070B12] text-white w-32"
                    />
                  </div>
                  <button
                    type="submit"
                    className="px-4 py-1.5 rounded-lg text-xs font-semibold bg-[#059669] text-white cursor-pointer"
                  >
                    + Set Alert
                  </button>
                </form>

                <div className="bg-[#0D1421] rounded-xl border border-slate-800 overflow-hidden">
                  <div className="px-4 py-2.5 bg-[#111A2B] border-b border-slate-800 text-xs font-semibold text-slate-200">
                    Executed Orders ({livePortfolio?.recentOrders.length ?? 0})
                  </div>
                  <div className="divide-y divide-slate-800/70 max-h-80 overflow-y-auto text-xs font-mono">
                    {(livePortfolio?.recentOrders ?? []).map((ord) => (
                      <div
                        key={ord.id}
                        className="px-4 py-2.5 flex items-center justify-between"
                      >
                        <div>
                          <span
                            className={`px-1.5 py-0.5 rounded font-semibold mr-2 ${
                              ord.side === 'BUY'
                                ? 'bg-emerald-950/80 text-[#00D09C] border border-emerald-500/30'
                                : 'bg-rose-950/80 text-[#FB7185] border border-rose-500/30'
                            }`}
                          >
                            {ord.side}
                          </span>
                          <span className="font-semibold text-white">
                            {ord.quantity} {ord.symbol}
                          </span>{' '}
                          <span className="text-slate-300">@ {formatINR(ord.executionPrice)}</span>
                          <span className="ml-2 text-[10px] px-1.5 py-0.5 rounded bg-slate-800 text-slate-300">
                            {ord.brokerSource}
                          </span>
                        </div>
                        <div className="text-right">
                          <div className="font-semibold text-white">
                            {formatINR(ord.totalNotional)}
                          </div>
                          {ord.side === 'SELL' && (
                            <div
                              className={`text-[10px] ${
                                ord.realizedPnl >= 0 ? 'text-[#00D09C]' : 'text-[#FB7185]'
                              }`}
                            >
                              FIFO P&L: {ord.realizedPnl >= 0 ? '+' : ''}
                              {formatINR(ord.realizedPnl)}
                            </div>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            )}
          </div>
        </main>

        {/* RIGHT COLUMN (3 COLS): ORDER EXECUTION & MARKET DEPTH */}
        <aside className="lg:col-span-3 bg-[#0B111E] border-l border-slate-800 p-4 flex flex-col gap-4 h-[calc(100vh-88px)] sticky top-[88px] overflow-y-auto">
          {/* Order Ticket */}
          <div
            className={`rounded-xl border p-4 shadow-md transition-colors bg-[#0D1421] ${
              orderSide === 'BUY'
                ? 'border-emerald-500/40'
                : 'border-rose-500/40'
            }`}
          >
            {/* Buy vs Sell Toggle Header */}
            <div className="grid grid-cols-2 gap-2 p-1 rounded-lg bg-[#070B12] border border-slate-800 mb-4">
              <button
                type="button"
                onClick={() => {
                  setOrderSide('BUY');
                  setOrderStatus({ type: 'IDLE', message: '' });
                }}
                className={`py-2 rounded-md text-xs font-semibold flex items-center justify-center gap-1.5 transition cursor-pointer ${
                  orderSide === 'BUY'
                    ? 'bg-[#059669] text-white shadow-xs'
                    : 'text-slate-400 hover:text-white'
                }`}
              >
                <TrendingUp className="w-3.5 h-3.5" />
                <span>Buy</span>
              </button>
              <button
                type="button"
                onClick={() => {
                  setOrderSide('SELL');
                  setOrderStatus({ type: 'IDLE', message: '' });
                }}
                className={`py-2 rounded-md text-xs font-semibold flex items-center justify-center gap-1.5 transition cursor-pointer ${
                  orderSide === 'SELL'
                    ? 'bg-[#E11D48] text-white shadow-xs'
                    : 'text-slate-400 hover:text-white'
                }`}
              >
                <TrendingDown className="w-3.5 h-3.5" />
                <span>Sell</span>
              </button>
            </div>

            <div className="flex items-baseline justify-between mb-3">
              <div>
                <span className="text-sm font-bold text-white">
                  {selectedSymbol}
                </span>
                <span className="ml-1.5 text-[10px] font-mono px-1.5 py-0.5 rounded bg-slate-800 text-slate-300 font-medium">
                  {activeMeta?.exchange ?? 'NSE'}
                </span>
              </div>
              <div className="text-right font-mono">
                <div
                  className={`text-base font-bold ${
                    orderSide === 'BUY' ? 'text-[#00D09C]' : 'text-[#FB7185]'
                  }`}
                >
                  {formatINR(activeTick?.price ?? activeMeta?.basePrice ?? 0)}
                </div>
                <div className="text-[10px] text-slate-400">Live LTP</div>
              </div>
            </div>

            <form onSubmit={handleOrderSubmit} className="space-y-3">
              <div>
                <div className="flex justify-between text-[11px] font-medium text-slate-300 mb-1">
                  <span>Quantity</span>
                  {activePosition && (
                    <span className="font-mono text-[#00D09C]">
                      Held: {activePosition.quantity}
                    </span>
                  )}
                </div>
                <input
                  type="number"
                  min="1"
                  step="1"
                  value={orderQty}
                  onChange={(e) => setOrderQty(e.target.value)}
                  className="w-full px-3 py-2 text-sm font-mono font-semibold bg-[#070B12] text-white rounded-lg border border-slate-700 focus:outline-none focus:border-emerald-500"
                />
              </div>

              <div>
                <label className="block text-[11px] font-medium text-slate-300 mb-1">
                  Demat Account
                </label>
                <select
                  value={orderBrokerSource}
                  onChange={(e) => setOrderBrokerSource(e.target.value as BrokerSource)}
                  className="w-full px-3 py-1.5 text-xs rounded-lg border border-slate-700 bg-[#070B12] text-slate-100"
                >
                  <option value="KitePulse Direct">KitePulse Direct Demat</option>
                  <option value="SBI Securities">SBI Securities (3-in-1)</option>
                  <option value="HDFC Sky">HDFC Sky Demat</option>
                  <option value="Groww">Groww Demat</option>
                  <option value="Zerodha Kite">Zerodha Kite</option>
                </select>
              </div>

              {/* 3-in-1 Bank Auto-Sweep Option */}
              <div className="p-2.5 rounded-lg bg-[#070B12] border border-slate-800 space-y-2">
                <label className="flex items-center gap-2 text-xs font-medium text-slate-200 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={useThreeInOneAutoDebit}
                    onChange={(e) => setUseThreeInOneAutoDebit(e.target.checked)}
                    className="rounded text-emerald-500"
                  />
                  <span>3-in-1 Direct Bank Settlement (ASBA)</span>
                </label>
                {useThreeInOneAutoDebit && livePortfolio && (
                  <select
                    value={selectedThreeInOneBankId}
                    onChange={(e) => setSelectedThreeInOneBankId(Number(e.target.value))}
                    className="w-full px-2 py-1.5 text-[11px] rounded border border-slate-700 bg-[#0D1421] text-slate-100 font-mono"
                  >
                    {livePortfolio.bankAccounts.map((b) => (
                      <option key={b.id} value={b.id}>
                        {b.bankName} ({formatINR(b.balance)})
                      </option>
                    ))}
                  </select>
                )}
              </div>

              <div className="p-2.5 rounded-lg bg-[#070B12] border border-slate-800 text-white font-mono text-xs space-y-1">
                <div className="flex justify-between">
                  <span className="text-slate-400">Order Value:</span>
                  <span className="font-semibold text-white">
                    {formatINR(estimatedOrderNotional)}
                  </span>
                </div>
                <div className="flex justify-between text-[11px]">
                  <span className="text-slate-400">
                    Statutory Charges:
                  </span>
                  <span className="text-[#FB7185] font-medium">
                    +{formatINR(statutoryBreakdown.totalCharges)}
                  </span>
                </div>
                <div className="flex justify-between text-[11px] border-t border-slate-800 pt-1">
                  <span className="text-slate-300">Net Settlement:</span>
                  <span className="text-[#00D09C] font-semibold">
                    {formatINR(statutoryBreakdown.netSettlementAmount)}
                  </span>
                </div>
                <div className="flex justify-between text-[11px]">
                  <span className="text-slate-400">Available Margin:</span>
                  <span className="text-amber-400 font-semibold">
                    {formatINR(livePortfolio?.cashBalance ?? 0)}
                  </span>
                </div>
              </div>

              <button
                type="submit"
                disabled={orderStatus.type === 'SUBMITTING'}
                className={`w-full py-2.5 rounded-lg text-xs font-semibold text-white shadow-md transition cursor-pointer ${
                  orderSide === 'BUY'
                    ? 'bg-[#059669] hover:bg-emerald-500'
                    : 'bg-[#E11D48] hover:bg-rose-500'
                }`}
              >
                {orderStatus.type === 'SUBMITTING'
                  ? 'Executing...'
                  : `${orderSide === 'BUY' ? 'Buy' : 'Sell'} ${orderQty} ${selectedSymbol} @ ${formatINR(
                      activeTick?.price ?? activeMeta?.basePrice ?? 0
                    )}`}
              </button>

              {orderStatus.message && (
                <div
                  className={`p-2.5 rounded-lg text-xs font-medium flex items-start gap-1.5 ${
                    orderStatus.type === 'ERROR'
                      ? 'bg-rose-950/60 text-rose-200 border border-rose-500/40'
                      : 'bg-emerald-950/60 text-emerald-200 border border-emerald-500/40'
                  }`}
                >
                  {orderStatus.type === 'ERROR' ? (
                    <AlertTriangle className="w-4 h-4 shrink-0 text-[#FB7185] mt-0.5" />
                  ) : (
                    <CheckCircle2 className="w-4 h-4 shrink-0 text-[#00D09C] mt-0.5" />
                  )}
                  <span>{orderStatus.message}</span>
                </div>
              )}
            </form>
          </div>

          {/* 5-Level Market Depth Ladder */}
          <div className="bg-[#0D1421] rounded-xl border border-slate-800 p-3.5 space-y-2.5">
            <div className="flex items-center justify-between text-xs font-semibold text-slate-200">
              <span>Market Depth ({selectedSymbol})</span>
              <span className="text-[11px] font-mono text-slate-400">5 Levels</span>
            </div>

            <div className="space-y-1">
              <div className="flex justify-between text-[11px] font-mono font-medium">
                <span className="text-[#00D09C]">
                  Bids: {marketDepth.buyPressurePercent}% ({marketDepth.totalBidQty})
                </span>
                <span className="text-[#FB7185]">
                  Asks: {marketDepth.sellPressurePercent}% ({marketDepth.totalAskQty})
                </span>
              </div>
              <div className="h-2 rounded-full bg-[#E11D48] overflow-hidden flex">
                <div
                  className="h-full bg-[#00D09C] transition-all duration-300"
                  style={{ width: `${marketDepth.buyPressurePercent}%` }}
                />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-2 text-[11px] font-mono">
              <div>
                <div className="flex justify-between text-slate-400 pb-1 border-b border-slate-800">
                  <span>Bid (₹)</span>
                  <span>Qty</span>
                </div>
                {marketDepth.bids.map((b, i) => (
                  <div
                    key={i}
                    className="flex justify-between py-0.5 text-[#00D09C] font-medium"
                  >
                    <span>{b.price.toFixed(2)}</span>
                    <span>{b.quantity}</span>
                  </div>
                ))}
              </div>
              <div>
                <div className="flex justify-between text-slate-400 pb-1 border-b border-slate-800">
                  <span>Ask (₹)</span>
                  <span>Qty</span>
                </div>
                {marketDepth.asks.map((a, i) => (
                  <div
                    key={i}
                    className="flex justify-between py-0.5 text-[#FB7185] font-medium"
                  >
                    <span>{a.price.toFixed(2)}</span>
                    <span>{a.quantity}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
};
export default App;
