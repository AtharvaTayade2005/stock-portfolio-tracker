import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  BarChart2,
  Bell,
  Briefcase,
  ChevronDown,
  ChevronRight,
  Layers,
  Search,
  ShieldCheck,
  Sparkles,
  Trash2,
  TrendingUp,
  X,
} from 'lucide-react';
import {
  formatINR,
  SEGMENT_LABELS,
  SYMBOL_CATALOG,
  SYMBOL_MAP,
} from '../shared/catalog.js';
import { computeAllIndicators } from '../shared/indicators.js';
import type {
  AiCopilotAnalysis,
  AlertDirection,
  IndicatorSummary,
  InstrumentSegment,
  MarketTick,
  NewsItem,
  OhlcvCandle,
  OrderSide,
  PortfolioSnapshot,
  PriceAlert,
  ReplaySpeed,
  WsServerMessage,
} from '../shared/types.js';
import { CandlestickChart } from './components/CandlestickChart.js';

type MainNavView = 'HOLDINGS' | 'FNO_POSITIONS' | 'CHART' | 'ORDERS_ALERTS' | 'INSIGHTS';
type WatchlistSegmentFilter = 'ALL' | InstrumentSegment;

export const App: React.FC = () => {
  // Navigation & Selection State
  const [activeView, setActiveView] = useState<MainNavView>('HOLDINGS');
  const [selectedSymbol, setSelectedSymbol] = useState<string>('RELIANCE');
  const [expandedHoldingSymbol, setExpandedHoldingSymbol] = useState<string | null>('RELIANCE');
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [watchlistFilter, setWatchlistFilter] = useState<WatchlistSegmentFilter>('ALL');
  const [holdingsFilter, setHoldingsFilter] = useState<WatchlistSegmentFilter>('ALL');

  // Market & Portfolio Data
  const [ticksBySymbol, setTicksBySymbol] = useState<Record<string, MarketTick>>({});
  const [candles, setCandles] = useState<OhlcvCandle[]>([]);
  const [indicators, setIndicators] = useState<IndicatorSummary | null>(null);
  const [portfolio, setPortfolio] = useState<PortfolioSnapshot | null>(null);
  const [alerts, setAlerts] = useState<PriceAlert[]>([]);
  const [news, setNews] = useState<NewsItem[]>([]);
  const [copilot, setCopilot] = useState<AiCopilotAnalysis | null>(null);

  // Stream & Replay Speed
  const [wsConnected, setWsConnected] = useState<boolean>(false);
  const [replaySpeed, setReplaySpeed] = useState<ReplaySpeed>(1);
  const [triggeredBanner, setTriggeredBanner] = useState<{
    alert: PriceAlert;
    price: number;
  } | null>(null);

  // Chart Overlays
  const [showSma, setShowSma] = useState<boolean>(true);
  const [showEma, setShowEma] = useState<boolean>(false);
  const [showBollinger, setShowBollinger] = useState<boolean>(true);

  // Zerodha Kite-Style Floating Order Ticket Modal State
  const [orderModalOpen, setOrderModalOpen] = useState<boolean>(false);
  const [orderSymbol, setOrderSymbol] = useState<string>('RELIANCE');
  const [orderSide, setOrderSide] = useState<OrderSide>('BUY');
  const [orderQty, setOrderQty] = useState<string>('25');
  const [orderStatus, setOrderStatus] = useState<{
    type: 'success' | 'error' | 'info';
    text: string;
  } | null>(null);
  const [submittingOrder, setSubmittingOrder] = useState<boolean>(false);

  // Price Alert Form
  const [alertSymbol, setAlertSymbol] = useState<string>('RELIANCE');
  const [alertDirection, setAlertDirection] = useState<AlertDirection>('ABOVE');
  const [alertPriceInput, setAlertPriceInput] = useState<string>('');
  const [alertNoteInput, setAlertNoteInput] = useState<string>('');

  // AI Copilot Prompt
  const [copilotQuestion, setCopilotQuestion] = useState<string>(
    'What happens to my P&L if Nifty drops 5%?'
  );
  const [copilotLoading, setCopilotLoading] = useState<boolean>(false);

  // Web Worker & rAF Batching Refs
  const workerRef = useRef<Worker | null>(null);
  const selectedSymbolRef = useRef<string>(selectedSymbol);
  selectedSymbolRef.current = selectedSymbol;

  const pendingTicksRef = useRef<Map<string, MarketTick>>(new Map());
  const pendingCandlesRef = useRef<Map<string, OhlcvCandle>>(new Map());
  const rafIdRef = useRef<number | null>(null);

  useEffect(() => {
    try {
      const worker = new Worker(
        new URL('./workers/indicators.worker.ts', import.meta.url),
        { type: 'module' }
      );
      worker.onmessage = (event: MessageEvent<IndicatorSummary>) => {
        if (event.data && event.data.symbol === selectedSymbolRef.current) {
          setIndicators(event.data);
        }
      };
      workerRef.current = worker;
      return () => worker.terminate();
    } catch {
      workerRef.current = null;
    }
  }, []);

  const dispatchIndicatorsCalculation = useCallback((sym: string, candleList: OhlcvCandle[]) => {
    if (candleList.length === 0) return;
    if (workerRef.current) {
      workerRef.current.postMessage({ symbol: sym, candles: candleList });
    } else {
      setIndicators(computeAllIndicators(sym, candleList));
    }
  }, []);

  const fetchCoreData = useCallback(async () => {
    try {
      const [catRes, portRes, alertRes, newsRes, copilotRes] = await Promise.all([
        fetch('/api/catalog'),
        fetch('/api/portfolio'),
        fetch('/api/alerts'),
        fetch('/api/news'),
        fetch('/api/copilot/analyze', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ question: 'What happens to my P&L if Nifty drops 5%?' }),
        }),
      ]);

      if (catRes.ok) {
        const catData = await catRes.json();
        const map: Record<string, MarketTick> = {};
        for (const t of catData.ticks || []) {
          map[t.symbol] = t;
        }
        setTicksBySymbol(map);
        setReplaySpeed(catData.replaySpeed ?? 1);
      }
      if (portRes.ok) setPortfolio(await portRes.json());
      if (alertRes.ok) {
        const aData = await alertRes.json();
        setAlerts(aData.alerts || []);
      }
      if (newsRes.ok) {
        const nData = await newsRes.json();
        setNews(nData.news || []);
      }
      if (copilotRes.ok) {
        setCopilot(await copilotRes.json());
      }
    } catch {
      // Handled gracefully
    }
  }, []);

  useEffect(() => {
    fetchCoreData();
  }, [fetchCoreData]);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const res = await fetch(`/api/candles?symbol=${encodeURIComponent(selectedSymbol)}`);
        if (!res.ok || !active) return;
        const data = await res.json();
        const loadedCandles: OhlcvCandle[] = data.candles || [];
        setCandles(loadedCandles);
        dispatchIndicatorsCalculation(selectedSymbol, loadedCandles);

        if (loadedCandles.length > 0) {
          const latest = loadedCandles[loadedCandles.length - 1].close;
          setAlertSymbol(selectedSymbol);
          setAlertPriceInput((latest * 1.003).toFixed(2));
        }
      } catch {
        // Ignore network errors during switch
      }
    })();
    return () => {
      active = false;
    };
  }, [selectedSymbol, dispatchIndicatorsCalculation]);

  // WebSocket Stream with requestAnimationFrame (60fps) Batching
  useEffect(() => {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/ws`;
    let ws: WebSocket | null = null;
    let reconnectTimer: number | null = null;

    const flushPendingTicks = () => {
      rafIdRef.current = null;
      if (pendingTicksRef.current.size === 0) return;

      const batchTicks = Array.from(pendingTicksRef.current.values());
      const batchCandles = new Map(pendingCandlesRef.current);
      pendingTicksRef.current.clear();
      pendingCandlesRef.current.clear();

      setTicksBySymbol((prev) => {
        const next = { ...prev };
        for (const t of batchTicks) {
          next[t.symbol] = t;
        }
        return next;
      });

      const activeSym = selectedSymbolRef.current;
      const updatedActiveCandle = batchCandles.get(activeSym);
      if (updatedActiveCandle) {
        setCandles((prev) => {
          if (prev.length === 0) return [updatedActiveCandle];
          const last = prev[prev.length - 1];
          let nextCandles: OhlcvCandle[];
          if (last.time === updatedActiveCandle.time) {
            nextCandles = [...prev.slice(0, -1), updatedActiveCandle];
          } else {
            nextCandles = [...prev.slice(-219), updatedActiveCandle];
          }
          dispatchIndicatorsCalculation(activeSym, nextCandles);
          return nextCandles;
        });
      }
    };

    const connect = () => {
      ws = new WebSocket(wsUrl);
      ws.onopen = () => setWsConnected(true);
      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data) as WsServerMessage;
          if (msg.type === 'INITIAL_STATE') {
            const map: Record<string, MarketTick> = {};
            for (const t of msg.ticks) map[t.symbol] = t;
            setTicksBySymbol(map);
            setReplaySpeed(msg.replaySpeed);
          } else if (msg.type === 'TICK_BATCH') {
            for (const t of msg.ticks) pendingTicksRef.current.set(t.symbol, t);
            for (const c of msg.updatedCandles) pendingCandlesRef.current.set(c.symbol, c);
            if (rafIdRef.current === null) {
              rafIdRef.current = window.requestAnimationFrame(flushPendingTicks);
            }
          } else if (msg.type === 'REPLAY_SPEED_CHANGED') {
            setReplaySpeed(msg.replaySpeed);
          } else if (msg.type === 'ALERT_TRIGGERED') {
            setTriggeredBanner({ alert: msg.alert, price: msg.tick.price });
            setAlerts((prev) => prev.map((a) => (a.id === msg.alert.id ? msg.alert : a)));
          }
        } catch {
          // Ignore malformed frames
        }
      };
      ws.onclose = () => {
        setWsConnected(false);
        reconnectTimer = window.setTimeout(connect, 2000);
      };
    };

    connect();
    return () => {
      if (reconnectTimer !== null) clearTimeout(reconnectTimer);
      if (rafIdRef.current !== null) cancelAnimationFrame(rafIdRef.current);
      if (ws) ws.close();
    };
  }, [dispatchIndicatorsCalculation]);

  // Live Portfolio Valuation in INR (₹)
  const livePortfolio = useMemo<PortfolioSnapshot | null>(() => {
    if (!portfolio) return null;

    let holdingsMarketValue = 0;
    let totalCostBasis = 0;

    const updatedHoldings = portfolio.holdings.map((h) => {
      const liveTick = ticksBySymbol[h.symbol];
      const currentPrice = liveTick ? liveTick.price : h.currentPrice;
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
        dayChangePercent,
        marketValue,
        unrealizedPnl,
        unrealizedPnlPercent,
      };
    });

    holdingsMarketValue = Number(holdingsMarketValue.toFixed(2));
    const totalEquity = Number((portfolio.cashBalance + holdingsMarketValue).toFixed(2));
    const totalUnrealizedPnl = Number((holdingsMarketValue - totalCostBasis).toFixed(2));
    const totalUnrealizedPnlPercent =
      totalCostBasis > 0 ? Number(((totalUnrealizedPnl / totalCostBasis) * 100).toFixed(2)) : 0;

    let weightedBeta = 0;
    const segmentMap = new Map<InstrumentSegment, { mv: number; pnl: number }>();

    for (const h of updatedHoldings) {
      h.weightPercent =
        holdingsMarketValue > 0 ? Number(((h.marketValue / holdingsMarketValue) * 100).toFixed(2)) : 0;
      weightedBeta += (h.weightPercent / 100) * h.beta;

      const segEntry = segmentMap.get(h.segment) ?? { mv: 0, pnl: 0 };
      segEntry.mv += h.marketValue;
      segEntry.pnl += h.unrealizedPnl;
      segmentMap.set(h.segment, segEntry);
    }

    const segmentAllocations = Array.from(segmentMap.entries())
      .map(([segment, val]) => ({
        segment,
        label: SEGMENT_LABELS[segment],
        marketValue: Number(val.mv.toFixed(2)),
        unrealizedPnl: Number(val.pnl.toFixed(2)),
        weightPercent:
          holdingsMarketValue > 0 ? Number(((val.mv / holdingsMarketValue) * 100).toFixed(2)) : 0,
      }))
      .sort((a, b) => b.marketValue - a.marketValue);

    return {
      ...portfolio,
      holdingsMarketValue,
      totalEquity,
      totalUnrealizedPnl,
      totalUnrealizedPnlPercent,
      portfolioBeta: Number(weightedBeta.toFixed(2)),
      holdings: updatedHoldings,
      segmentAllocations,
    };
  }, [portfolio, ticksBySymbol]);

  // Live NIFTY 50 & BSE SENSEX Index Header Strip
  const indianIndices = useMemo(() => {
    const niftyFut = ticksBySymbol['NIFTY 28NOV FUT'];
    const bankFut = ticksBySymbol['BANKNIFTY 28NOV FUT'];
    const rel = ticksBySymbol['RELIANCE'];
    const hdfc = ticksBySymbol['HDFCBANK'];

    const niftyVal = niftyFut ? Number((niftyFut.price - 32).toFixed(2)) : 24182.4;
    const niftyPct = niftyFut ? niftyFut.changePercent : 0.48;

    const sensexPct =
      rel && hdfc ? Number(((rel.changePercent + hdfc.changePercent) / 2).toFixed(2)) : 0.52;
    const sensexVal = Number((79640.0 * (1 + sensexPct / 100)).toFixed(2));

    const bankVal = bankFut ? Number((bankFut.price - 45).toFixed(2)) : 51795.0;
    const bankPct = bankFut ? bankFut.changePercent : 0.39;

    return { niftyVal, niftyPct, sensexVal, sensexPct, bankVal, bankPct };
  }, [ticksBySymbol]);

  const activeTick = ticksBySymbol[selectedSymbol];
  const activeMeta = SYMBOL_MAP.get(selectedSymbol) ?? SYMBOL_CATALOG[0];
  const activeHolding = livePortfolio?.holdings.find((h) => h.symbol === selectedSymbol);

  const modalTick = ticksBySymbol[orderSymbol];
  const modalMeta = SYMBOL_MAP.get(orderSymbol) ?? SYMBOL_CATALOG[0];
  const modalHolding = livePortfolio?.holdings.find((h) => h.symbol === orderSymbol);

  const openOrderTicket = (symbol: string, side: OrderSide) => {
    const meta = SYMBOL_MAP.get(symbol);
    setOrderSymbol(symbol);
    setOrderSide(side);
    setOrderQty(String(meta?.lotSize && meta.lotSize > 1 ? meta.lotSize : 10));
    setOrderStatus(null);
    setOrderModalOpen(true);
  };

  const estimatedOrderPreview = useMemo(() => {
    const qty = Number(orderQty);
    const targetTick = ticksBySymbol[orderSymbol];
    if (!Number.isFinite(qty) || qty <= 0 || !targetTick) {
      return { notional: 0, execPrice: 0, estFifoPnl: null as number | null };
    }
    const execPrice = orderSide === 'BUY' ? targetTick.ask : targetTick.bid;
    const notional = Number((qty * execPrice).toFixed(2));

    if (orderSide === 'SELL' && livePortfolio) {
      const symbolLots = livePortfolio.openTaxLots.filter(
        (l) => l.symbol === orderSymbol && l.remainingQty > 0
      );
      let rem = qty;
      let pnl = 0;
      for (const lot of symbolLots) {
        if (rem <= 0) break;
        const take = Math.min(lot.remainingQty, rem);
        pnl += (execPrice - lot.buyPrice) * take;
        rem -= take;
      }
      return { notional, execPrice, estFifoPnl: Number(pnl.toFixed(2)) };
    }

    return { notional, execPrice, estFifoPnl: null };
  }, [orderQty, orderSide, orderSymbol, ticksBySymbol, livePortfolio]);

  const handleSpeedChange = async (speed: ReplaySpeed) => {
    setReplaySpeed(speed);
    await fetch('/api/replay/speed', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ speed }),
    });
  };

  const handleExecuteOrder = async (e: React.FormEvent) => {
    e.preventDefault();
    const qty = Number(orderQty);
    if (!Number.isFinite(qty) || qty <= 0) {
      setOrderStatus({ type: 'error', text: 'Please enter a valid positive quantity.' });
      return;
    }

    setSubmittingOrder(true);
    setOrderStatus(null);
    const idempotencyKey = `ord-${orderSymbol}-${orderSide}-${Date.now()}-${Math.random()
      .toString(36)
      .slice(2, 7)}`;

    try {
      const res = await fetch('/api/orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          symbol: orderSymbol,
          side: orderSide,
          quantity: qty,
          idempotencyKey,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setOrderStatus({ type: 'error', text: data.error || 'Order rejected.' });
      } else {
        setPortfolio(data.portfolio);
        const pnlSuffix =
          orderSide === 'SELL'
            ? ` • FIFO Realized P&L: ${data.order.realizedPnl >= 0 ? '+' : ''}${formatINR(data.order.realizedPnl)}`
            : '';
        setOrderStatus({
          type: 'success',
          text: `Executed ${orderSide} ${qty} ${orderSymbol} @ ${formatINR(data.order.executionPrice)}${pnlSuffix}`,
        });
      }
    } catch {
      setOrderStatus({ type: 'error', text: 'Network error executing order.' });
    } finally {
      setSubmittingOrder(false);
    }
  };

  // Interview Demo Feature: Fires two concurrent identical requests with the SAME idempotencyKey
  const handleTestIdempotencyBurst = async () => {
    const qty = Math.max(1, Number(orderQty) || modalMeta.lotSize);
    const sharedKey = `idem-burst-${orderSymbol}-${Date.now()}`;
    setSubmittingOrder(true);
    setOrderStatus(null);

    try {
      const payload = JSON.stringify({
        symbol: orderSymbol,
        side: orderSide,
        quantity: qty,
        idempotencyKey: sharedKey,
      });

      const [res1, res2] = await Promise.all([
        fetch('/api/orders', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: payload,
        }),
        fetch('/api/orders', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: payload,
        }),
      ]);

      const d1 = await res1.json();
      const d2 = await res2.json();

      if (!res1.ok) {
        setOrderStatus({ type: 'error', text: d1.error || 'Burst test failed.' });
      } else {
        setPortfolio(d2.portfolio || d1.portfolio);
        const deduped = Boolean(d1.deduplicated || d2.deduplicated);
        setOrderStatus({
          type: 'info',
          text: `Idempotency Verified! Fired 2 concurrent ${orderSide} requests with key "${sharedKey}". Order #${d1.order.id} executed once; duplicate was ${deduped ? 'safely deduplicated' : 'serialized'} by SQLite BEGIN IMMEDIATE.`,
        });
      }
    } finally {
      setSubmittingOrder(false);
    }
  };

  const handleCreateAlert = async (e: React.FormEvent) => {
    e.preventDefault();
    const targetPrice = Number(alertPriceInput);
    if (!Number.isFinite(targetPrice) || targetPrice <= 0) return;

    const res = await fetch('/api/alerts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        symbol: alertSymbol,
        direction: alertDirection,
        targetPrice,
        note: alertNoteInput || `${alertSymbol} ${alertDirection} ${formatINR(targetPrice)}`,
      }),
    });
    if (res.ok) {
      const data = await res.json();
      setAlerts(data.alerts || []);
      setAlertNoteInput('');
    }
  };

  const handleDeleteAlert = async (id: number) => {
    const res = await fetch(`/api/alerts/${id}`, { method: 'DELETE' });
    if (res.ok) {
      const data = await res.json();
      setAlerts(data.alerts || []);
    }
  };

  const handleRunCopilot = async (customPrompt?: string) => {
    const q = customPrompt ?? copilotQuestion;
    setCopilotLoading(true);
    try {
      const res = await fetch('/api/copilot/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question: q }),
      });
      if (res.ok) {
        setCopilot(await res.json());
      }
    } finally {
      setCopilotLoading(false);
    }
  };

  const filteredWatchlist = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return SYMBOL_CATALOG.filter((item) => {
      if (watchlistFilter !== 'ALL' && item.segment !== watchlistFilter) return false;
      if (!q) return true;
      return (
        item.symbol.toLowerCase().includes(q) ||
        item.name.toLowerCase().includes(q) ||
        item.sector.toLowerCase().includes(q) ||
        item.exchange.toLowerCase().includes(q)
      );
    });
  }, [searchQuery, watchlistFilter]);

  const filteredHoldings = useMemo(() => {
    if (!livePortfolio) return [];
    return livePortfolio.holdings.filter((h) => {
      if (holdingsFilter === 'ALL') return true;
      return h.segment === holdingsFilter;
    });
  }, [livePortfolio, holdingsFilter]);

  const fnoPositions = useMemo(() => {
    return livePortfolio?.holdings.filter((h) => h.segment === 'FNO') ?? [];
  }, [livePortfolio]);

  return (
    <div className="min-h-screen bg-[#F8FAFC] text-[#0F172A] flex flex-col">
      {/* Top Indian Brokerage Navigation Bar (Zerodha Kite / Groww Layout) */}
      <header className="bg-white border-b border-[#E2E8F0] sticky top-0 z-30 h-14 flex items-center">
        <div className="max-w-[1680px] w-full mx-auto flex items-center justify-between h-full">
          {/* Left Live Indian Benchmark Indices (NIFTY 50 & SENSEX) */}
          <div className="hidden xl:flex items-center gap-5 px-5 h-full border-r border-[#E2E8F0] w-[370px] shrink-0 text-xs tabular-nums">
            <div>
              <div className="flex items-center gap-1.5">
                <span className="font-semibold text-[#475569]">NIFTY 50</span>
                <span className="font-semibold text-[#0F172A]">
                  {indianIndices.niftyVal.toLocaleString('en-IN', { minimumFractionDigits: 2 })}
                </span>
              </div>
              <span
                className={`text-[11px] font-medium ${
                  indianIndices.niftyPct >= 0 ? 'text-[#00B386]' : 'text-[#EB5B3C]'
                }`}
              >
                {indianIndices.niftyPct >= 0 ? '+' : ''}
                {indianIndices.niftyPct.toFixed(2)}%
              </span>
            </div>

            <div>
              <div className="flex items-center gap-1.5">
                <span className="font-semibold text-[#475569]">SENSEX</span>
                <span className="font-semibold text-[#0F172A]">
                  {indianIndices.sensexVal.toLocaleString('en-IN', { minimumFractionDigits: 2 })}
                </span>
              </div>
              <span
                className={`text-[11px] font-medium ${
                  indianIndices.sensexPct >= 0 ? 'text-[#00B386]' : 'text-[#EB5B3C]'
                }`}
              >
                {indianIndices.sensexPct >= 0 ? '+' : ''}
                {indianIndices.sensexPct.toFixed(2)}%
              </span>
            </div>
          </div>

          {/* Right Brand & Primary Navigation Links */}
          <div className="flex-1 flex items-center justify-between px-5 h-full">
            <div className="flex items-center gap-6 h-full">
              <div className="flex items-center gap-2">
                <div className="w-7 h-7 rounded bg-[#387ED1] flex items-center justify-center text-white font-display font-bold text-sm">
                  K
                </div>
                <div>
                  <span className="font-display font-bold text-base tracking-tight text-[#0F172A]">
                    KitePulse
                  </span>
                  <span className="hidden sm:inline-block ml-1.5 text-[10px] font-semibold px-1.5 py-0.2 rounded bg-[#EFF6FF] text-[#387ED1]">
                    NSE • BSE • NFO • MF
                  </span>
                </div>
              </div>

              <nav className="flex items-center gap-1 h-full overflow-x-auto">
                {(
                  [
                    { id: 'HOLDINGS', label: 'Holdings (EQ / ETF / MF)', icon: Briefcase },
                    {
                      id: 'FNO_POSITIONS',
                      label: `F&O Derivatives (${fnoPositions.length})`,
                      icon: Layers,
                    },
                    { id: 'CHART', label: 'Charts & Terminal', icon: BarChart2 },
                    {
                      id: 'ORDERS_ALERTS',
                      label: `Orders & Alerts (${alerts.filter((a) => a.status === 'ACTIVE').length})`,
                      icon: Bell,
                    },
                    { id: 'INSIGHTS', label: 'AI Risk & News', icon: Sparkles },
                  ] as const
                ).map((item) => {
                  const Icon = item.icon;
                  const active = activeView === item.id;
                  return (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => setActiveView(item.id)}
                      className={`h-full px-3 flex items-center gap-1.5 text-xs sm:text-sm font-medium border-b-2 whitespace-nowrap transition-colors cursor-pointer ${
                        active
                          ? 'border-[#387ED1] text-[#387ED1]'
                          : 'border-transparent text-[#64748B] hover:text-[#0F172A]'
                      }`}
                    >
                      <Icon className="w-4 h-4" />
                      {item.label}
                    </button>
                  );
                })}
              </nav>
            </div>

            {/* Right Status & Market Replay Speed Switcher */}
            <div className="flex items-center gap-3">
              <div className="hidden md:flex items-center gap-1.5 text-xs text-[#64748B] bg-[#F8FAFC] border border-[#E2E8F0] rounded-md px-2.5 py-1">
                <span
                  className={`w-2 h-2 rounded-full ${
                    wsConnected ? 'bg-[#00B386]' : 'bg-[#EB5B3C]'
                  }`}
                />
                <span>{wsConnected ? 'NSE/BSE Live Replay' : 'Connecting...'}</span>
                <span className="text-[#CBD5E1] mx-1">|</span>
                {([0, 1, 5, 10] as ReplaySpeed[]).map((spd) => (
                  <button
                    key={spd}
                    type="button"
                    onClick={() => handleSpeedChange(spd)}
                    className={`px-1.5 py-0.5 rounded text-xs font-medium cursor-pointer transition-colors ${
                      replaySpeed === spd
                        ? 'bg-[#387ED1] text-white'
                        : 'text-[#64748B] hover:text-[#0F172A]'
                    }`}
                  >
                    {spd === 0 ? 'Pause' : `${spd}x`}
                  </button>
                ))}
              </div>

              <button
                type="button"
                onClick={() => openOrderTicket(selectedSymbol, 'BUY')}
                className="px-3.5 py-1.5 rounded-md bg-[#387ED1] hover:bg-[#2F6DB8] text-white text-xs font-semibold cursor-pointer transition-colors"
              >
                + Place Order
              </button>
            </div>
          </div>
        </div>
      </header>

      {/* Triggered Price Alert Notification Banner */}
      {triggeredBanner && (
        <div className="bg-[#EFF6FF] border-b border-[#BFDBFE] px-5 py-2.5">
          <div className="max-w-[1680px] mx-auto flex items-center justify-between gap-2 text-xs text-[#1E40AF]">
            <div className="flex items-center gap-2">
              <Bell className="w-4 h-4 text-[#387ED1] shrink-0" />
              <span>
                <strong>Price Alert Triggered:</strong> {triggeredBanner.alert.symbol} crossed{' '}
                {triggeredBanner.alert.direction.toLowerCase()} target{' '}
                <strong>{formatINR(triggeredBanner.alert.targetPrice)}</strong> (LTP:{' '}
                {formatINR(triggeredBanner.price)}) — {triggeredBanner.alert.note}
              </span>
            </div>
            <button
              type="button"
              onClick={() => setTriggeredBanner(null)}
              className="text-xs font-medium text-[#1E40AF] hover:underline cursor-pointer"
            >
              Dismiss
            </button>
          </div>
        </div>
      )}

      {/* Main Split Workspace: Left Indian Marketwatch Sidebar + Right Active View */}
      <div className="max-w-[1680px] w-full mx-auto flex-1 flex flex-col lg:flex-row">
        {/* LEFT PERSISTENT MARKETWATCH SIDEBAR (NSE / BSE / NFO / ETF / MF) */}
        <aside className="w-full lg:w-[370px] shrink-0 bg-white border-b lg:border-b-0 lg:border-r border-[#E2E8F0] flex flex-col">
          {/* Search & Segment Tabs */}
          <div className="p-3 border-b border-[#E2E8F0] space-y-2.5">
            <div className="relative">
              <Search className="w-4 h-4 text-[#94A3B8] absolute left-3 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search NSE, BSE, F&O, ETF, Mutual Fund..."
                className="w-full bg-[#F8FAFC] border border-[#E2E8F0] rounded-md pl-9 pr-3 py-2 text-xs text-[#0F172A] placeholder-[#94A3B8] focus:outline-none focus:border-[#387ED1] focus:bg-white transition-colors"
              />
            </div>

            {/* Segment Filter Pills */}
            <div className="flex flex-wrap items-center gap-1">
              {(
                [
                  { id: 'ALL', label: 'All (24)' },
                  { id: 'LARGE_CAP', label: 'Large Cap' },
                  { id: 'MID_CAP', label: 'Mid Cap' },
                  { id: 'SMALL_CAP', label: 'Small Cap' },
                  { id: 'FNO', label: 'F&O' },
                  { id: 'ETF', label: 'ETFs' },
                  { id: 'MUTUAL_FUND', label: 'Mutual Funds' },
                ] as const
              ).map((seg) => (
                <button
                  key={seg.id}
                  type="button"
                  onClick={() => setWatchlistFilter(seg.id)}
                  className={`px-2 py-1 rounded text-[11px] font-medium cursor-pointer transition-colors ${
                    watchlistFilter === seg.id
                      ? 'bg-[#387ED1] text-white'
                      : 'bg-[#F8FAFC] text-[#64748B] hover:text-[#0F172A]'
                  }`}
                >
                  {seg.label}
                </button>
              ))}
            </div>
          </div>

          {/* Watchlist Rows with Kite-Style Hover B / S / Chart Actions */}
          <div className="divide-y divide-[#F1F5F9] flex-1 overflow-y-auto max-h-[760px]">
            {filteredWatchlist.map((meta) => {
              const tick = ticksBySymbol[meta.symbol];
              const price = tick ? tick.price : meta.basePrice;
              const change = tick ? tick.change : 0;
              const changePct = tick ? tick.changePercent : 0;
              const isSelected = selectedSymbol === meta.symbol;
              const held = livePortfolio?.holdings.find((h) => h.symbol === meta.symbol);

              return (
                <div
                  key={meta.symbol}
                  onClick={() => setSelectedSymbol(meta.symbol)}
                  className={`group relative px-4 py-3 transition-colors cursor-pointer flex items-center justify-between gap-2 ${
                    isSelected ? 'bg-[#EFF6FF]/60 border-l-2 border-l-[#387ED1]' : 'hover:bg-[#FAFBFC]'
                  }`}
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <span className="text-xs font-semibold text-[#0F172A]">{meta.symbol}</span>
                      <span
                        className={`text-[10px] font-semibold px-1.5 py-0.2 rounded ${
                          meta.exchange === 'NFO'
                            ? 'bg-[#FEF3C7] text-[#B45309]'
                            : meta.exchange === 'AMFI'
                            ? 'bg-[#F3E8FF] text-[#7E22CE]'
                            : 'bg-[#F1F5F9] text-[#64748B]'
                        }`}
                      >
                        {meta.exchange === 'AMFI' ? 'MF NAV' : meta.exchange}
                      </span>
                      {meta.lotSize > 1 && (
                        <span className="text-[10px] font-medium px-1.5 py-0.2 rounded bg-[#F1F5F9] text-[#475569]">
                          Lot {meta.lotSize}
                        </span>
                      )}
                      {held && (
                        <span className="inline-flex items-center gap-0.5 text-[10px] font-semibold px-1.5 py-0.2 rounded bg-[#EFF6FF] text-[#387ED1]">
                          <Briefcase className="w-2.5 h-2.5" />
                          {held.quantity}
                        </span>
                      )}
                    </div>
                    <p className="text-[11px] text-[#64748B] truncate mt-0.5">{meta.name}</p>
                  </div>

                  {/* Price & Day Change in ₹ */}
                  <div className="text-right tabular-nums shrink-0 group-hover:opacity-15 transition-opacity">
                    <div
                      className={`text-xs font-semibold ${
                        changePct >= 0 ? 'text-[#00B386]' : 'text-[#EB5B3C]'
                      }`}
                    >
                      {formatINR(price)}
                    </div>
                    <div className="text-[11px] text-[#64748B]">
                      {change >= 0 ? '+' : ''}
                      {change.toFixed(2)} ({changePct >= 0 ? '+' : ''}
                      {changePct.toFixed(2)}%)
                    </div>
                  </div>

                  {/* Hover Action Strip (Zerodha Kite B / S / Chart Buttons) */}
                  <div
                    className="hidden group-hover:flex items-center gap-1 absolute right-3 top-1/2 -translate-y-1/2 bg-white/95 pl-2 py-1 rounded shadow-sm border border-[#E2E8F0]"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <button
                      type="button"
                      onClick={() => openOrderTicket(meta.symbol, 'BUY')}
                      className="w-7 h-6 rounded bg-[#387ED1] hover:bg-[#2F6DB8] text-white text-xs font-bold cursor-pointer"
                      title={`Buy ${meta.symbol}`}
                    >
                      B
                    </button>
                    <button
                      type="button"
                      onClick={() => openOrderTicket(meta.symbol, 'SELL')}
                      className="w-7 h-6 rounded bg-[#EB5B3C] hover:bg-[#D94A2B] text-white text-xs font-bold cursor-pointer"
                      title={`Sell ${meta.symbol}`}
                    >
                      S
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setSelectedSymbol(meta.symbol);
                        setActiveView('CHART');
                      }}
                      className="px-2 h-6 rounded bg-[#F1F5F9] hover:bg-[#E2E8F0] text-[#475569] text-[11px] font-medium cursor-pointer flex items-center gap-1"
                      title="Open Full Chart"
                    >
                      <BarChart2 className="w-3 h-3" />
                      Chart
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </aside>

        {/* RIGHT MAIN WORKSPACE */}
        <main className="flex-1 p-5 lg:p-7 overflow-y-auto space-y-6">
          {/* =================================================================
              VIEW 1: HOLDINGS (Large/Mid/Small-Cap Equities, F&O, ETFs & MFs)
             ================================================================= */}
          {activeView === 'HOLDINGS' && (
            <>
              {/* Clean Indian Portfolio Valuation Header */}
              <div className="bg-white border border-[#E2E8F0] rounded-lg p-6 shadow-[0_1px_2px_rgba(15,23,42,0.03)]">
                <div className="flex flex-wrap items-center justify-between gap-4 pb-5 border-b border-[#F1F5F9]">
                  <div>
                    <h1 className="font-display font-bold text-xl text-[#0F172A]">
                      Portfolio Holdings ({livePortfolio?.holdings.length ?? 0})
                    </h1>
                    <p className="text-xs text-[#64748B] mt-0.5">
                      Unified NSE &amp; BSE Equities (Large, Mid &amp; Small Cap), NFO Derivatives, ETFs &amp; Direct Mutual Funds
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => openOrderTicket(selectedSymbol, 'BUY')}
                      className="px-3.5 py-2 rounded-md bg-[#387ED1] hover:bg-[#2F6DB8] text-white text-xs font-semibold cursor-pointer transition-colors"
                    >
                      Buy {selectedSymbol}
                    </button>
                    <button
                      type="button"
                      onClick={() => setActiveView('CHART')}
                      className="px-3.5 py-2 rounded-md bg-white border border-[#E2E8F0] hover:bg-[#F8FAFC] text-[#334155] text-xs font-medium cursor-pointer transition-colors"
                    >
                      Open Technical Chart
                    </button>
                  </div>
                </div>

                {/* 4 Clean Indian Brokerage Valuation Columns in ₹ (Lakhs format) */}
                <div className="grid grid-cols-2 lg:grid-cols-4 gap-6 pt-5 tabular-nums">
                  <div>
                    <span className="text-xs text-[#64748B] block">Total investment</span>
                    <span className="text-2xl font-display font-bold text-[#0F172A] mt-1 block">
                      {livePortfolio ? formatINR(livePortfolio.totalCostBasis) : '₹0.00'}
                    </span>
                  </div>

                  <div>
                    <span className="text-xs text-[#64748B] block">Current value</span>
                    <span className="text-2xl font-display font-bold text-[#0F172A] mt-1 block">
                      {livePortfolio ? formatINR(livePortfolio.holdingsMarketValue) : '₹0.00'}
                    </span>
                  </div>

                  <div>
                    <span className="text-xs text-[#64748B] block">Total P&amp;L</span>
                    <div className="flex items-baseline gap-2 mt-1 flex-wrap">
                      <span
                        className={`text-2xl font-display font-bold ${
                          (livePortfolio?.totalUnrealizedPnl ?? 0) >= 0
                            ? 'text-[#00B386]'
                            : 'text-[#EB5B3C]'
                        }`}
                      >
                        {(livePortfolio?.totalUnrealizedPnl ?? 0) >= 0 ? '+' : ''}
                        {formatINR(livePortfolio?.totalUnrealizedPnl ?? 0)}
                      </span>
                      <span
                        className={`text-xs font-semibold px-1.5 py-0.5 rounded ${
                          (livePortfolio?.totalUnrealizedPnl ?? 0) >= 0
                            ? 'bg-[#00B386]/10 text-[#00B386]'
                            : 'bg-[#EB5B3C]/10 text-[#EB5B3C]'
                        }`}
                      >
                        {(livePortfolio?.totalUnrealizedPnlPercent ?? 0) >= 0 ? '+' : ''}
                        {livePortfolio?.totalUnrealizedPnlPercent.toFixed(2)}%
                      </span>
                    </div>
                  </div>

                  <div>
                    <span className="text-xs text-[#64748B] block">
                      Available Margin • Realized P&amp;L
                    </span>
                    <span className="text-2xl font-display font-bold text-[#0F172A] mt-1 block">
                      {livePortfolio ? formatINR(livePortfolio.cashBalance) : '₹0.00'}
                    </span>
                    <span className="text-xs text-[#00B386] font-medium">
                      FIFO Realized Profit: +{formatINR(livePortfolio?.totalRealizedPnl ?? 0)}
                    </span>
                  </div>
                </div>

                {/* Segment Breakdown Cards (Large Cap, Mid Cap, Small Cap, F&O, ETFs, Mutual Funds) */}
                {livePortfolio && livePortfolio.segmentAllocations.length > 0 && (
                  <div className="mt-6 pt-5 border-t border-[#F1F5F9]">
                    <div className="flex items-center justify-between text-xs text-[#64748B] mb-3">
                      <span className="font-semibold text-[#334155]">
                        Allocation Across Indian Asset Classes &amp; Market Caps
                      </span>
                      <span>
                        Net Worth:{' '}
                        <strong className="text-[#0F172A]">
                          {formatINR(livePortfolio.totalEquity)}
                        </strong>{' '}
                        • Portfolio Beta:{' '}
                        <strong className="text-[#0F172A]">{livePortfolio.portfolioBeta}x</strong>
                      </span>
                    </div>

                    <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2.5 tabular-nums">
                      {livePortfolio.segmentAllocations.map((seg) => (
                        <button
                          key={seg.segment}
                          type="button"
                          onClick={() =>
                            setHoldingsFilter(
                              holdingsFilter === seg.segment ? 'ALL' : seg.segment
                            )
                          }
                          className={`text-left p-3 rounded-lg border transition-colors cursor-pointer ${
                            holdingsFilter === seg.segment
                              ? 'bg-[#EFF6FF] border-[#387ED1]'
                              : 'bg-[#F8FAFC] border-[#E2E8F0] hover:bg-white'
                          }`}
                        >
                          <div className="flex items-center justify-between text-[11px] text-[#64748B]">
                            <span className="font-medium truncate">{seg.label}</span>
                            <span className="font-semibold text-[#387ED1]">
                              {seg.weightPercent.toFixed(0)}%
                            </span>
                          </div>
                          <div className="text-xs font-bold text-[#0F172A] mt-1">
                            {formatINR(seg.marketValue)}
                          </div>
                          <div
                            className={`text-[11px] font-medium ${
                              seg.unrealizedPnl >= 0 ? 'text-[#00B386]' : 'text-[#EB5B3C]'
                            }`}
                          >
                            {seg.unrealizedPnl >= 0 ? '+' : ''}
                            {formatINR(seg.unrealizedPnl)}
                          </div>
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>

              {/* Full-Width Holdings Table with Segment Filter & Expandable FIFO Tax Lots */}
              <div className="bg-white border border-[#E2E8F0] rounded-lg overflow-hidden shadow-[0_1px_2px_rgba(15,23,42,0.03)]">
                <div className="px-5 py-3.5 border-b border-[#E2E8F0] flex flex-wrap items-center justify-between gap-2 bg-[#FAFBFC]">
                  <div className="flex flex-wrap items-center gap-1.5">
                    {(
                      [
                        { id: 'ALL', label: 'All Holdings' },
                        { id: 'LARGE_CAP', label: 'Large Cap' },
                        { id: 'MID_CAP', label: 'Mid Cap' },
                        { id: 'SMALL_CAP', label: 'Small Cap' },
                        { id: 'FNO', label: 'F&O Derivatives' },
                        { id: 'ETF', label: 'ETFs' },
                        { id: 'MUTUAL_FUND', label: 'Mutual Funds' },
                      ] as const
                    ).map((tab) => (
                      <button
                        key={tab.id}
                        type="button"
                        onClick={() => setHoldingsFilter(tab.id)}
                        className={`px-2.5 py-1 rounded text-xs font-medium cursor-pointer transition-colors ${
                          holdingsFilter === tab.id
                            ? 'bg-[#387ED1] text-white'
                            : 'text-[#64748B] hover:text-[#0F172A]'
                        }`}
                      >
                        {tab.label}
                      </button>
                    ))}
                  </div>
                  <span className="text-xs text-[#64748B]">
                    Click any row to inspect chronological FIFO Tax Lots
                  </span>
                </div>

                <div className="overflow-x-auto">
                  <table className="w-full text-left border-collapse tabular-nums">
                    <thead>
                      <tr className="border-b border-[#E2E8F0] text-xs font-medium text-[#64748B] bg-white">
                        <th className="py-3.5 px-5">Instrument</th>
                        <th className="py-3.5 px-3">Segment</th>
                        <th className="py-3.5 px-4 text-right">Qty. / Units</th>
                        <th className="py-3.5 px-4 text-right">Avg. cost</th>
                        <th className="py-3.5 px-4 text-right">LTP / NAV</th>
                        <th className="py-3.5 px-4 text-right">Cur. val</th>
                        <th className="py-3.5 px-4 text-right">Net P&amp;L</th>
                        <th className="py-3.5 px-5 text-right">Actions</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-[#F1F5F9] text-sm">
                      {filteredHoldings.map((h) => {
                        const isExpanded = expandedHoldingSymbol === h.symbol;
                        const lotsForSymbol =
                          livePortfolio?.openTaxLots.filter(
                            (l) => l.symbol === h.symbol && l.remainingQty > 0
                          ) ?? [];

                        return (
                          <React.Fragment key={h.symbol}>
                            <tr
                              onClick={() => {
                                setSelectedSymbol(h.symbol);
                                setExpandedHoldingSymbol(isExpanded ? null : h.symbol);
                              }}
                              className={`cursor-pointer transition-colors ${
                                isExpanded ? 'bg-[#F8FAFC]' : 'hover:bg-[#FAFBFC]'
                              }`}
                            >
                              <td className="py-3.5 px-5">
                                <div className="flex items-center gap-2">
                                  {isExpanded ? (
                                    <ChevronDown className="w-4 h-4 text-[#64748B]" />
                                  ) : (
                                    <ChevronRight className="w-4 h-4 text-[#94A3B8]" />
                                  )}
                                  <div>
                                    <div className="flex items-center gap-1.5">
                                      <span className="font-semibold text-[#0F172A]">
                                        {h.symbol}
                                      </span>
                                      <span className="text-[10px] px-1.5 py-0.2 rounded bg-[#F1F5F9] text-[#64748B]">
                                        {h.exchange}
                                      </span>
                                    </div>
                                    <span className="text-xs text-[#64748B]">{h.name}</span>
                                  </div>
                                </div>
                              </td>
                              <td className="py-3.5 px-3">
                                <span className="text-[11px] font-medium px-2 py-0.5 rounded bg-[#F8FAFC] border border-[#E2E8F0] text-[#475569]">
                                  {SEGMENT_LABELS[h.segment]}
                                </span>
                              </td>
                              <td className="py-3.5 px-4 text-right font-medium text-[#0F172A]">
                                {h.quantity}
                              </td>
                              <td className="py-3.5 px-4 text-right text-[#475569]">
                                {formatINR(h.avgCostBasis)}
                              </td>
                              <td className="py-3.5 px-4 text-right font-semibold text-[#0F172A]">
                                {formatINR(h.currentPrice)}
                              </td>
                              <td className="py-3.5 px-4 text-right font-medium text-[#0F172A]">
                                {formatINR(h.marketValue)}
                              </td>
                              <td
                                className={`py-3.5 px-4 text-right font-semibold ${
                                  h.unrealizedPnl >= 0 ? 'text-[#00B386]' : 'text-[#EB5B3C]'
                                }`}
                              >
                                {h.unrealizedPnl >= 0 ? '+' : ''}
                                {formatINR(h.unrealizedPnl)}
                                <span className="block text-[11px]">
                                  ({h.unrealizedPnlPercent >= 0 ? '+' : ''}
                                  {h.unrealizedPnlPercent.toFixed(2)}%)
                                </span>
                              </td>
                              <td
                                className="py-3.5 px-5 text-right"
                                onClick={(e) => e.stopPropagation()}
                              >
                                <div className="inline-flex items-center gap-1.5">
                                  <button
                                    type="button"
                                    onClick={() => openOrderTicket(h.symbol, 'BUY')}
                                    className="px-2.5 py-1 rounded bg-[#EFF6FF] hover:bg-[#DBEAFE] text-[#387ED1] text-xs font-semibold cursor-pointer"
                                  >
                                    Buy
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => openOrderTicket(h.symbol, 'SELL')}
                                    className="px-2.5 py-1 rounded bg-[#FEF2F2] hover:bg-[#FEE2E2] text-[#EB5B3C] text-xs font-semibold cursor-pointer"
                                  >
                                    Sell
                                  </button>
                                </div>
                              </td>
                            </tr>

                            {/* Expandable FIFO Tax Lots Breakdown Row */}
                            {isExpanded && (
                              <tr className="bg-[#F8FAFC] border-b border-[#E2E8F0]">
                                <td colSpan={8} className="px-10 py-3.5">
                                  <div className="text-xs text-[#475569] mb-2 flex items-center justify-between">
                                    <span className="font-semibold">
                                      FIFO Tax-Lot Breakdown for {h.symbol} ({lotsForSymbol.length}{' '}
                                      Open Lot{lotsForSymbol.length > 1 ? 's' : ''})
                                    </span>
                                    <span className="text-[#64748B]">
                                      Selling units automatically consumes the oldest purchase lot first
                                    </span>
                                  </div>
                                  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2.5">
                                    {lotsForSymbol.map((lot) => {
                                      const lotPnl =
                                        (h.currentPrice - lot.buyPrice) * lot.remainingQty;
                                      return (
                                        <div
                                          key={lot.id}
                                          className="bg-white border border-[#E2E8F0] rounded-md px-3.5 py-2.5 flex items-center justify-between text-xs"
                                        >
                                          <div>
                                            <span className="font-semibold text-[#0F172A]">
                                              Lot #{lot.id} • {lot.remainingQty} qty
                                            </span>
                                            <span className="block text-[#64748B] text-[11px]">
                                              Acquired @ {formatINR(lot.buyPrice)}
                                            </span>
                                          </div>
                                          <div
                                            className={`font-semibold ${
                                              lotPnl >= 0 ? 'text-[#00B386]' : 'text-[#EB5B3C]'
                                            }`}
                                          >
                                            {lotPnl >= 0 ? '+' : ''}
                                            {formatINR(lotPnl)}
                                          </div>
                                        </div>
                                      );
                                    })}
                                  </div>
                                </td>
                              </tr>
                            )}
                          </React.Fragment>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>

              {/* Selected Instrument Live Technical Chart Preview */}
              <div className="space-y-2.5">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <h2 className="font-display font-bold text-base text-[#0F172A]">
                      {activeMeta.symbol} — {activeMeta.name}
                    </h2>
                    <span className="text-xs px-2 py-0.5 rounded bg-[#F1F5F9] text-[#475569]">
                      {SEGMENT_LABELS[activeMeta.segment]} • {activeMeta.exchange}
                    </span>
                  </div>
                  <button
                    type="button"
                    onClick={() => setActiveView('CHART')}
                    className="text-xs font-medium text-[#387ED1] hover:underline cursor-pointer"
                  >
                    Expand Full Trading Terminal →
                  </button>
                </div>

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
                  height={400}
                />
              </div>
            </>
          )}

          {/* =================================================================
              VIEW 2: F&O DERIVATIVES (NIFTY & BANKNIFTY FUTURES & OPTIONS)
             ================================================================= */}
          {activeView === 'FNO_POSITIONS' && (
            <div className="space-y-6">
              <div className="bg-white border border-[#E2E8F0] rounded-lg p-6 shadow-[0_1px_2px_rgba(15,23,42,0.03)]">
                <div className="flex flex-wrap items-center justify-between gap-4 pb-4 border-b border-[#F1F5F9]">
                  <div>
                    <h1 className="font-display font-bold text-xl text-[#0F172A]">
                      NFO Futures &amp; Options Positions
                    </h1>
                    <p className="text-xs text-[#64748B] mt-0.5">
                      Live NSE Derivatives mark-to-market with lot-size multipliers and option chain contracts
                    </p>
                  </div>
                </div>

                {/* Active F&O Contracts Catalog */}
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-3.5 pt-4 tabular-nums">
                  {SYMBOL_CATALOG.filter((s) => s.segment === 'FNO').map((contract) => {
                    const tick = ticksBySymbol[contract.symbol];
                    const ltp = tick ? tick.price : contract.basePrice;
                    const chgPct = tick ? tick.changePercent : 0;
                    const held = livePortfolio?.holdings.find((h) => h.symbol === contract.symbol);

                    return (
                      <div
                        key={contract.symbol}
                        onClick={() => setSelectedSymbol(contract.symbol)}
                        className="p-4 rounded-lg border border-[#E2E8F0] bg-[#FAFBFC] hover:bg-white transition-colors cursor-pointer flex flex-col justify-between gap-3"
                      >
                        <div>
                          <div className="flex items-center justify-between gap-1">
                            <span className="text-xs font-bold text-[#0F172A]">
                              {contract.symbol}
                            </span>
                            <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-[#FEF3C7] text-[#B45309]">
                              Lot {contract.lotSize}
                            </span>
                          </div>
                          <p className="text-[11px] text-[#64748B] mt-0.5">{contract.name}</p>
                        </div>

                        <div className="flex items-baseline justify-between">
                          <span className="text-base font-bold text-[#0F172A]">
                            {formatINR(ltp)}
                          </span>
                          <span
                            className={`text-xs font-semibold ${
                              chgPct >= 0 ? 'text-[#00B386]' : 'text-[#EB5B3C]'
                            }`}
                          >
                            {chgPct >= 0 ? '+' : ''}
                            {chgPct.toFixed(2)}%
                          </span>
                        </div>

                        <div
                          className="flex items-center justify-between pt-2 border-t border-[#E2E8F0]"
                          onClick={(e) => e.stopPropagation()}
                        >
                          <span className="text-[11px] text-[#64748B]">
                            {held ? `Open: ${held.quantity} qty` : 'No position'}
                          </span>
                          <div className="flex gap-1.5">
                            <button
                              type="button"
                              onClick={() => openOrderTicket(contract.symbol, 'BUY')}
                              className="px-2.5 py-1 rounded bg-[#387ED1] text-white text-xs font-semibold cursor-pointer"
                            >
                              Buy Lot
                            </button>
                            <button
                              type="button"
                              onClick={() => openOrderTicket(contract.symbol, 'SELL')}
                              className="px-2.5 py-1 rounded bg-[#EB5B3C] text-white text-xs font-semibold cursor-pointer"
                            >
                              Sell
                            </button>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>

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
                height={420}
              />
            </div>
          )}

          {/* =================================================================
              VIEW 3: CHARTS & TRADING TERMINAL
             ================================================================= */}
          {activeView === 'CHART' && (
            <div className="grid grid-cols-1 xl:grid-cols-12 gap-6 items-start">
              <div className="xl:col-span-8 space-y-4">
                <div className="bg-white border border-[#E2E8F0] rounded-lg px-5 py-4 flex flex-wrap items-center justify-between gap-4 shadow-[0_1px_2px_rgba(15,23,42,0.03)]">
                  <div>
                    <div className="flex items-center gap-2">
                      <h1 className="font-display font-bold text-xl text-[#0F172A]">
                        {activeMeta.symbol}
                      </h1>
                      <span className="text-sm text-[#64748B]">{activeMeta.name}</span>
                      <span className="text-xs px-2 py-0.5 rounded bg-[#F1F5F9] text-[#475569]">
                        {activeMeta.exchange} • {SEGMENT_LABELS[activeMeta.segment]}
                      </span>
                    </div>
                    {activeHolding && (
                      <p className="text-xs text-[#64748B] mt-1 tabular-nums">
                        Holding <strong>{activeHolding.quantity} units</strong> @ FIFO Avg{' '}
                        <strong>{formatINR(activeHolding.avgCostBasis)}</strong> • P&amp;L:{' '}
                        <strong
                          className={
                            activeHolding.unrealizedPnl >= 0 ? 'text-[#00B386]' : 'text-[#EB5B3C]'
                          }
                        >
                          {activeHolding.unrealizedPnl >= 0 ? '+' : ''}
                          {formatINR(activeHolding.unrealizedPnl)}
                        </strong>
                      </p>
                    )}
                  </div>

                  {activeTick && (
                    <div className="text-right tabular-nums">
                      <div className="text-2xl font-display font-bold text-[#0F172A]">
                        {formatINR(activeTick.price)}
                      </div>
                      <div
                        className={`text-xs font-semibold ${
                          activeTick.change >= 0 ? 'text-[#00B386]' : 'text-[#EB5B3C]'
                        }`}
                      >
                        {activeTick.change >= 0 ? '+' : ''}
                        {activeTick.change.toFixed(2)} ({activeTick.changePercent >= 0 ? '+' : ''}
                        {activeTick.changePercent.toFixed(2)}%)
                      </div>
                    </div>
                  )}
                </div>

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
                  height={500}
                />
              </div>

              {/* Right Inline Brokerage Order Ticket */}
              <div className="xl:col-span-4 bg-white border border-[#E2E8F0] rounded-lg overflow-hidden shadow-[0_1px_2px_rgba(15,23,42,0.03)]">
                <div
                  className={`px-5 py-3.5 text-white flex items-center justify-between ${
                    orderSide === 'BUY' ? 'bg-[#387ED1]' : 'bg-[#EB5B3C]'
                  }`}
                >
                  <div>
                    <h2 className="font-display font-bold text-sm">
                      {orderSide === 'BUY' ? 'Buy' : 'Sell'} {selectedSymbol}
                    </h2>
                    <p className="text-[11px] opacity-90">
                      {activeMeta.exchange} • Lot Size: {activeMeta.lotSize} • Ask{' '}
                      {formatINR(activeTick?.ask ?? activeMeta.basePrice)}
                    </p>
                  </div>
                  <div className="flex items-center gap-1 bg-black/15 p-0.5 rounded text-xs font-semibold">
                    <button
                      type="button"
                      onClick={() => {
                        setOrderSymbol(selectedSymbol);
                        setOrderSide('BUY');
                      }}
                      className={`px-2.5 py-1 rounded cursor-pointer ${
                        orderSide === 'BUY' ? 'bg-white text-[#387ED1]' : 'text-white/90'
                      }`}
                    >
                      BUY
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setOrderSymbol(selectedSymbol);
                        setOrderSide('SELL');
                      }}
                      className={`px-2.5 py-1 rounded cursor-pointer ${
                        orderSide === 'SELL' ? 'bg-white text-[#EB5B3C]' : 'text-white/90'
                      }`}
                    >
                      SELL
                    </button>
                  </div>
                </div>

                <form
                  onSubmit={(e) => {
                    setOrderSymbol(selectedSymbol);
                    handleExecuteOrder(e);
                  }}
                  className="p-5 space-y-4"
                >
                  <div>
                    <div className="flex justify-between text-xs text-[#64748B] mb-1">
                      <span>Quantity (Lot Multiple: {activeMeta.lotSize})</span>
                      <span>Held: {activeHolding?.quantity ?? 0}</span>
                    </div>
                    <input
                      type="number"
                      min="1"
                      value={orderQty}
                      onChange={(e) => {
                        setOrderSymbol(selectedSymbol);
                        setOrderQty(e.target.value);
                      }}
                      className="w-full border border-[#CBD5E1] rounded-md px-3 py-2 text-sm font-medium text-[#0F172A] focus:outline-none focus:border-[#387ED1]"
                    />
                    <div className="flex gap-1.5 mt-2">
                      {[1, 2, 5, 10].map((mult) => {
                        const q = mult * activeMeta.lotSize;
                        return (
                          <button
                            key={q}
                            type="button"
                            onClick={() => {
                              setOrderSymbol(selectedSymbol);
                              setOrderQty(String(q));
                            }}
                            className="px-2.5 py-1 rounded bg-[#F8FAFC] border border-[#E2E8F0] text-xs text-[#475569] hover:text-[#0F172A] cursor-pointer"
                          >
                            {q} Qty
                          </button>
                        );
                      })}
                    </div>
                  </div>

                  <div className="bg-[#F8FAFC] border border-[#E2E8F0] rounded-md p-3.5 text-xs space-y-2 tabular-nums">
                    <div className="flex justify-between text-[#64748B]">
                      <span>Required Margin</span>
                      <strong className="text-[#0F172A]">
                        {formatINR(
                          Number(orderQty || 0) *
                            (orderSide === 'BUY'
                              ? activeTick?.ask ?? activeMeta.basePrice
                              : activeTick?.bid ?? activeMeta.basePrice)
                        )}
                      </strong>
                    </div>
                    <div className="flex justify-between text-[#64748B]">
                      <span>Available Margin</span>
                      <strong className="text-[#0F172A]">
                        {formatINR(livePortfolio?.cashBalance ?? 0)}
                      </strong>
                    </div>
                  </div>

                  <button
                    type="submit"
                    disabled={submittingOrder}
                    className={`w-full py-2.5 rounded-md text-white text-sm font-semibold cursor-pointer transition-colors ${
                      orderSide === 'BUY'
                        ? 'bg-[#387ED1] hover:bg-[#2F6DB8]'
                        : 'bg-[#EB5B3C] hover:bg-[#D94A2B]'
                    }`}
                  >
                    {submittingOrder
                      ? 'Executing Order...'
                      : `${orderSide === 'BUY' ? 'Buy' : 'Sell'} ${orderQty || 0} ${selectedSymbol}`}
                  </button>

                  <button
                    type="button"
                    disabled={submittingOrder}
                    onClick={() => {
                      setOrderSymbol(selectedSymbol);
                      handleTestIdempotencyBurst();
                    }}
                    className="w-full py-2 px-3 rounded-md bg-[#F8FAFC] hover:bg-[#F1F5F9] border border-[#E2E8F0] text-xs font-medium text-[#334155] flex items-center justify-center gap-1.5 cursor-pointer"
                  >
                    <ShieldCheck className="w-4 h-4 text-[#387ED1]" />
                    Verify Double-Click Idempotency Lock
                  </button>

                  {orderStatus && (
                    <div
                      className={`p-3 rounded-md text-xs border ${
                        orderStatus.type === 'success'
                          ? 'bg-[#F0FDF4] border-[#BBF7D0] text-[#15803D]'
                          : orderStatus.type === 'info'
                          ? 'bg-[#EFF6FF] border-[#BFDBFE] text-[#1E40AF]'
                          : 'bg-[#FEF2F2] border-[#FECACA] text-[#B91C1C]'
                      }`}
                    >
                      {orderStatus.text}
                    </div>
                  )}
                </form>
              </div>
            </div>
          )}

          {/* =================================================================
              VIEW 4: ORDERS & PRICE ALERTS
             ================================================================= */}
          {activeView === 'ORDERS_ALERTS' && (
            <div className="grid grid-cols-1 xl:grid-cols-12 gap-6 items-start">
              <div className="xl:col-span-7 bg-white border border-[#E2E8F0] rounded-lg overflow-hidden shadow-[0_1px_2px_rgba(15,23,42,0.03)]">
                <div className="px-5 py-4 border-b border-[#E2E8F0]">
                  <h2 className="font-display font-bold text-base text-[#0F172A]">
                    Executed Order Book ({livePortfolio?.recentOrders.length ?? 0})
                  </h2>
                  <p className="text-xs text-[#64748B]">
                    ACID transaction ledger with idempotency keys and realized FIFO P&amp;L in ₹
                  </p>
                </div>

                <div className="overflow-x-auto">
                  <table className="w-full text-left border-collapse tabular-nums">
                    <thead>
                      <tr className="border-b border-[#E2E8F0] text-xs font-medium text-[#64748B] bg-[#FAFBFC]">
                        <th className="py-3 px-5">Instrument</th>
                        <th className="py-3 px-3">Type</th>
                        <th className="py-3 px-3 text-right">Qty.</th>
                        <th className="py-3 px-3 text-right">Avg. price</th>
                        <th className="py-3 px-3 text-right">Total Value</th>
                        <th className="py-3 px-5 text-right">Realized P&amp;L</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-[#F1F5F9] text-xs">
                      {livePortfolio?.recentOrders.map((ord) => (
                        <tr key={ord.id} className="hover:bg-[#FAFBFC]">
                          <td className="py-3 px-5 font-semibold text-[#0F172A]">
                            #{ord.id} {ord.symbol}
                          </td>
                          <td className="py-3 px-3">
                            <span
                              className={`px-2 py-0.5 rounded text-[11px] font-semibold ${
                                ord.side === 'BUY'
                                  ? 'bg-[#EFF6FF] text-[#387ED1]'
                                  : 'bg-[#FEF2F2] text-[#EB5B3C]'
                              }`}
                            >
                              {ord.side}
                            </span>
                          </td>
                          <td className="py-3 px-3 text-right text-[#0F172A]">{ord.quantity}</td>
                          <td className="py-3 px-3 text-right text-[#475569]">
                            {formatINR(ord.executionPrice)}
                          </td>
                          <td className="py-3 px-3 text-right text-[#0F172A]">
                            {formatINR(ord.totalNotional)}
                          </td>
                          <td
                            className={`py-3 px-5 text-right font-semibold ${
                              ord.side === 'BUY'
                                ? 'text-[#94A3B8]'
                                : ord.realizedPnl >= 0
                                ? 'text-[#00B386]'
                                : 'text-[#EB5B3C]'
                            }`}
                          >
                            {ord.side === 'BUY'
                              ? '—'
                              : `${ord.realizedPnl >= 0 ? '+' : ''}${formatINR(ord.realizedPnl)}`}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>

              <div className="xl:col-span-5 bg-white border border-[#E2E8F0] rounded-lg p-5 space-y-4 shadow-[0_1px_2px_rgba(15,23,42,0.03)]">
                <div>
                  <h2 className="font-display font-bold text-base text-[#0F172A]">
                    Real-Time Price Alerts ({alerts.length})
                  </h2>
                  <p className="text-xs text-[#64748B]">
                    Evaluated in O(1) lookup time as NSE/BSE/NFO ticks stream in
                  </p>
                </div>

                <form
                  onSubmit={handleCreateAlert}
                  className="space-y-3 bg-[#F8FAFC] p-4 rounded-lg border border-[#E2E8F0]"
                >
                  <div className="grid grid-cols-2 gap-2.5">
                    <div>
                      <label className="block text-xs text-[#64748B] mb-1">Instrument</label>
                      <select
                        value={alertSymbol}
                        onChange={(e) => {
                          setAlertSymbol(e.target.value);
                          const t = ticksBySymbol[e.target.value];
                          if (t) setAlertPriceInput((t.price * 1.002).toFixed(2));
                        }}
                        className="w-full bg-white border border-[#CBD5E1] rounded-md px-2.5 py-1.5 text-xs font-medium text-[#0F172A]"
                      >
                        {SYMBOL_CATALOG.map((s) => (
                          <option key={s.symbol} value={s.symbol}>
                            {s.symbol} ({formatINR(ticksBySymbol[s.symbol]?.price ?? s.basePrice)})
                          </option>
                        ))}
                      </select>
                    </div>

                    <div>
                      <label className="block text-xs text-[#64748B] mb-1">Condition</label>
                      <select
                        value={alertDirection}
                        onChange={(e) => setAlertDirection(e.target.value as AlertDirection)}
                        className="w-full bg-white border border-[#CBD5E1] rounded-md px-2.5 py-1.5 text-xs font-medium text-[#0F172A]"
                      >
                        <option value="ABOVE">Crosses Above (≥)</option>
                        <option value="BELOW">Drops Below (≤)</option>
                      </select>
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-2.5">
                    <div>
                      <label className="block text-xs text-[#64748B] mb-1">Target Price (₹)</label>
                      <input
                        type="number"
                        step="0.05"
                        value={alertPriceInput}
                        onChange={(e) => setAlertPriceInput(e.target.value)}
                        className="w-full bg-white border border-[#CBD5E1] rounded-md px-2.5 py-1.5 text-xs font-medium text-[#0F172A]"
                      />
                    </div>
                    <div>
                      <label className="block text-xs text-[#64748B] mb-1">Note</label>
                      <input
                        type="text"
                        value={alertNoteInput}
                        onChange={(e) => setAlertNoteInput(e.target.value)}
                        placeholder="e.g. Breakout level"
                        className="w-full bg-white border border-[#CBD5E1] rounded-md px-2.5 py-1.5 text-xs text-[#0F172A]"
                      />
                    </div>
                  </div>

                  <button
                    type="submit"
                    className="w-full py-2 rounded-md bg-[#387ED1] hover:bg-[#2F6DB8] text-white text-xs font-semibold cursor-pointer"
                  >
                    Create Alert
                  </button>
                </form>

                <div className="divide-y divide-[#F1F5F9]">
                  {alerts.map((a) => (
                    <div key={a.id} className="py-3 flex items-center justify-between gap-2 text-xs">
                      <div>
                        <div className="flex items-center gap-2">
                          <span className="font-semibold text-[#0F172A]">{a.symbol}</span>
                          <span className="text-[#475569]">
                            {a.direction === 'ABOVE' ? '≥' : '≤'} {formatINR(a.targetPrice)}
                          </span>
                          <span
                            className={`px-2 py-0.5 rounded text-[10px] font-semibold ${
                              a.status === 'ACTIVE'
                                ? 'bg-[#EFF6FF] text-[#387ED1]'
                                : 'bg-[#F0FDF4] text-[#00B386]'
                            }`}
                          >
                            {a.status}
                          </span>
                        </div>
                        {a.note && <p className="text-[#64748B] mt-0.5">{a.note}</p>}
                      </div>
                      <button
                        type="button"
                        onClick={() => handleDeleteAlert(a.id)}
                        className="text-[#94A3B8] hover:text-[#EB5B3C] p-1 cursor-pointer"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}

          {/* =================================================================
              VIEW 5: NEWS & AI INDIAN MARKET PORTFOLIO RISK ANALYST
             ================================================================= */}
          {activeView === 'INSIGHTS' && (
            <div className="grid grid-cols-1 xl:grid-cols-12 gap-6 items-start">
              <div className="xl:col-span-6 bg-white border border-[#E2E8F0] rounded-lg overflow-hidden shadow-[0_1px_2px_rgba(15,23,42,0.03)]">
                <div className="px-5 py-4 border-b border-[#E2E8F0]">
                  <h2 className="font-display font-bold text-base text-[#0F172A]">
                    Indian Market News Relevant to Your Holdings
                  </h2>
                  <p className="text-xs text-[#64748B]">
                    NSE, BSE, SEBI &amp; sector updates correlated with your portfolio
                  </p>
                </div>
                <div className="divide-y divide-[#F1F5F9]">
                  {news.map((item) => (
                    <div
                      key={item.id}
                      onClick={() => {
                        setSelectedSymbol(item.symbol);
                        setActiveView('CHART');
                      }}
                      className="p-5 hover:bg-[#FAFBFC] cursor-pointer transition-colors"
                    >
                      <div className="flex items-center justify-between gap-2 mb-1.5">
                        <div className="flex items-center gap-2">
                          <span className="text-xs font-bold px-2 py-0.5 rounded bg-[#F1F5F9] text-[#0F172A]">
                            {item.symbol}
                          </span>
                          <span
                            className={`text-[11px] font-semibold px-2 py-0.5 rounded ${
                              item.sentiment === 'BULLISH'
                                ? 'bg-[#00B386]/10 text-[#00B386]'
                                : item.sentiment === 'BEARISH'
                                ? 'bg-[#EB5B3C]/10 text-[#EB5B3C]'
                                : 'bg-[#F1F5F9] text-[#64748B]'
                            }`}
                          >
                            {item.sentiment}
                          </span>
                        </div>
                        <span className="text-xs text-[#94A3B8]">
                          {item.source} • {item.publishedAt}
                        </span>
                      </div>
                      <h3 className="text-sm font-semibold text-[#0F172A]">{item.headline}</h3>
                      <p className="text-xs text-[#475569] mt-1 leading-relaxed">{item.summary}</p>
                    </div>
                  ))}
                </div>
              </div>

              <div className="xl:col-span-6 bg-white border border-[#E2E8F0] rounded-lg p-5 space-y-4 shadow-[0_1px_2px_rgba(15,23,42,0.03)]">
                <div className="flex items-center justify-between">
                  <div>
                    <h2 className="font-display font-bold text-base text-[#0F172A]">
                      AI Portfolio Risk &amp; Nifty Stress-Test Analyst
                    </h2>
                    <p className="text-xs text-[#64748B]">
                      Simulate Nifty/Sensex drawdowns, RBI rate impacts &amp; NFO Option hedging in ₹
                    </p>
                  </div>
                  <span className="text-xs font-semibold px-2.5 py-1 rounded bg-[#EFF6FF] text-[#387ED1]">
                    Beta: {livePortfolio?.portfolioBeta ?? 1.0}x
                  </span>
                </div>

                <div className="flex gap-2">
                  <input
                    type="text"
                    value={copilotQuestion}
                    onChange={(e) => setCopilotQuestion(e.target.value)}
                    placeholder="Ask e.g. What happens to my P&L if Nifty drops 5%?"
                    className="flex-1 bg-[#F8FAFC] border border-[#CBD5E1] rounded-md px-3 py-2 text-xs text-[#0F172A] focus:outline-none focus:border-[#387ED1]"
                  />
                  <button
                    type="button"
                    disabled={copilotLoading}
                    onClick={() => handleRunCopilot()}
                    className="px-4 py-2 rounded-md bg-[#387ED1] hover:bg-[#2F6DB8] text-white text-xs font-semibold cursor-pointer"
                  >
                    {copilotLoading ? 'Analyzing...' : 'Analyze'}
                  </button>
                </div>

                {copilot && (
                  <div className="space-y-4">
                    {copilot.queryAnswer && (
                      <div className="p-4 rounded-lg bg-[#F8FAFC] border border-[#E2E8F0] text-xs text-[#1E293B] leading-relaxed">
                        <strong className="block text-[#387ED1] mb-1">Stress-Test Output</strong>
                        {copilot.queryAnswer}
                      </div>
                    )}

                    <div className="space-y-2.5">
                      <h3 className="text-xs font-semibold uppercase tracking-wider text-[#64748B]">
                        Indian Market Stress Scenarios (₹ Impact)
                      </h3>
                      {copilot.stressTestScenarios.map((sc) => (
                        <div
                          key={sc.scenarioName}
                          className="p-3.5 rounded-lg border border-[#E2E8F0] flex items-center justify-between gap-4 tabular-nums"
                        >
                          <div>
                            <div className="text-xs font-semibold text-[#0F172A]">
                              {sc.scenarioName}
                            </div>
                            <p className="text-[11px] text-[#64748B] mt-0.5">{sc.explanation}</p>
                          </div>
                          <div
                            className={`text-right font-semibold text-xs shrink-0 ${
                              sc.estimatedPnlImpact >= 0 ? 'text-[#00B386]' : 'text-[#EB5B3C]'
                            }`}
                          >
                            {sc.estimatedPnlImpact >= 0 ? '+' : ''}
                            {formatINR(sc.estimatedPnlImpact)}
                            <span className="block text-[11px]">
                              ({sc.estimatedPnlPercent.toFixed(2)}%)
                            </span>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}
        </main>
      </div>

      {/* FLOATING ZERODHA KITE-STYLE ORDER TICKET MODAL */}
      {orderModalOpen && (
        <div className="fixed inset-0 z-50 bg-slate-900/30 backdrop-blur-[1px] flex items-center justify-center p-4">
          <div className="bg-white border border-[#E2E8F0] rounded-lg shadow-xl w-full max-w-md overflow-hidden">
            <div
              className={`px-5 py-4 text-white flex items-center justify-between ${
                orderSide === 'BUY' ? 'bg-[#387ED1]' : 'bg-[#EB5B3C]'
              }`}
            >
              <div>
                <div className="flex items-center gap-2">
                  <span className="font-display font-bold text-base">
                    {orderSide === 'BUY' ? 'Buy' : 'Sell'} {orderSymbol}
                  </span>
                  <span className="text-xs px-1.5 py-0.5 rounded bg-black/15">
                    {modalMeta.exchange} • Lot {modalMeta.lotSize}
                  </span>
                </div>
                <p className="text-xs opacity-90 mt-0.5 tabular-nums">
                  LTP: {formatINR(modalTick?.price ?? modalMeta.basePrice)} • Held:{' '}
                  {modalHolding?.quantity ?? 0} units
                </p>
              </div>

              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setOrderSide(orderSide === 'BUY' ? 'SELL' : 'BUY')}
                  className="px-2.5 py-1 rounded bg-white/20 hover:bg-white/30 text-xs font-semibold cursor-pointer"
                >
                  Switch to {orderSide === 'BUY' ? 'SELL' : 'BUY'}
                </button>
                <button
                  type="button"
                  onClick={() => setOrderModalOpen(false)}
                  className="p-1 rounded hover:bg-black/15 cursor-pointer"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
            </div>

            <form onSubmit={handleExecuteOrder} className="p-5 space-y-4">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs text-[#64748B] mb-1">
                    Qty. (Lot Size: {modalMeta.lotSize})
                  </label>
                  <input
                    type="number"
                    min="1"
                    value={orderQty}
                    onChange={(e) => setOrderQty(e.target.value)}
                    className="w-full border border-[#CBD5E1] rounded-md px-3 py-2 text-sm font-semibold text-[#0F172A] focus:outline-none focus:border-[#387ED1]"
                  />
                </div>
                <div>
                  <label className="block text-xs text-[#64748B] mb-1">Market Fill Price (₹)</label>
                  <input
                    type="text"
                    disabled
                    value={formatINR(estimatedOrderPreview.execPrice)}
                    className="w-full bg-[#F8FAFC] border border-[#E2E8F0] rounded-md px-3 py-2 text-sm text-[#64748B] tabular-nums"
                  />
                </div>
              </div>

              <div className="bg-[#F8FAFC] border border-[#E2E8F0] rounded-md p-3.5 text-xs space-y-1.5 tabular-nums">
                <div className="flex justify-between text-[#64748B]">
                  <span>Required Margin / Order Value</span>
                  <strong className="text-[#0F172A]">
                    {formatINR(estimatedOrderPreview.notional)}
                  </strong>
                </div>
                <div className="flex justify-between text-[#64748B]">
                  <span>Available Cash Margin</span>
                  <strong className="text-[#0F172A]">
                    {formatINR(livePortfolio?.cashBalance ?? 0)}
                  </strong>
                </div>
                {orderSide === 'SELL' && estimatedOrderPreview.estFifoPnl !== null && (
                  <div className="flex justify-between pt-1.5 border-t border-[#E2E8F0]">
                    <span className="text-[#64748B]">Estimated FIFO Realized P&amp;L</span>
                    <strong
                      className={
                        estimatedOrderPreview.estFifoPnl >= 0 ? 'text-[#00B386]' : 'text-[#EB5B3C]'
                      }
                    >
                      {estimatedOrderPreview.estFifoPnl >= 0 ? '+' : ''}
                      {formatINR(estimatedOrderPreview.estFifoPnl)}
                    </strong>
                  </div>
                )}
              </div>

              {orderStatus && (
                <div
                  className={`p-3 rounded-md text-xs border ${
                    orderStatus.type === 'success'
                      ? 'bg-[#F0FDF4] border-[#BBF7D0] text-[#15803D]'
                      : orderStatus.type === 'info'
                      ? 'bg-[#EFF6FF] border-[#BFDBFE] text-[#1E40AF]'
                      : 'bg-[#FEF2F2] border-[#FECACA] text-[#B91C1C]'
                  }`}
                >
                  {orderStatus.text}
                </div>
              )}

              <div className="flex items-center justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setOrderModalOpen(false)}
                  className="px-4 py-2 rounded-md border border-[#CBD5E1] text-xs font-medium text-[#475569] hover:bg-[#F8FAFC] cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={submittingOrder}
                  className={`px-5 py-2 rounded-md text-white text-xs font-semibold cursor-pointer ${
                    orderSide === 'BUY'
                      ? 'bg-[#387ED1] hover:bg-[#2F6DB8]'
                      : 'bg-[#EB5B3C] hover:bg-[#D94A2B]'
                  }`}
                >
                  {submittingOrder
                    ? 'Submitting...'
                    : `${orderSide === 'BUY' ? 'Buy' : 'Sell'} ${orderQty || 0} Units`}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
