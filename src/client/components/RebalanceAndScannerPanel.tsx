import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Activity, RefreshCw, Scale, SlidersHorizontal } from 'lucide-react';
import { formatINR } from '../../shared/catalog.js';
import type { InstrumentSegment, PortfolioSnapshot } from '../../shared/types.js';
import {
  computeAllocationDriftReport,
  DEFAULT_TARGET_WEIGHTS,
  type TechnicalScannerMatch,
} from '../../shared/rebalanceAndScannerEngine.js';

interface RebalanceAndScannerPanelProps {
  portfolio: PortfolioSnapshot;
  onSelectSymbol: (symbol: string) => void;
}

type SignalFilter = 'ALL' | 'CROSSOVER' | 'RSI_EXTREME' | 'BOLLINGER';

export const RebalanceAndScannerPanel: React.FC<RebalanceAndScannerPanelProps> = ({
  portfolio,
  onSelectSymbol,
}) => {
  const [driftThreshold, setDriftThreshold] = useState<number>(5);
  const [customTargets, setCustomTargets] =
    useState<Record<InstrumentSegment, number>>(DEFAULT_TARGET_WEIGHTS);
  const [scannerSignals, setScannerSignals] = useState<TechnicalScannerMatch[]>([]);
  const [signalFilter, setSignalFilter] = useState<SignalFilter>('ALL');
  const [scanning, setScanning] = useState<boolean>(false);

  const driftReport = useMemo(
    () => computeAllocationDriftReport(portfolio, customTargets, driftThreshold),
    [portfolio, customTargets, driftThreshold]
  );

  const runScanner = useCallback(async () => {
    setScanning(true);
    try {
      const res = await fetch(`/api/scanner?threshold=${driftThreshold}`);
      if (res.ok) {
        const data = (await res.json()) as { signals: TechnicalScannerMatch[] };
        setScannerSignals(data.signals);
      }
    } catch {
      // ignore transient network errors
    } finally {
      setScanning(false);
    }
  }, [driftThreshold]);

  useEffect(() => {
    void runScanner();
  }, [runScanner]);

  const filteredMatches = useMemo(() => {
    const active = scannerSignals.filter((m) => {
      if (signalFilter === 'CROSSOVER') {
        return (
          m.signals.includes('EMA_GOLDEN_CROSS') || m.signals.includes('EMA_DEATH_CROSS')
        );
      }
      if (signalFilter === 'RSI_EXTREME') {
        return (
          m.signals.includes('RSI_OVERSOLD_35') || m.signals.includes('RSI_OVERBOUGHT_68')
        );
      }
      if (signalFilter === 'BOLLINGER') {
        return (
          m.signals.includes('BOLLINGER_UPPER_BREAK') ||
          m.signals.includes('BOLLINGER_LOWER_TOUCH')
        );
      }
      return true;
    });
    return active.slice(0, 12);
  }, [scannerSignals, signalFilter]);

  const targetSum = useMemo(
    () => Object.values(customTargets).reduce((acc, val) => acc + (Number(val) || 0), 0),
    [customTargets]
  );

  return (
    <div className="space-y-4">
      {/* 1. Portfolio Rebalancing Alert & Allocation Drift Monitor */}
      <div className="bg-[#0D1421] rounded-xl border border-slate-800 p-4 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-800 pb-3">
          <div className="flex items-center gap-2">
            <Scale className="w-4 h-4 text-[#00D09C]" />
            <div>
              <h3 className="text-sm font-semibold text-white">
                Portfolio Rebalancing Alert & Allocation Drift Monitor
              </h3>
              <p className="text-xs text-slate-400">
                Tracks live segment weights against your target weights and flags breaches beyond ±{driftThreshold}%.
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <span className="text-[11px] font-mono text-slate-400">
              Target Sum:{' '}
              <strong className={targetSum === 100 ? 'text-[#00D09C]' : 'text-amber-400'}>
                {targetSum}%
              </strong>
            </span>
            <select
              value={driftThreshold}
              onChange={(e) => setDriftThreshold(Number(e.target.value))}
              className="px-2.5 py-1.5 text-xs font-mono rounded-lg border border-slate-700 bg-[#070B12] text-slate-100"
            >
              <option value={3}>Threshold: ±3%</option>
              <option value={5}>Threshold: ±5%</option>
              <option value={8}>Threshold: ±8%</option>
              <option value={10}>Threshold: ±10%</option>
            </select>
          </div>
        </div>

        {driftReport.requiresRebalancing && (
          <div className="p-2.5 rounded-lg bg-amber-950/30 border border-amber-500/40 text-xs text-amber-200 flex items-center justify-between">
            <span>
              Rebalancing alert triggered: <strong>{driftReport.driftedSegmentsCount}</strong>{' '}
              segment(s) drifted beyond ±{driftThreshold}% from target allocation.
            </span>
            <span className="font-mono text-[11px] text-amber-300">Mathematical Drift Alert</span>
          </div>
        )}

        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse text-xs">
            <thead>
              <tr className="border-b border-slate-800 text-[11px] font-mono text-slate-400 bg-[#111A2B]">
                <th className="py-2 px-3">Segment</th>
                <th className="py-2 px-3 text-right">Actual %</th>
                <th className="py-2 px-3 text-right">Target %</th>
                <th className="py-2 px-3 text-right">Drift</th>
                <th className="py-2 px-3 text-center">Band Status</th>
                <th className="py-2 px-3 text-right">Objective Delta (₹)</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/70 font-mono">
              {driftReport.items.map((item) => {
                const badgeClass =
                  item.status === 'OVERWEIGHT_DRIFT'
                    ? 'bg-rose-950/80 text-[#FB7185] border-rose-500/30'
                    : item.status === 'UNDERWEIGHT_DRIFT'
                      ? 'bg-emerald-950/80 text-[#00D09C] border-emerald-500/30'
                      : 'bg-slate-800 text-slate-300 border-slate-700';
                const statusLabel =
                  item.status === 'OVERWEIGHT_DRIFT'
                    ? 'Overweight Drift'
                    : item.status === 'UNDERWEIGHT_DRIFT'
                      ? 'Underweight Drift'
                      : 'Within Band';
                return (
                  <tr key={item.segment} className="hover:bg-slate-900/50">
                    <td className="py-2 px-3 font-sans font-semibold text-slate-100">
                      {item.label}
                    </td>
                    <td className="py-2 px-3 text-right text-slate-200">
                      {item.currentWeightPercent.toFixed(1)}%
                    </td>
                    <td className="py-2 px-3 text-right">
                      <input
                        type="number"
                        min={0}
                        max={100}
                        value={customTargets[item.segment]}
                        onChange={(e) =>
                          setCustomTargets((prev) => ({
                            ...prev,
                            [item.segment]: Math.max(0, Math.min(100, Number(e.target.value) || 0)),
                          }))
                        }
                        className="w-16 px-2 py-0.5 text-right rounded border border-slate-700 bg-[#070B12] text-white"
                      />
                    </td>
                    <td
                      className={`py-2 px-3 text-right font-semibold ${
                        item.driftPercent > 0
                          ? 'text-[#FB7185]'
                          : item.driftPercent < 0
                            ? 'text-[#00D09C]'
                            : 'text-slate-400'
                      }`}
                    >
                      {item.driftPercent >= 0 ? '+' : ''}
                      {item.driftPercent.toFixed(1)}%
                    </td>
                    <td className="py-2 px-3 text-center">
                      <span
                        className={`inline-block px-2 py-0.5 rounded text-[10px] border ${badgeClass}`}
                      >
                        {statusLabel}
                      </span>
                    </td>
                    <td className="py-2 px-3 text-right text-slate-200">
                      {item.rebalanceDeltaINR >= 0 ? '+' : '-'}
                      {formatINR(Math.abs(item.rebalanceDeltaINR))}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* 2. Vectorized Non-Advisory Technical Scanner */}
      <div className="bg-[#0D1421] rounded-xl border border-slate-800 p-4 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-800 pb-3">
          <div className="flex items-center gap-2">
            <SlidersHorizontal className="w-4 h-4 text-amber-400" />
            <div>
              <h3 className="text-sm font-semibold text-white">
                Vectorized Technical Crossover & Volatility Scanner
              </h3>
              <p className="text-xs text-slate-400">
                Scans live NSE/BSE/MCX candles for EMA(12/26) crossovers, Wilder RSI(14) zones, and 2σ Bollinger touches.
              </p>
            </div>
          </div>

          <button
            type="button"
            onClick={runScanner}
            disabled={scanning}
            className="px-3 py-1.5 rounded-lg text-xs font-semibold bg-[#059669] text-white hover:bg-emerald-500 cursor-pointer flex items-center gap-1.5 disabled:opacity-50"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${scanning ? 'animate-spin' : ''}`} />
            <span>{scanning ? 'Scanning...' : 'Run Vectorized Scan'}</span>
          </button>
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          {(
            [
              ['ALL', 'All Matches'],
              ['CROSSOVER', 'EMA 12/26 Crossovers'],
              ['RSI_EXTREME', 'RSI Extremes (<=35 / >=68)'],
              ['BOLLINGER', 'Bollinger 2σ Breaches'],
            ] as Array<[SignalFilter, string]>
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              onClick={() => setSignalFilter(id)}
              className={`px-2.5 py-1 rounded-md text-[11px] font-semibold cursor-pointer transition ${
                signalFilter === id
                  ? 'bg-[#00B386] text-slate-950 font-bold'
                  : 'bg-[#111A2B] text-slate-300 border border-slate-800 hover:bg-slate-800'
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse text-xs">
            <thead>
              <tr className="border-b border-slate-800 text-[11px] font-mono text-slate-400 bg-[#111A2B]">
                <th className="py-2 px-3">Instrument</th>
                <th className="py-2 px-3 text-right">Live LTP</th>
                <th className="py-2 px-3 text-right">EMA 12 / 26</th>
                <th className="py-2 px-3 text-right">RSI (14)</th>
                <th className="py-2 px-3">Detected Technical Conditions</th>
                <th className="py-2 px-3 text-center">Chart</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/70 font-mono">
              {filteredMatches.map((m) => (
                <tr key={m.symbol} className="hover:bg-slate-900/50">
                  <td className="py-2 px-3 font-sans">
                    <div className="font-semibold text-white">{m.symbol}</div>
                    <div className="text-[11px] text-slate-400">{m.exchange}</div>
                  </td>
                  <td className="py-2 px-3 text-right">
                    <div className="font-semibold text-white">{formatINR(m.ltp)}</div>
                    <div
                      className={`text-[10px] ${
                        m.changePercent >= 0 ? 'text-[#00D09C]' : 'text-[#FB7185]'
                      }`}
                    >
                      {m.changePercent >= 0 ? '+' : ''}
                      {m.changePercent.toFixed(2)}%
                    </div>
                  </td>
                  <td className="py-2 px-3 text-right text-slate-300">
                    <div>{m.ema12.toFixed(1)}</div>
                    <div className="text-[10px] text-slate-500">{m.ema26.toFixed(1)}</div>
                  </td>
                  <td
                    className={`py-2 px-3 text-right font-semibold ${
                      m.rsi14 >= 68
                        ? 'text-[#FB7185]'
                        : m.rsi14 <= 35
                          ? 'text-[#00D09C]'
                          : 'text-slate-200'
                    }`}
                  >
                    {m.rsi14.toFixed(1)}
                  </td>
                  <td className="py-2 px-3 font-sans">
                    <div className="flex flex-wrap gap-1">
                      {m.signals.length === 0 ? (
                        <span className="text-[11px] text-slate-500">Inside 2σ Band</span>
                      ) : (
                        m.signals.map((sig) => (
                          <span
                            key={sig}
                            className={`text-[10px] font-mono px-1.5 py-0.5 rounded border ${
                              sig.includes('GOLDEN') || sig.includes('OVERSOLD')
                                ? 'bg-emerald-950/80 text-[#00D09C] border-emerald-500/30'
                                : 'bg-rose-950/80 text-[#FB7185] border-rose-500/30'
                            }`}
                          >
                            {sig}
                          </span>
                        ))
                      )}
                    </div>
                  </td>
                  <td className="py-2 px-3 text-center font-sans">
                    <button
                      type="button"
                      onClick={() => onSelectSymbol(m.symbol)}
                      className="px-2.5 py-1 rounded text-[11px] font-semibold bg-[#111A2B] text-[#00D09C] border border-emerald-500/30 hover:bg-slate-800 cursor-pointer inline-flex items-center gap-1"
                    >
                      <Activity className="w-3 h-3" />
                      <span>Inspect</span>
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <p className="text-[11px] text-slate-500 border-t border-slate-800 pt-2">
          Objective mathematical drift and technical indicator filter output only — not investment advice or a profit guarantee.
        </p>
      </div>
    </div>
  );
};
