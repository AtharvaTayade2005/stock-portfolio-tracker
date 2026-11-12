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
import { CandlestickChart } from './components/CandlestickChart.js';

type ActiveTab =
  | 'TERMINAL'
  | 'HOLDINGS_AND_LOTS'
  | 'BANK_AND_FUNDS'
  | 'BROKER_IMPORT'
  | 'TAX_AND_CONTRACT_NOTE'
  | 'MARKET_NEWS'
  | 'AI_COPILOT'
  | 'ALERTS_AND_ORDERS';

type SegmentFilter = 'ALL' | InstrumentSegment;

const BROKER_PRESETS: Record<
  Exclude<BrokerSource, 'KitePulse Direct'>,
  ExternalHoldingImportItem[]
> = {
  'SBI Securities': [
    { symbol: 'SBIN', quantity: 50, buyPrice: 1042.0, brokerSource: 'SBI Securities' },
    { symbol: 'RELIANCE', quantity: 25, buyPrice: 1318.5, brokerSource: 'SBI Securities' },
    { symbol: 'LT', quantity: 10, buyPrice: 4090.0, brokerSource: 'SBI Securities' },
  ],
  'HDFC Sky': [
    { symbol: 'HDFCBANK', quantity: 40, buyPrice: 798.0, brokerSource: 'HDFC Sky' },
    { symbol: 'INFY', quantity: 30, buyPrice: 1138.0, brokerSource: 'HDFC Sky' },
    { symbol: 'NIFTYBEES', quantity: 150, buyPrice: 282.4, brokerSource: 'HDFC Sky' },
  ],
  Groww: [
    { symbol: 'CDSL', quantity: 20, buyPrice: 1395.0, brokerSource: 'Groww' },
    { symbol: 'PPFAS-FLEXI', quantity: 400, buyPrice: 91.2, brokerSource: 'Groww' },
    { symbol: 'SUZLON', quantity: 250, buyPrice: 37.5, brokerSource: 'Groww' },
  ],
  'Zerodha Kite': [
    { symbol: 'TCS', quantity: 15, buyPrice: 2415.0, brokerSource: 'Zerodha Kite' },
    { symbol: 'DIXON', quantity: 4, buyPrice: 12750.0, brokerSource: 'Zerodha Kite' },
    { symbol: 'GOLDBEES', quantity: 300, buyPrice: 110.5, brokerSource: 'Zerodha Kite' },
  ],
  'Angel One': [
    { symbol: 'ICICIBANK', quantity: 30, buyPrice: 1560.0, brokerSource: 'Angel One' },
    { symbol: 'POLYCAB', quantity: 5, buyPrice: 7890.0, brokerSource: 'Angel One' },
  ],
};

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

  const [activeTab, setActiveTab] = useState<ActiveTab>('TERMINAL');
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

  // External Broker Portfolio Import State
  const [csvImportText, setCsvImportText] = useState<string>(
    'RELIANCE,15,1320.50,SBI Securities\nHDFCBANK,30,802.00,HDFC Sky\nTCS,10,2430.00,Groww'
  );
  const [importBanner, setImportBanner] = useState<string>('');

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

  const handleImportBrokerPreset = async (
    broker: Exclude<BrokerSource, 'KitePulse Direct'>
  ) => {
    const items = BROKER_PRESETS[broker];
    setImportBanner(`Importing ${broker} CDSL Demat holdings...`);
    try {
      const res = await fetch('/api/portfolio/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items }),
      });
      const data = (await res.json()) as {
        importedCount?: number;
        portfolio?: PortfolioSnapshot;
        error?: string;
      };
      if (res.ok && data.portfolio) {
        setPortfolio(data.portfolio);
        setImportBanner(
          `Successfully imported ${data.importedCount} holdings from ${broker} at live NSE/BSE prices!`
        );
      } else {
        setImportBanner(`Error: ${data.error || 'Import failed'}`);
      }
    } catch {
      setImportBanner('Network error importing holdings.');
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
        brokerSource: (brokerStr as BrokerSource) || 'SBI Securities',
      });
    }
    if (items.length === 0) {
      setImportBanner('Please enter at least one valid CSV row: SYMBOL,QTY,AVG_PRICE,BROKER');
      return;
    }
    const res = await fetch('/api/portfolio/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items }),
    });
    const data = (await res.json()) as {
      importedCount?: number;
      portfolio?: PortfolioSnapshot;
    };
    if (res.ok && data.portfolio) {
      setPortfolio(data.portfolio);
      setImportBanner(`Imported ${data.importedCount} custom CSV Demat holdings!`);
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

  return (
    <div className="min-h-screen bg-[#F4F6F8] text-[#0F172A] flex flex-col selection:bg-emerald-600 selection:text-white">
      {/* ================= TOP DALAL STREET BULL / BEAR COMMAND BAR ================= */}
      <header className="sticky top-0 z-30 bg-[#0B1320] text-white border-b-2 border-emerald-500/40 shadow-md">
        <div className="px-4 py-2.5 flex flex-wrap items-center justify-between gap-3">
          {/* Brand + Live NSE/BSE Indices */}
          <div className="flex items-center gap-4 flex-wrap">
            <div className="flex items-center gap-2.5">
              <div className="w-9 h-9 rounded-lg bg-gradient-to-br from-[#00B386] via-[#059669] to-[#E11D48] p-0.5 shadow-md">
                <div className="w-full h-full bg-[#0B1320] rounded-[6px] flex items-center justify-center">
                  <Flame className="w-5 h-5 text-[#00D09C]" />
                </div>
              </div>
              <div>
                <div className="flex items-center gap-2">
                  <span className="font-bold tracking-tight text-base text-white">
                    KitePulse
                  </span>
                  <span className="text-[10px] font-mono uppercase tracking-widest px-2 py-0.5 rounded bg-emerald-500/20 text-[#00D09C] border border-emerald-500/30 font-semibold">
                    BULL & BEAR TERMINAL
                  </span>
                </div>
                <p className="text-[11px] text-slate-400">
                  Real-Time NSE • BSE • NFO • AMFI • 3-in-1 Bank & Multi-Broker Ledger
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
                        ? 'bg-emerald-950/40 border-emerald-500/30'
                        : 'bg-rose-950/40 border-rose-500/30'
                    }`}
                  >
                    <div>
                      <div className="flex items-center gap-1.5">
                        <span className="text-[11px] font-bold tracking-wide text-slate-200">
                          {idx.name}
                        </span>
                        <span
                          className={`text-[10px] font-mono font-bold px-1 rounded ${
                            isUp
                              ? 'bg-emerald-500/20 text-[#00D09C]'
                              : 'bg-rose-500/20 text-[#FB7185]'
                          }`}
                        >
                          {isUp ? 'BULL' : 'BEAR'}
                        </span>
                      </div>
                      <div className="flex items-center gap-2 mt-0.5 font-mono text-xs">
                        <span className="font-bold text-white">
                          {idx.price.toLocaleString('en-IN', {
                            minimumFractionDigits: 2,
                            maximumFractionDigits: 2,
                          })}
                        </span>
                        <span
                          className={`text-[11px] font-semibold ${
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

          {/* Right Status: Market Session (09:15 - 15:30 IST) + Live Sync + Net Worth */}
          <div className="flex items-center gap-3 flex-wrap">
            {session && (
              <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-slate-900/90 border border-amber-500/30">
                <Clock className="w-3.5 h-3.5 text-amber-400" />
                <div className="text-[11px]">
                  <div className="flex items-center gap-1.5">
                    <span
                      className={`w-2 h-2 rounded-full ${
                        session.isLiveHours
                          ? 'bg-[#00D09C] animate-pulse'
                          : 'bg-amber-400'
                      }`}
                    />
                    <span className="font-semibold text-amber-300">{session.istTime}</span>
                    <span className="text-slate-400">•</span>
                    <span className="text-slate-200 font-medium">{session.label}</span>
                  </div>
                </div>
              </div>
            )}

            <button
              onClick={handleSyncMarketNow}
              disabled={isSyncingMarket}
              title="Fetch latest real-time NSE/BSE/AMFI prices from exchange feed"
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-emerald-600 hover:bg-emerald-500 text-white shadow-sm transition cursor-pointer disabled:opacity-50"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${isSyncingMarket ? 'animate-spin' : ''}`} />
              <span>{isSyncingMarket ? 'Syncing NSE/BSE...' : 'Sync Live Prices'}</span>
            </button>

            {/* Replay Override Pill (0 = Exact Real Closing/Live Prices, 1x/5x/10x = Interview Sim) */}
            <div className="flex items-center gap-1.5 bg-slate-900 border border-slate-800 rounded-lg px-2 py-1">
              <span className="text-xs font-medium text-slate-300">
                Market Mode:
              </span>
              {([0, 1, 5, 10] as ReplaySpeed[]).map((spd) => (
                <button
                  key={spd}
                  onClick={() => handleReplaySpeedChange(spd)}
                  className={`px-2.5 py-1 text-xs font-semibold rounded-md transition cursor-pointer ${
                    replaySpeed === spd
                      ? spd === 0
                        ? 'bg-[#00B386] text-white'
                        : 'bg-amber-500 text-slate-950'
                      : 'text-slate-300 hover:text-white hover:bg-slate-800'
                  }`}
                >
                  {spd === 0 ? 'Live (9:15–3:30)' : `Replay ${spd}x`}
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* ================= BULL vs BEAR TUG-OF-WAR MARKET BREADTH RIBBON ================= */}
        <div className="bg-[#111C2D] px-4 py-1.5 border-t border-slate-800/80 flex flex-wrap items-center justify-between gap-4 text-xs">
          <div className="flex items-center gap-3 flex-1 min-w-[280px]">
            <span className="flex items-center gap-1 font-mono font-bold text-[#00D09C] uppercase tracking-wider">
              <TrendingUp className="w-3.5 h-3.5" />
              BULLS (ADVANCING): {marketBreadth.bulls} ({marketBreadth.bullPct}%)
            </span>
            <div className="flex-1 h-2.5 rounded-full bg-[#E11D48] overflow-hidden flex shadow-inner max-w-md">
              <div
                className="h-full bg-gradient-to-r from-[#059669] to-[#00D09C] transition-all duration-500"
                style={{ width: `${marketBreadth.bullPct}%` }}
              />
            </div>
            <span className="flex items-center gap-1 font-mono font-bold text-[#FB7185] uppercase tracking-wider">
              <TrendingDown className="w-3.5 h-3.5" />
              BEARS (DECLINING): {marketBreadth.bears} ({marketBreadth.bearPct}%)
            </span>
          </div>

          {/* Live Portfolio Summary Strip in Header */}
          {livePortfolio && (
            <div className="flex items-center gap-5 font-mono text-xs">
              <div>
                <span className="text-slate-400 mr-1.5">Holdings:</span>
                <span className="font-bold text-white">
                  {livePortfolio.holdings.length} Active
                </span>
              </div>
              <div>
                <span className="text-slate-400 mr-1.5">Invested:</span>
                <span className="font-bold text-white">
                  {formatINR(livePortfolio.holdingsMarketValue)}
                </span>
              </div>
              <div>
                <span className="text-slate-400 mr-1.5">Open P&L:</span>
                <span
                  className={`font-bold ${
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
                <span className="text-slate-400 mr-1.5">Demat Margin:</span>
                <span className="font-bold text-amber-400">
                  {formatINR(livePortfolio.cashBalance)}
                </span>
              </div>
              <div className="hidden md:block">
                <span className="text-slate-400 mr-1.5">Linked Banks (3-in-1):</span>
                <span className="font-bold text-[#00D09C]">
                  {formatINR(totalLinkedBankBalance)}
                </span>
              </div>
            </div>
          )}
        </div>
      </header>

      {/* Alert Triggered Banner */}
      {toastAlert && (
        <div className="bg-amber-50 border-b border-amber-300 px-4 py-2 flex items-center justify-between text-xs text-amber-950">
          <div className="flex items-center gap-2 font-medium">
            <Bell className="w-4 h-4 text-amber-600 animate-bounce" />
            <span>
              <strong>PRICE ALERT TRIGGERED:</strong> {toastAlert.symbol} crossed{' '}
              {toastAlert.direction} {formatINR(toastAlert.targetPrice)} (Exec Price:{' '}
              {formatINR(toastAlert.triggeredPrice ?? toastAlert.targetPrice)}) —{' '}
              {toastAlert.note}
            </span>
          </div>
          <button
            onClick={() => setToastAlert(null)}
            className="text-amber-800 hover:underline font-semibold cursor-pointer"
          >
            Dismiss
          </button>
        </div>
      )}

      {/* ================= MAIN WORKSPACE GRID ================= */}
      <div className="flex-1 grid grid-cols-1 lg:grid-cols-12 gap-0">
        {/* LEFT COLUMN (3 COLS): UNIVERSAL NSE/BSE WATCHLIST WITH BULL/BEAR BARS */}
        <aside className="lg:col-span-3 bg-white border-r border-slate-200 flex flex-col h-[calc(100vh-88px)] sticky top-[88px]">
          <div className="p-3 border-b border-slate-200 bg-slate-50/70 space-y-2.5">
            <div className="relative">
              <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search any NSE/BSE stock (e.g. TATASTEEL, ITC, HAL, SBIN)..."
                className="w-full pl-9 pr-3 py-2 text-xs bg-white border border-slate-300 rounded-lg text-slate-900 placeholder:text-slate-400 focus:outline-none focus:border-emerald-600 focus:ring-2 focus:ring-emerald-500/20"
              />
              {isSearchingLive && (
                <span className="absolute right-2.5 top-1/2 -translate-y-1/2 text-[10px] font-mono text-emerald-600 animate-pulse">
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
                      ? 'bg-[#0B1320] text-[#00D09C] shadow-xs'
                      : 'bg-white text-slate-600 border border-slate-200 hover:bg-slate-100'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          {/* Watchlist Items */}
          <div className="flex-1 overflow-y-auto divide-y divide-slate-100">
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
                  onClick={() => setSelectedSymbol(meta.symbol)}
                  className={`w-full text-left px-3.5 py-2.5 transition flex items-center justify-between gap-2 cursor-pointer border-l-4 ${
                    isSelected
                      ? isUp
                        ? 'bg-emerald-50/70 border-l-[#059669]'
                        : 'bg-rose-50/70 border-l-[#E11D48]'
                      : isUp
                        ? 'hover:bg-emerald-50/30 border-l-[#059669]/40'
                        : 'hover:bg-rose-50/30 border-l-[#E11D48]/40'
                  } ${
                    flash === 'UP'
                      ? 'bg-emerald-100/60'
                      : flash === 'DOWN'
                        ? 'bg-rose-100/60'
                        : ''
                  }`}
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-1.5">
                      <span className="font-bold text-xs text-slate-900 truncate">
                        {meta.symbol}
                      </span>
                      <span className="text-[10px] font-mono px-1.5 py-0.2 rounded bg-slate-100 text-slate-600 border border-slate-200">
                        {meta.exchange}
                      </span>
                      {held && (
                        <span className="text-[10px] font-mono px-1.5 py-0.2 rounded bg-amber-100 text-amber-900 font-semibold">
                          Qty: {held.quantity}
                        </span>
                      )}
                    </div>
                    <p className="text-[11px] text-slate-500 truncate mt-0.5">{meta.name}</p>
                  </div>

                  <div className="text-right font-mono shrink-0">
                    <div
                      className={`text-xs font-bold ${
                        isUp ? 'text-[#059669]' : 'text-[#E11D48]'
                      }`}
                    >
                      {formatINR(price)}
                    </div>
                    <div
                      className={`text-[11px] font-semibold flex items-center justify-end gap-0.5 ${
                        isUp ? 'text-[#059669]' : 'text-[#E11D48]'
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

        {/* CENTER COLUMN (6 COLS): NAVIGATION TABS + CHART / HOLDINGS / 3-IN-1 BANK / BROKER IMPORT */}
        <main className="lg:col-span-6 flex flex-col bg-[#F4F6F8] min-h-[calc(100vh-88px)]">
          {/* Primary Navigation Bar */}
          <div className="bg-white border-b border-slate-200 px-4 flex items-center gap-1 overflow-x-auto">
            {(
              [
                ['TERMINAL', 'Live Chart & OHLC', Activity],
                [
                  'HOLDINGS_AND_LOTS',
                  `Portfolio Holdings (${livePortfolio?.holdings.length ?? 0})`,
                  Layers,
                ],
                ['BANK_AND_FUNDS', '3-in-1 Bank & Demat Funds', Landmark],
                ['BROKER_IMPORT', 'Import External Broker', FolderInput],
                ['TAX_AND_CONTRACT_NOTE', 'SEBI Contract Note & Tax', ShieldAlert],
                ['MARKET_NEWS', `Stock & Commodity News (${news.length})`, Flame],
                ['AI_COPILOT', 'Gemini 3.8 Flash Risk Copilot', Sparkles],
                ['ALERTS_AND_ORDERS', `Order Book & Alerts (${alerts.length})`, Bell],
              ] as Array<[ActiveTab, string, React.ComponentType<{ className?: string }>]>
            ).map(([tabId, label, Icon]) => {
              const active = activeTab === tabId;
              return (
                <button
                  key={tabId}
                  onClick={() => setActiveTab(tabId)}
                  className={`flex items-center gap-1.5 px-3.5 py-3 text-xs font-bold border-b-2 whitespace-nowrap transition cursor-pointer ${
                    active
                      ? 'border-[#059669] text-[#059669] bg-emerald-50/40'
                      : 'border-transparent text-slate-600 hover:text-slate-900 hover:bg-slate-50'
                  }`}
                >
                  <Icon className="w-3.5 h-3.5" />
                  <span>{label}</span>
                </button>
              );
            })}
          </div>

          <div className="p-4 space-y-4 flex-1">
            {/* ================= TAB 1: LIVE TERMINAL & REAL-TIME OHLC CHART ================= */}
            {activeTab === 'TERMINAL' && activeMeta && (
              <>
                {/* Selected Instrument Real-Time Bull/Bear Header Card */}
                <div
                  className={`rounded-xl bg-white border-2 p-4 shadow-xs ${
                    isSelectedStockBullish
                      ? 'border-emerald-500/40'
                      : 'border-rose-500/40'
                  }`}
                >
                  <div className="flex flex-wrap items-start justify-between gap-4">
                    <div>
                      <div className="flex items-center gap-2 flex-wrap">
                        <h1 className="text-xl font-extrabold tracking-tight text-slate-900">
                          {activeMeta.symbol}
                        </h1>
                        <span className="text-xs font-mono font-bold px-2 py-0.5 rounded bg-slate-900 text-white">
                          {activeMeta.exchange}
                        </span>
                        <span
                          className={`text-xs font-mono font-bold px-2.5 py-0.5 rounded-full flex items-center gap-1 ${
                            isSelectedStockBullish
                              ? 'bg-emerald-100 text-[#059669] border border-emerald-300'
                              : 'bg-rose-100 text-[#E11D48] border border-rose-300'
                          }`}
                        >
                          {isSelectedStockBullish ? (
                            <>
                              <TrendingUp className="w-3.5 h-3.5" /> BULLISH TREND
                            </>
                          ) : (
                            <>
                              <TrendingDown className="w-3.5 h-3.5" /> BEARISH TREND
                            </>
                          )}
                        </span>
                        <span className="text-xs text-slate-500 font-medium">
                          {SEGMENT_LABELS[activeMeta.segment]} • Lot Size: {activeMeta.lotSize}
                        </span>
                      </div>
                      <p className="text-xs text-slate-600 mt-1">{activeMeta.name}</p>
                    </div>

                    <div className="text-right font-mono">
                      <div
                        className={`text-2xl font-extrabold ${
                          isSelectedStockBullish ? 'text-[#059669]' : 'text-[#E11D48]'
                        }`}
                      >
                        {formatINR(activeTick?.price ?? activeMeta.basePrice)}
                      </div>
                      <div
                        className={`text-xs font-bold ${
                          isSelectedStockBullish ? 'text-[#059669]' : 'text-[#E11D48]'
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
                  <div className="grid grid-cols-2 sm:grid-cols-5 gap-2.5 mt-4 pt-3 border-t border-slate-100 font-mono text-xs">
                    <div className="bg-slate-50 rounded-lg px-3 py-2 border border-slate-200/80">
                      <div className="text-[10px] uppercase text-slate-500">Open (09:15 IST)</div>
                      <div className="font-bold text-slate-900 mt-0.5">
                        {formatINR(activeTick?.open ?? activeMeta.prevClose)}
                      </div>
                    </div>
                    <div className="bg-emerald-50/60 rounded-lg px-3 py-2 border border-emerald-200/80">
                      <div className="text-[10px] uppercase text-emerald-700">Day High</div>
                      <div className="font-bold text-[#059669] mt-0.5">
                        {formatINR(activeTick?.dayHigh ?? activeMeta.basePrice)}
                      </div>
                    </div>
                    <div className="bg-rose-50/60 rounded-lg px-3 py-2 border border-rose-200/80">
                      <div className="text-[10px] uppercase text-rose-700">Day Low</div>
                      <div className="font-bold text-[#E11D48] mt-0.5">
                        {formatINR(activeTick?.dayLow ?? activeMeta.basePrice)}
                      </div>
                    </div>
                    <div className="bg-slate-50 rounded-lg px-3 py-2 border border-slate-200/80">
                      <div className="text-[10px] uppercase text-slate-500">Prev. Close</div>
                      <div className="font-bold text-slate-900 mt-0.5">
                        {formatINR(activeTick?.prevClose ?? activeMeta.prevClose)}
                      </div>
                    </div>
                    <div className="bg-amber-50/60 rounded-lg px-3 py-2 border border-amber-200/80">
                      <div className="text-[10px] uppercase text-amber-800">3:30 Close / LTP</div>
                      <div className="font-bold text-amber-950 mt-0.5">
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

                {/* Quick Portfolio Status Card Below Chart */}
                {livePortfolio && livePortfolio.holdings.length === 0 ? (
                  <div className="bg-white rounded-xl border-2 border-dashed border-slate-300 p-5 flex flex-wrap items-center justify-between gap-4">
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="px-2 py-0.5 text-[10px] font-mono font-bold uppercase rounded bg-emerald-100 text-[#059669]">
                          ZERO HALLUCINATED HOLDINGS
                        </span>
                        <h3 className="text-sm font-bold text-slate-900">
                          Your Demat Portfolio is Currently Empty (0 Positions)
                        </h3>
                      </div>
                      <p className="text-xs text-slate-600 mt-1">
                        Execute a real BUY order on the right at live NSE/BSE prices, or import your
                        existing holdings from SBI Securities, HDFC Sky, Groww, or Zerodha.
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => setActiveTab('BROKER_IMPORT')}
                        className="px-3.5 py-2 rounded-lg text-xs font-bold bg-[#0B1320] text-[#00D09C] hover:bg-slate-800 transition cursor-pointer flex items-center gap-1.5"
                      >
                        <FolderInput className="w-3.5 h-3.5" />
                        <span>Import from SBI / HDFC Sky / Groww</span>
                      </button>
                      <button
                        onClick={() => setActiveTab('BANK_AND_FUNDS')}
                        className="px-3.5 py-2 rounded-lg text-xs font-bold bg-amber-500 text-slate-950 hover:bg-amber-400 transition cursor-pointer flex items-center gap-1.5"
                      >
                        <Landmark className="w-3.5 h-3.5" />
                        <span>3-in-1 Bank & Funds</span>
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="bg-white rounded-xl border border-slate-200 p-4 flex items-center justify-between">
                    <div>
                      <span className="text-xs font-bold text-slate-800">
                        Active Demat Holdings ({livePortfolio?.holdings.length ?? 0} stocks)
                      </span>
                      <p className="text-xs text-slate-500">
                        Total Invested: {formatINR(livePortfolio?.totalCostBasis ?? 0)} • Current
                        Value: {formatINR(livePortfolio?.holdingsMarketValue ?? 0)}
                      </p>
                    </div>
                    <button
                      onClick={() => setActiveTab('HOLDINGS_AND_LOTS')}
                      className="px-3 py-1.5 rounded-lg text-xs font-bold bg-emerald-600 text-white hover:bg-emerald-500 cursor-pointer"
                    >
                      View Full Holdings & FIFO Lots →
                    </button>
                  </div>
                )}
              </>
            )}

            {/* ================= TAB 2: HOLDINGS & FIFO TAX LOTS ================= */}
            {activeTab === 'HOLDINGS_AND_LOTS' && livePortfolio && (
              <div className="space-y-4">
                <div className="bg-white rounded-xl border border-slate-200 p-4 flex flex-wrap items-center justify-between gap-3">
                  <div className="flex items-center gap-1.5 flex-wrap">
                    <span className="text-xs font-bold text-slate-700 mr-1">Broker Filter:</span>
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
                            ? 'bg-[#059669] text-white'
                            : 'bg-slate-100 text-slate-700 hover:bg-slate-200'
                        }`}
                      >
                        {b === 'ALL' ? 'All Demat Accounts' : b}
                      </button>
                    ))}
                  </div>

                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => setActiveTab('BROKER_IMPORT')}
                      className="px-3 py-1.5 rounded-lg text-xs font-bold bg-emerald-600 text-white hover:bg-emerald-500 cursor-pointer flex items-center gap-1"
                    >
                      <Plus className="w-3.5 h-3.5" /> Import External Broker
                    </button>
                    {livePortfolio.holdings.length > 0 && (
                      <button
                        onClick={handleResetPortfolio}
                        className="px-3 py-1.5 rounded-lg text-xs font-bold bg-rose-50 text-[#E11D48] border border-rose-200 hover:bg-rose-100 cursor-pointer flex items-center gap-1"
                      >
                        <RotateCcw className="w-3.5 h-3.5" /> Reset to Empty (0)
                      </button>
                    )}
                  </div>
                </div>

                {filteredHoldings.length === 0 ? (
                  <div className="bg-white rounded-xl border-2 border-dashed border-slate-300 p-10 text-center space-y-3">
                    <Wallet className="w-10 h-10 text-emerald-600 mx-auto" />
                    <h3 className="text-base font-bold text-slate-900">
                      No Holdings in Your Portfolio Yet
                    </h3>
                    <p className="text-xs text-slate-600 max-w-md mx-auto">
                      Your portfolio starts 100% clean with zero pre-filled stocks. Place a real
                      BUY order from the right-hand trade ticket or import holdings from SBI
                      Securities, HDFC Sky, or Groww.
                    </p>
                    <div className="flex items-center justify-center gap-3 pt-2">
                      <button
                        onClick={() => setActiveTab('BROKER_IMPORT')}
                        className="px-4 py-2 rounded-lg text-xs font-bold bg-[#059669] text-white hover:bg-emerald-600 cursor-pointer"
                      >
                        Import from SBI Securities / HDFC Sky / Groww
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="bg-white rounded-xl border border-slate-200 overflow-hidden shadow-xs">
                    <div className="px-4 py-3 border-b border-slate-200 flex items-center justify-between bg-slate-50">
                      <h3 className="text-xs font-bold uppercase tracking-wider text-slate-700">
                        Live NSE/BSE Demat Holdings ({filteredHoldings.length})
                      </h3>
                      <span className="text-xs font-mono text-slate-500">
                        Valued at Real-Time NSE/BSE LTP
                      </span>
                    </div>
                    <div className="overflow-x-auto">
                      <table className="w-full text-left border-collapse text-xs">
                        <thead>
                          <tr className="border-b border-slate-200 text-[11px] font-mono uppercase text-slate-500 bg-slate-50/50">
                            <th className="py-2.5 px-3">Instrument / Broker</th>
                            <th className="py-2.5 px-3 text-right">Qty</th>
                            <th className="py-2.5 px-3 text-right">FIFO Avg Cost</th>
                            <th className="py-2.5 px-3 text-right">Live LTP (3:30)</th>
                            <th className="py-2.5 px-3 text-right">Cur. Value</th>
                            <th className="py-2.5 px-3 text-right">Net P&L</th>
                            <th className="py-2.5 px-3 text-center">Trade</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-100 font-mono">
                          {filteredHoldings.map((h) => {
                            const isGain = h.unrealizedPnl >= 0;
                            return (
                              <tr
                                key={h.symbol}
                                className={`hover:bg-slate-50 transition ${
                                  isGain
                                    ? 'border-l-4 border-l-[#059669]'
                                    : 'border-l-4 border-l-[#E11D48]'
                                }`}
                              >
                                <td className="py-2.5 px-3 font-sans">
                                  <div className="flex items-center gap-1.5">
                                    <button
                                      onClick={() => {
                                        setSelectedSymbol(h.symbol);
                                        setActiveTab('TERMINAL');
                                      }}
                                      className="font-bold text-slate-900 hover:text-emerald-600 cursor-pointer"
                                    >
                                      {h.symbol}
                                    </button>
                                    <span className="text-[10px] font-mono px-1.5 py-0.2 rounded bg-slate-100 text-slate-600">
                                      {h.exchange}
                                    </span>
                                  </div>
                                  <div className="flex flex-wrap gap-1 mt-1">
                                    {h.brokers.map((b) => (
                                      <span
                                        key={b}
                                        className="text-[10px] px-1.5 py-0.2 rounded bg-amber-50 text-amber-900 border border-amber-200 font-medium"
                                      >
                                        {b}
                                      </span>
                                    ))}
                                  </div>
                                </td>
                                <td className="py-2.5 px-3 text-right font-bold text-slate-900">
                                  {h.quantity}
                                </td>
                                <td className="py-2.5 px-3 text-right text-slate-700">
                                  {formatINR(h.avgCostBasis)}
                                </td>
                                <td className="py-2.5 px-3 text-right font-bold text-slate-900">
                                  {formatINR(h.currentPrice)}
                                </td>
                                <td className="py-2.5 px-3 text-right font-bold text-slate-900">
                                  {formatINR(h.marketValue)}
                                </td>
                                <td
                                  className={`py-2.5 px-3 text-right font-bold ${
                                    isGain ? 'text-[#059669]' : 'text-[#E11D48]'
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
                                      className="px-2 py-1 rounded text-[10px] font-bold bg-[#059669] text-white hover:bg-emerald-600 cursor-pointer"
                                    >
                                      +BUY
                                    </button>
                                    <button
                                      onClick={() => {
                                        setSelectedSymbol(h.symbol);
                                        setOrderSide('SELL');
                                      }}
                                      className="px-2 py-1 rounded text-[10px] font-bold bg-[#E11D48] text-white hover:bg-rose-600 cursor-pointer"
                                    >
                                      -SELL
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
              </div>
            )}

            {/* ================= TAB 3: 3-IN-1 INDIAN BANK & DEMAT FUNDS LEDGER ================= */}
            {activeTab === 'BANK_AND_FUNDS' && livePortfolio && (
              <div className="space-y-4">
                {bankActionBanner && (
                  <div className="p-3 rounded-lg bg-emerald-50 border border-emerald-300 text-xs font-semibold text-emerald-950 flex items-center justify-between">
                    <span>{bankActionBanner}</span>
                    <button
                      onClick={() => setBankActionBanner('')}
                      className="text-emerald-700 hover:underline cursor-pointer"
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
                      className="bg-white rounded-xl border-2 border-slate-200 p-4 shadow-xs flex flex-col justify-between"
                    >
                      <div>
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-xs font-extrabold text-slate-900">
                            {bank.bankName}
                          </span>
                          {bank.isPrimaryThreeInOne && (
                            <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-amber-100 text-amber-900 font-bold">
                              3-IN-1 PRIMARY
                            </span>
                          )}
                        </div>
                        <div className="text-[11px] font-mono text-slate-500 mt-1">
                          A/C: {bank.accountNumberMasked} • IFSC: {bank.ifscCode}
                        </div>
                        <div className="text-[11px] font-mono text-emerald-700 mt-0.5">
                          UPI: {bank.upiId}
                        </div>
                      </div>
                      <div className="mt-3 pt-2.5 border-t border-slate-100 flex items-baseline justify-between">
                        <span className="text-[11px] text-slate-500">Available Bank Bal:</span>
                        <span className="text-base font-mono font-extrabold text-[#059669]">
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
                    className="bg-white rounded-xl border border-slate-200 p-4 space-y-3"
                  >
                    <div className="flex items-center gap-2">
                      <ArrowRightLeft className="w-4 h-4 text-[#059669]" />
                      <h3 className="text-sm font-bold text-slate-900">
                        Instant Bank ↔ Demat Funds Transfer (UPI / IMPS / ASBA)
                      </h3>
                    </div>

                    <div className="grid grid-cols-2 gap-2">
                      <button
                        type="button"
                        onClick={() => setTransferDirection('DEPOSIT_TO_DEMAT')}
                        className={`py-2 rounded-lg text-xs font-bold border transition cursor-pointer ${
                          transferDirection === 'DEPOSIT_TO_DEMAT'
                            ? 'bg-[#059669] text-white border-[#059669]'
                            : 'bg-slate-50 text-slate-700 border-slate-200'
                        }`}
                      >
                        + Add Funds to Demat
                      </button>
                      <button
                        type="button"
                        onClick={() => setTransferDirection('WITHDRAW_TO_BANK')}
                        className={`py-2 rounded-lg text-xs font-bold border transition cursor-pointer ${
                          transferDirection === 'WITHDRAW_TO_BANK'
                            ? 'bg-[#E11D48] text-white border-[#E11D48]'
                            : 'bg-slate-50 text-slate-700 border-slate-200'
                        }`}
                      >
                        - Withdraw to Bank
                      </button>
                    </div>

                    <div>
                      <label className="block text-[11px] font-semibold text-slate-600 mb-1">
                        Select Linked Indian Bank Account
                      </label>
                      <select
                        value={transferBankId}
                        onChange={(e) => setTransferBankId(Number(e.target.value))}
                        className="w-full px-3 py-2 text-xs rounded-lg border border-slate-300 bg-white font-medium"
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
                        <label className="block text-[11px] font-semibold text-slate-600 mb-1">
                          Payment Rail
                        </label>
                        <select
                          value={transferMethod}
                          onChange={(e) =>
                            setTransferMethod(
                              e.target.value as 'UPI' | 'NETBANKING' | 'IMPS' | 'ASBA_3IN1'
                            )
                          }
                          className="w-full px-3 py-2 text-xs rounded-lg border border-slate-300 bg-white font-mono"
                        >
                          <option value="UPI">UPI Instant (Zero Fee)</option>
                          <option value="ASBA_3IN1">3-in-1 Bank ASBA Sweep</option>
                          <option value="NETBANKING">NetBanking (NEFT/RTGS)</option>
                          <option value="IMPS">IMPS Immediate</option>
                        </select>
                      </div>
                      <div>
                        <label className="block text-[11px] font-semibold text-slate-600 mb-1">
                          Amount (₹ INR)
                        </label>
                        <input
                          type="number"
                          min="1"
                          step="any"
                          value={transferAmount}
                          onChange={(e) => setTransferAmount(e.target.value)}
                          className="w-full px-3 py-2 text-xs font-mono font-bold rounded-lg border border-slate-300"
                        />
                      </div>
                    </div>

                    <button
                      type="submit"
                      className={`w-full py-2.5 rounded-lg text-xs font-bold text-white shadow-xs transition cursor-pointer ${
                        transferDirection === 'DEPOSIT_TO_DEMAT'
                          ? 'bg-[#059669] hover:bg-emerald-600'
                          : 'bg-[#E11D48] hover:bg-rose-600'
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
                    className="bg-white rounded-xl border border-slate-200 p-4 space-y-2.5"
                  >
                    <div className="flex items-center gap-2">
                      <Building2 className="w-4 h-4 text-amber-600" />
                      <h3 className="text-sm font-bold text-slate-900">
                        Link Another Indian Bank Account (SBI / HDFC / ICICI / Axis / Kotak / PNB)
                      </h3>
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      <div>
                        <label className="block text-[11px] text-slate-600 mb-0.5">Bank Name</label>
                        <input
                          type="text"
                          value={newBankName}
                          onChange={(e) => setNewBankName(e.target.value)}
                          className="w-full px-2.5 py-1.5 text-xs rounded border border-slate-300"
                        />
                      </div>
                      <div>
                        <label className="block text-[11px] text-slate-600 mb-0.5">IFSC Code</label>
                        <input
                          type="text"
                          value={newBankIfsc}
                          onChange={(e) => setNewBankIfsc(e.target.value)}
                          className="w-full px-2.5 py-1.5 text-xs font-mono rounded border border-slate-300"
                        />
                      </div>
                      <div>
                        <label className="block text-[11px] text-slate-600 mb-0.5">
                          Masked Account No.
                        </label>
                        <input
                          type="text"
                          value={newBankAcct}
                          onChange={(e) => setNewBankAcct(e.target.value)}
                          className="w-full px-2.5 py-1.5 text-xs font-mono rounded border border-slate-300"
                        />
                      </div>
                      <div>
                        <label className="block text-[11px] text-slate-600 mb-0.5">UPI ID</label>
                        <input
                          type="text"
                          value={newBankUpi}
                          onChange={(e) => setNewBankUpi(e.target.value)}
                          className="w-full px-2.5 py-1.5 text-xs font-mono rounded border border-slate-300"
                        />
                      </div>
                    </div>
                    <div>
                      <label className="block text-[11px] text-slate-600 mb-0.5">
                        Simulated Bank Balance (₹)
                      </label>
                      <input
                        type="number"
                        value={newBankBalance}
                        onChange={(e) => setNewBankBalance(e.target.value)}
                        className="w-full px-2.5 py-1.5 text-xs font-mono rounded border border-slate-300"
                      />
                    </div>
                    <button
                      type="submit"
                      className="w-full py-2 rounded-lg text-xs font-bold bg-[#0B1320] text-[#00D09C] hover:bg-slate-800 cursor-pointer"
                    >
                      + Link Indian Bank Account via NPCI / AA
                    </button>
                  </form>
                </div>

                {/* Bank Passbook & 3-in-1 Settlement Audit Log */}
                <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
                  <div className="px-4 py-2.5 bg-slate-50 border-b border-slate-200 text-xs font-bold text-slate-700">
                    Bank ↔ Demat Double-Entry Passbook ({livePortfolio.bankTransactions.length})
                  </div>
                  <div className="divide-y divide-slate-100 max-h-60 overflow-y-auto text-xs">
                    {livePortfolio.bankTransactions.map((tx) => {
                      const isCreditToDemat =
                        tx.type === 'DEPOSIT_TO_DEMAT' || tx.type === 'THREE_IN_ONE_BUY_DEBIT';
                      return (
                        <div
                          key={tx.id}
                          className="px-4 py-2.5 flex items-center justify-between gap-2"
                        >
                          <div>
                            <div className="font-semibold text-slate-900">
                              {tx.bankName}{' '}
                              <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-slate-100 text-slate-700">
                                {tx.method}
                              </span>
                            </div>
                            <div className="text-[11px] text-slate-500">{tx.referenceNote}</div>
                          </div>
                          <div className="text-right font-mono">
                            <div
                              className={`font-bold ${
                                isCreditToDemat ? 'text-[#059669]' : 'text-[#E11D48]'
                              }`}
                            >
                              {formatINR(tx.amount)}
                            </div>
                            <div className="text-[10px] text-slate-400">
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

            {/* ================= TAB 4: EXTERNAL BROKER PORTFOLIO IMPORTER ================= */}
            {activeTab === 'BROKER_IMPORT' && (
              <div className="space-y-4">
                {importBanner && (
                  <div className="p-3 rounded-lg bg-emerald-50 border border-emerald-300 text-xs font-semibold text-emerald-950 flex items-center justify-between">
                    <span>{importBanner}</span>
                    <button
                      onClick={() => setActiveTab('HOLDINGS_AND_LOTS')}
                      className="px-2.5 py-1 rounded bg-[#059669] text-white font-bold cursor-pointer"
                    >
                      View Imported Holdings →
                    </button>
                  </div>
                )}

                <div className="bg-white rounded-xl border border-slate-200 p-4 space-y-3">
                  <h3 className="text-sm font-bold text-slate-900">
                    1-Click CDSL / NSDL External Broker Demat Sync
                  </h3>
                  <p className="text-xs text-slate-600">
                    Extend and track your external portfolios from{' '}
                    <strong>SBI Securities</strong>, <strong>HDFC Sky</strong>,{' '}
                    <strong>Groww</strong>, <strong>Zerodha Kite</strong>, or{' '}
                    <strong>Angel One</strong> with real-time NSE/BSE valuation:
                  </p>
                  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2.5">
                    {(
                      Object.keys(BROKER_PRESETS) as Array<
                        Exclude<BrokerSource, 'KitePulse Direct'>
                      >
                    ).map((broker) => (
                      <button
                        key={broker}
                        onClick={() => handleImportBrokerPreset(broker)}
                        className="p-3 rounded-xl border-2 border-slate-200 hover:border-[#059669] bg-slate-50/60 hover:bg-emerald-50/40 text-left transition cursor-pointer"
                      >
                        <div className="flex items-center justify-between">
                          <span className="font-bold text-xs text-slate-900">{broker}</span>
                          <Upload className="w-3.5 h-3.5 text-[#059669]" />
                        </div>
                        <p className="text-[11px] text-slate-500 mt-1 font-mono">
                          {BROKER_PRESETS[broker].map((i) => i.symbol).join(', ')}
                        </p>
                      </button>
                    ))}
                  </div>
                </div>

                <form
                  onSubmit={handleImportCsvSubmit}
                  className="bg-white rounded-xl border border-slate-200 p-4 space-y-3"
                >
                  <h3 className="text-sm font-bold text-slate-900">
                    Custom CSV / Contract Note Portfolio Import
                  </h3>
                  <p className="text-xs text-slate-500">
                    Paste lines in format:{' '}
                    <code className="font-mono bg-slate-100 px-1.5 py-0.5 rounded">
                      SYMBOL,QUANTITY,BUY_PRICE,BROKER_NAME
                    </code>
                  </p>
                  <textarea
                    rows={4}
                    value={csvImportText}
                    onChange={(e) => setCsvImportText(e.target.value)}
                    className="w-full p-3 text-xs font-mono rounded-lg border border-slate-300 bg-slate-50"
                  />
                  <button
                    type="submit"
                    className="px-4 py-2 rounded-lg text-xs font-bold bg-[#059669] text-white hover:bg-emerald-600 cursor-pointer"
                  >
                    Import Custom CSV Holdings into FIFO Ledger
                  </button>
                </form>
              </div>
            )}

            {/* ================= TAB 4B: SEBI CONTRACT NOTE & STCG/LTCG TAX ENGINE (PHASE 3) ================= */}
            {activeTab === 'TAX_AND_CONTRACT_NOTE' && taxReport && livePortfolio && (
              <div className="space-y-4">
                <div className="grid grid-cols-1 sm:grid-cols-4 gap-3 font-mono">
                  <div className="bg-white rounded-xl border border-slate-200 p-3.5">
                    <div className="text-[10px] uppercase text-slate-500">Realized STCG Gains</div>
                    <div className="text-base font-extrabold text-[#059669] mt-1">
                      {formatINR(taxReport.realizedStcgGross)}
                    </div>
                    <div className="text-[10px] text-slate-500 mt-0.5">Sec 111A (20% + 4% Cess)</div>
                  </div>
                  <div className="bg-white rounded-xl border border-rose-200 p-3.5">
                    <div className="text-[10px] uppercase text-rose-700">Est. STCG Tax Liability</div>
                    <div className="text-base font-extrabold text-[#E11D48] mt-1">
                      {formatINR(taxReport.estimatedStcgTax)}
                    </div>
                    <div className="text-[10px] text-slate-500 mt-0.5">Effective Rate: 20.8%</div>
                  </div>
                  <div className="bg-emerald-50/70 rounded-xl border border-emerald-300 p-3.5">
                    <div className="text-[10px] uppercase text-emerald-800">
                      Harvestable Tax Savings
                    </div>
                    <div className="text-base font-extrabold text-[#059669] mt-1">
                      {formatINR(taxReport.potentialTaxSavingsViaHarvesting)}
                    </div>
                    <div className="text-[10px] text-emerald-700 mt-0.5">
                      Via FIFO Loss Offset
                    </div>
                  </div>
                  <div className="bg-amber-50/70 rounded-xl border border-amber-300 p-3.5">
                    <div className="text-[10px] uppercase text-amber-900">
                      Sec 112A LTCG Exemption
                    </div>
                    <div className="text-base font-extrabold text-amber-950 mt-1">
                      {formatINR(taxReport.ltcgExemptionLimit)}
                    </div>
                    <div className="text-[10px] text-amber-800 mt-0.5">
                      12.5% above ₹1.25 Lakh
                    </div>
                  </div>
                </div>

                {/* Tax-Loss Harvesting Candidates */}
                <div className="bg-white rounded-xl border border-slate-200 p-4 space-y-2.5">
                  <h3 className="text-sm font-bold text-slate-900">
                    Automated FIFO Tax-Loss Harvesting Advisor (FY 2026-27)
                  </h3>
                  {taxReport.harvestCandidates.length === 0 ? (
                    <p className="text-xs text-slate-600">
                      Zero positions currently in unrealized loss — all active holdings are in
                      positive territory or portfolio is empty.
                    </p>
                  ) : (
                    <div className="divide-y divide-slate-100 text-xs font-mono">
                      {taxReport.harvestCandidates.map((cand) => (
                        <div
                          key={cand.symbol}
                          className="py-2 flex items-center justify-between gap-2"
                        >
                          <div>
                            <span className="font-bold text-slate-900">{cand.symbol}</span>{' '}
                            <span className="text-slate-500">
                              ({cand.quantity} units @ avg {formatINR(cand.avgCostBasis)})
                            </span>
                          </div>
                          <div className="text-right">
                            <span className="text-[#E11D48] font-bold mr-3">
                              Loss: -{formatINR(cand.unrealizedLoss)}
                            </span>
                            <span className="px-2 py-0.5 rounded bg-emerald-100 text-[#059669] font-bold">
                              Saves {formatINR(cand.potentialStcgTaxSaved)} STCG Tax
                            </span>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                {/* SEBI Statutory Contract Note Ledger */}
                <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
                  <div className="px-4 py-2.5 bg-slate-900 text-white text-xs font-bold flex items-center justify-between">
                    <span>SEBI-Compliant Electronic Contract Note & Statutory Ledger</span>
                    <span className="text-[10px] font-mono text-[#00D09C]">
                      STT • NSE/BSE/MCX Turnover • SEBI • Stamp Duty • 18% GST • CDSL DP
                    </span>
                  </div>
                  <div className="p-4 text-xs font-mono space-y-2">
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 bg-slate-50 p-3 rounded-lg border border-slate-200">
                      <div>
                        <div className="text-[10px] text-slate-500">Selected Trade</div>
                        <div className="font-bold text-slate-900">
                          {orderSide} {orderQty} {selectedSymbol}
                        </div>
                      </div>
                      <div>
                        <div className="text-[10px] text-slate-500">STT / CTT</div>
                        <div className="font-bold text-slate-900">
                          {formatINR(statutoryBreakdown.stt)}
                        </div>
                      </div>
                      <div>
                        <div className="text-[10px] text-slate-500">
                          Stamp Duty + DP Charge
                        </div>
                        <div className="font-bold text-slate-900">
                          {formatINR(
                            statutoryBreakdown.stampDuty + statutoryBreakdown.dpCharge
                          )}
                        </div>
                      </div>
                      <div>
                        <div className="text-[10px] text-slate-500">
                          Total Statutory Charges
                        </div>
                        <div className="font-bold text-[#E11D48]">
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
                <div className="bg-white rounded-xl border border-slate-200 p-4 flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <h3 className="text-sm font-bold text-slate-900">
                      Live Indian Stock Market, NSE/BSE & MCX Gold/Silver News Wire
                    </h3>
                    <p className="text-xs text-slate-600 mt-0.5">
                      Real-time Bullish & Bearish catalyst feed across Equities, F&O, Gold, Silver, and Mutual Funds
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
                    className="px-3 py-1.5 rounded-lg text-xs font-bold bg-[#059669] text-white hover:bg-emerald-600 cursor-pointer flex items-center gap-1.5"
                  >
                    <RefreshCw className="w-3.5 h-3.5" /> Refresh Live News
                  </button>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  {news.map((item) => {
                    const isBull = item.sentiment === 'BULLISH';
                    return (
                      <div
                        key={item.id}
                        className={`bg-white rounded-xl border border-slate-200 border-l-4 p-4 shadow-2xs flex flex-col justify-between gap-3 ${
                          isBull ? 'border-l-[#059669]' : 'border-l-[#E11D48]'
                        }`}
                      >
                        <div>
                          <div className="flex items-center justify-between gap-2">
                            <div className="flex items-center gap-2">
                              <span className="px-2 py-0.5 rounded bg-slate-900 text-white text-xs font-bold">
                                {item.symbol}
                              </span>
                              <span className="text-xs text-slate-500 font-medium">
                                {item.source} • {item.publishedAt}
                              </span>
                            </div>
                            <span
                              className={`px-2 py-0.5 rounded-full text-xs font-bold ${
                                isBull
                                  ? 'bg-emerald-100 text-[#059669]'
                                  : 'bg-rose-100 text-[#E11D48]'
                              }`}
                            >
                              {isBull ? 'Bullish Catalyst' : 'Bearish Catalyst'}
                            </span>
                          </div>
                          <h4 className="text-sm font-bold text-slate-900 mt-2 leading-snug">
                            {item.headline}
                          </h4>
                          <p className="text-xs text-slate-600 mt-1.5 leading-relaxed">
                            {item.summary}
                          </p>
                        </div>
                        <div className="flex items-center justify-between pt-2 border-t border-slate-100">
                          <span className="text-xs text-slate-500">
                            Impact Score: <strong>{item.impactScore}/10</strong>
                          </span>
                          <button
                            onClick={() => {
                              setSelectedSymbol(item.symbol);
                              setActiveTab('TERMINAL');
                            }}
                            className={`px-3 py-1 rounded-lg text-xs font-bold text-white cursor-pointer ${
                              isBull
                                ? 'bg-[#059669] hover:bg-emerald-600'
                                : 'bg-[#E11D48] hover:bg-rose-600'
                            }`}
                          >
                            Inspect & Trade {item.symbol} →
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* ================= TAB 5: GEMINI 3.8 FLASH RISK COPILOT ================= */}
            {activeTab === 'AI_COPILOT' && (
              <div className="space-y-4">
                <div className="bg-white rounded-xl border border-slate-200 p-4 space-y-3">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <Sparkles className="w-4 h-4 text-[#059669]" />
                      <h3 className="text-sm font-bold text-slate-900">
                        Gemini 3.8 Flash Quantitative Risk & Stress-Test Copilot
                      </h3>
                    </div>
                    <button
                      onClick={() => runCopilotAudit(copilotQuestion)}
                      disabled={copilotLoading}
                      className="px-3 py-1.5 rounded-lg text-xs font-bold bg-[#059669] text-white hover:bg-emerald-600 cursor-pointer disabled:opacity-50"
                    >
                      {copilotLoading ? 'Analyzing Ledger...' : 'Run Risk Audit'}
                    </button>
                  </div>

                  <div className="flex gap-2">
                    <input
                      type="text"
                      value={copilotQuestion}
                      onChange={(e) => setCopilotQuestion(e.target.value)}
                      placeholder="Ask e.g. 'What happens to my portfolio if Nifty 50 drops 4%?'"
                      className="flex-1 px-3 py-2 text-xs rounded-lg border border-slate-300"
                    />
                    <button
                      onClick={() => runCopilotAudit(copilotQuestion)}
                      className="px-4 py-2 rounded-lg text-xs font-bold bg-[#0B1320] text-[#00D09C] cursor-pointer"
                    >
                      Ask Gemini 3.8 Flash
                    </button>
                  </div>

                  {aiAnalysis && (
                    <div className="space-y-3 pt-2">
                      <div className="p-3 rounded-lg bg-slate-50 border border-slate-200 text-xs">
                        <div className="font-bold text-slate-900 mb-1">
                          Executive Summary ({aiAnalysis.modelUsed}):
                        </div>
                        <p className="text-slate-700">{aiAnalysis.executiveSummary}</p>
                        {aiAnalysis.queryAnswer && (
                          <p className="mt-2 font-medium text-emerald-800 bg-emerald-50 p-2 rounded border border-emerald-200">
                            {aiAnalysis.queryAnswer}
                          </p>
                        )}
                      </div>

                      <div className="grid grid-cols-1 md:grid-cols-3 gap-2.5">
                        {aiAnalysis.stressTestScenarios.map((sc) => (
                          <div
                            key={sc.scenarioName}
                            className="p-3 rounded-lg border border-rose-200 bg-rose-50/40 text-xs"
                          >
                            <div className="font-bold text-slate-900">{sc.scenarioName}</div>
                            <div className="font-mono text-sm font-extrabold text-[#E11D48] mt-1">
                              {formatINR(sc.estimatedPnlImpact)} ({sc.estimatedPnlPercent}%)
                            </div>
                            <p className="text-[11px] text-slate-600 mt-1">{sc.explanation}</p>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* ================= TAB 6: PRICE ALERTS & ACID ORDER BOOK ================= */}
            {activeTab === 'ALERTS_AND_ORDERS' && (
              <div className="space-y-4">
                <form
                  onSubmit={handleCreateAlert}
                  className="bg-white rounded-xl border border-slate-200 p-4 flex flex-wrap items-end gap-2.5"
                >
                  <div>
                    <label className="block text-[11px] font-semibold text-slate-600 mb-1">
                      Symbol
                    </label>
                    <input
                      type="text"
                      readOnly
                      value={selectedSymbol}
                      className="px-3 py-1.5 text-xs font-mono font-bold bg-slate-100 rounded border border-slate-300 w-28"
                    />
                  </div>
                  <div>
                    <label className="block text-[11px] font-semibold text-slate-600 mb-1">
                      Condition
                    </label>
                    <select
                      value={alertDirection}
                      onChange={(e) => setAlertDirection(e.target.value as AlertDirection)}
                      className="px-3 py-1.5 text-xs rounded border border-slate-300 bg-white"
                    >
                      <option value="ABOVE">Crosses ABOVE (Bull Breakout)</option>
                      <option value="BELOW">Drops BELOW (Bear Stop)</option>
                    </select>
                  </div>
                  <div>
                    <label className="block text-[11px] font-semibold text-slate-600 mb-1">
                      Target Price (₹)
                    </label>
                    <input
                      type="number"
                      step="any"
                      value={alertTargetPrice}
                      onChange={(e) => setAlertTargetPrice(e.target.value)}
                      placeholder={String(activeTick?.price ?? 1000)}
                      className="px-3 py-1.5 text-xs font-mono rounded border border-slate-300 w-32"
                    />
                  </div>
                  <button
                    type="submit"
                    className="px-4 py-1.5 rounded-lg text-xs font-bold bg-[#059669] text-white cursor-pointer"
                  >
                    + Set Alert
                  </button>
                </form>

                <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
                  <div className="px-4 py-2.5 bg-slate-50 border-b border-slate-200 text-xs font-bold text-slate-700">
                    Executed Order Book ({livePortfolio?.recentOrders.length ?? 0})
                  </div>
                  <div className="divide-y divide-slate-100 max-h-80 overflow-y-auto text-xs font-mono">
                    {(livePortfolio?.recentOrders ?? []).map((ord) => (
                      <div
                        key={ord.id}
                        className="px-4 py-2.5 flex items-center justify-between"
                      >
                        <div>
                          <span
                            className={`px-1.5 py-0.5 rounded font-bold mr-2 ${
                              ord.side === 'BUY'
                                ? 'bg-emerald-100 text-[#059669]'
                                : 'bg-rose-100 text-[#E11D48]'
                            }`}
                          >
                            {ord.side}
                          </span>
                          <span className="font-bold text-slate-900">
                            {ord.quantity} {ord.symbol}
                          </span>{' '}
                          @ {formatINR(ord.executionPrice)}
                          <span className="ml-2 text-[10px] px-1.5 py-0.5 rounded bg-slate-100 text-slate-600">
                            {ord.brokerSource}
                          </span>
                        </div>
                        <div className="text-right">
                          <div className="font-bold text-slate-900">
                            {formatINR(ord.totalNotional)}
                          </div>
                          {ord.side === 'SELL' && (
                            <div
                              className={`text-[10px] ${
                                ord.realizedPnl >= 0 ? 'text-[#059669]' : 'text-[#E11D48]'
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

        {/* RIGHT COLUMN (3 COLS): DYNAMIC BULLISH (GREEN) / BEARISH (RED) EXECUTION TERMINAL */}
        <aside className="lg:col-span-3 bg-white border-l border-slate-200 p-4 flex flex-col gap-4 h-[calc(100vh-88px)] sticky top-[88px] overflow-y-auto">
          {/* Dynamic Order Ticket — Morphs between Bullish Emerald (#059669) and Bearish Crimson (#E11D48) */}
          <div
            className={`rounded-2xl border-2 p-4 shadow-sm transition-colors ${
              orderSide === 'BUY'
                ? 'bg-emerald-50/40 border-[#059669]'
                : 'bg-rose-50/40 border-[#E11D48]'
            }`}
          >
            {/* Bullish BUY vs Bearish SELL Toggle Header */}
            <div className="grid grid-cols-2 gap-2 p-1 rounded-xl bg-slate-900 mb-4">
              <button
                type="button"
                onClick={() => {
                  setOrderSide('BUY');
                  setOrderStatus({ type: 'IDLE', message: '' });
                }}
                className={`py-2 rounded-lg text-xs font-extrabold tracking-wide flex items-center justify-center gap-1.5 transition cursor-pointer ${
                  orderSide === 'BUY'
                    ? 'bg-[#00B386] text-white shadow-sm'
                    : 'text-slate-400 hover:text-white'
                }`}
              >
                <TrendingUp className="w-3.5 h-3.5" />
                <span>BUY (BULLISH)</span>
              </button>
              <button
                type="button"
                onClick={() => {
                  setOrderSide('SELL');
                  setOrderStatus({ type: 'IDLE', message: '' });
                }}
                className={`py-2 rounded-lg text-xs font-extrabold tracking-wide flex items-center justify-center gap-1.5 transition cursor-pointer ${
                  orderSide === 'SELL'
                    ? 'bg-[#E11D48] text-white shadow-sm'
                    : 'text-slate-400 hover:text-white'
                }`}
              >
                <TrendingDown className="w-3.5 h-3.5" />
                <span>SELL (BEARISH)</span>
              </button>
            </div>

            <div className="flex items-baseline justify-between mb-3">
              <div>
                <span className="text-sm font-extrabold text-slate-900">
                  {selectedSymbol}
                </span>
                <span className="ml-1.5 text-[10px] font-mono px-1.5 py-0.5 rounded bg-slate-200 text-slate-800 font-bold">
                  {activeMeta?.exchange ?? 'NSE'}
                </span>
              </div>
              <div className="text-right font-mono">
                <div
                  className={`text-base font-extrabold ${
                    orderSide === 'BUY' ? 'text-[#059669]' : 'text-[#E11D48]'
                  }`}
                >
                  {formatINR(activeTick?.price ?? activeMeta?.basePrice ?? 0)}
                </div>
                <div className="text-[10px] text-slate-500">Real-Time Market LTP</div>
              </div>
            </div>

            <form onSubmit={handleOrderSubmit} className="space-y-3">
              <div>
                <div className="flex justify-between text-[11px] font-semibold text-slate-700 mb-1">
                  <span>Quantity (Shares / Units)</span>
                  {activePosition && (
                    <span className="font-mono text-emerald-700">
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
                  className="w-full px-3 py-2 text-sm font-mono font-bold bg-white rounded-lg border border-slate-300 focus:outline-none focus:ring-2 focus:ring-emerald-500"
                />
              </div>

              <div>
                <label className="block text-[11px] font-semibold text-slate-700 mb-1">
                  Demat Broker Account Tag
                </label>
                <select
                  value={orderBrokerSource}
                  onChange={(e) => setOrderBrokerSource(e.target.value as BrokerSource)}
                  className="w-full px-3 py-1.5 text-xs rounded-lg border border-slate-300 bg-white font-medium"
                >
                  <option value="KitePulse Direct">KitePulse Direct Demat</option>
                  <option value="SBI Securities">SBI Securities (3-in-1)</option>
                  <option value="HDFC Sky">HDFC Sky Demat</option>
                  <option value="Groww">Groww Demat</option>
                  <option value="Zerodha Kite">Zerodha Kite</option>
                </select>
              </div>

              {/* 3-in-1 Bank Auto-Sweep Option (Direct Bank Settlement like SBI Securities) */}
              <div className="p-2.5 rounded-lg bg-white border border-slate-200 space-y-2">
                <label className="flex items-center gap-2 text-xs font-bold text-slate-800 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={useThreeInOneAutoDebit}
                    onChange={(e) => setUseThreeInOneAutoDebit(e.target.checked)}
                    className="rounded text-emerald-600"
                  />
                  <span>3-in-1 Direct Bank Settlement (ASBA)</span>
                </label>
                {useThreeInOneAutoDebit && livePortfolio && (
                  <select
                    value={selectedThreeInOneBankId}
                    onChange={(e) => setSelectedThreeInOneBankId(Number(e.target.value))}
                    className="w-full px-2 py-1.5 text-[11px] rounded border border-slate-300 bg-slate-50 font-mono"
                  >
                    {livePortfolio.bankAccounts.map((b) => (
                      <option key={b.id} value={b.id}>
                        {b.bankName} ({formatINR(b.balance)})
                      </option>
                    ))}
                  </select>
                )}
              </div>

              <div className="p-2.5 rounded-lg bg-slate-900 text-white font-mono text-xs space-y-1">
                <div className="flex justify-between">
                  <span className="text-slate-400">Order Turnover:</span>
                  <span className="font-bold text-white">
                    {formatINR(estimatedOrderNotional)}
                  </span>
                </div>
                <div className="flex justify-between text-[11px]">
                  <span className="text-slate-400">
                    SEBI/STT/GST/DP Charges:
                  </span>
                  <span className="text-rose-400 font-semibold">
                    +{formatINR(statutoryBreakdown.totalCharges)}
                  </span>
                </div>
                <div className="flex justify-between text-[11px] border-t border-slate-800 pt-1">
                  <span className="text-slate-300">Net Settlement:</span>
                  <span className="text-[#00D09C] font-bold">
                    {formatINR(statutoryBreakdown.netSettlementAmount)}
                  </span>
                </div>
                <div className="flex justify-between text-[11px]">
                  <span className="text-slate-400">Demat Cash Margin:</span>
                  <span className="text-amber-400 font-bold">
                    {formatINR(livePortfolio?.cashBalance ?? 0)}
                  </span>
                </div>
              </div>

              <button
                type="submit"
                disabled={orderStatus.type === 'SUBMITTING'}
                className={`w-full py-3 rounded-xl text-xs font-extrabold uppercase tracking-wider text-white shadow-md transition cursor-pointer ${
                  orderSide === 'BUY'
                    ? 'bg-[#059669] hover:bg-[#047857]'
                    : 'bg-[#E11D48] hover:bg-[#BE123C]'
                }`}
              >
                {orderStatus.type === 'SUBMITTING'
                  ? 'Executing on ACID Ledger...'
                  : `${orderSide} ${orderQty} ${selectedSymbol} @ ${formatINR(
                      activeTick?.price ?? activeMeta?.basePrice ?? 0
                    )}`}
              </button>

              {orderStatus.message && (
                <div
                  className={`p-2.5 rounded-lg text-xs font-medium flex items-start gap-1.5 ${
                    orderStatus.type === 'ERROR'
                      ? 'bg-rose-100 text-rose-900 border border-rose-300'
                      : 'bg-emerald-100 text-emerald-950 border border-emerald-300'
                  }`}
                >
                  {orderStatus.type === 'ERROR' ? (
                    <AlertTriangle className="w-4 h-4 shrink-0 text-rose-600 mt-0.5" />
                  ) : (
                    <CheckCircle2 className="w-4 h-4 shrink-0 text-emerald-600 mt-0.5" />
                  )}
                  <span>{orderStatus.message}</span>
                </div>
              )}
            </form>
          </div>

          {/* 5-Level NSE / BSE / MCX Live Market Depth Order Book Ladder */}
          <div className="bg-white rounded-xl border border-slate-200 p-3.5 space-y-2.5 shadow-2xs">
            <div className="flex items-center justify-between text-xs font-bold text-slate-800">
              <span>5-Level Market Depth ({selectedSymbol})</span>
              <span className="text-[10px] font-mono text-slate-500">L2 ORDER BOOK</span>
            </div>

            {/* Buy vs Sell Order Book Pressure Bar */}
            <div className="space-y-1">
              <div className="flex justify-between text-[10px] font-mono font-bold">
                <span className="text-[#059669]">
                  BIDS: {marketDepth.buyPressurePercent}% ({marketDepth.totalBidQty})
                </span>
                <span className="text-[#E11D48]">
                  ASKS: {marketDepth.sellPressurePercent}% ({marketDepth.totalAskQty})
                </span>
              </div>
              <div className="h-2 rounded-full bg-[#E11D48] overflow-hidden flex">
                <div
                  className="h-full bg-[#059669] transition-all duration-300"
                  style={{ width: `${marketDepth.buyPressurePercent}%` }}
                />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-2 text-[10px] font-mono">
              <div>
                <div className="flex justify-between text-slate-400 pb-1 border-b border-slate-100">
                  <span>BID (₹)</span>
                  <span>QTY</span>
                </div>
                {marketDepth.bids.map((b, i) => (
                  <div
                    key={i}
                    className="flex justify-between py-0.5 text-[#059669] font-semibold"
                  >
                    <span>{b.price.toFixed(2)}</span>
                    <span>{b.quantity}</span>
                  </div>
                ))}
              </div>
              <div>
                <div className="flex justify-between text-slate-400 pb-1 border-b border-slate-100">
                  <span>ASK (₹)</span>
                  <span>QTY</span>
                </div>
                {marketDepth.asks.map((a, i) => (
                  <div
                    key={i}
                    className="flex justify-between py-0.5 text-[#E11D48] font-semibold"
                  >
                    <span>{a.price.toFixed(2)}</span>
                    <span>{a.quantity}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* Live Market Pulse & News Feed */}
          <div className="bg-slate-50 rounded-xl border border-slate-200 p-3.5 space-y-2.5">
            <div className="text-xs font-bold uppercase tracking-wider text-slate-700 flex items-center justify-between">
              <span>Dalal Street Bull & Bear Wire</span>
              <span className="text-[10px] font-mono text-emerald-700">LIVE</span>
            </div>
            <div className="space-y-2">
              {news.slice(0, 4).map((item) => {
                const isBull = item.sentiment === 'BULLISH';
                return (
                  <div
                    key={item.id}
                    onClick={() => setSelectedSymbol(item.symbol)}
                    className={`p-2.5 rounded-lg bg-white border-l-4 shadow-2xs cursor-pointer hover:bg-slate-100/70 transition ${
                      isBull ? 'border-l-[#059669]' : 'border-l-[#E11D48]'
                    }`}
                  >
                    <div className="flex items-center justify-between text-[10px] font-mono">
                      <span className="font-bold text-slate-900">{item.symbol}</span>
                      <span
                        className={`px-1.5 py-0.2 rounded font-bold ${
                          isBull
                            ? 'bg-emerald-100 text-[#059669]'
                            : 'bg-rose-100 text-[#E11D48]'
                        }`}
                      >
                        {item.sentiment}
                      </span>
                    </div>
                    <p className="text-xs font-semibold text-slate-800 mt-1 leading-snug">
                      {item.headline}
                    </p>
                  </div>
                );
              })}
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
};
export default App;
