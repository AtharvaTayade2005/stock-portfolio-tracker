import React, { useEffect, useRef, useState } from 'react';
import type { IndicatorSummary, OhlcvCandle } from '../../shared/types.js';

interface CandlestickChartProps {
  symbol: string;
  candles: OhlcvCandle[];
  indicators: IndicatorSummary | null;
  showSma: boolean;
  showEma: boolean;
  showBollinger: boolean;
  onToggleSma: () => void;
  onToggleEma: () => void;
  onToggleBollinger: () => void;
  height?: number;
}

export const CandlestickChart: React.FC<CandlestickChartProps> = ({
  symbol,
  candles,
  indicators,
  showSma,
  showEma,
  showBollinger,
  onToggleSma,
  onToggleEma,
  onToggleBollinger,
  height = 460,
}) => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  const [chartMode, setChartMode] = useState<'CANDLES' | 'AREA'>('CANDLES');
  const [dimensions, setDimensions] = useState<{ width: number; height: number }>({
    width: 820,
    height,
  });

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const w = Math.max(320, Math.floor(entry.contentRect.width));
        setDimensions({ width: w, height });
      }
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [height]);

  const visibleCount = Math.min(candles.length, 95);
  const startIndex = Math.max(0, candles.length - visibleCount);
  const visibleCandles = candles.slice(startIndex);
  const visiblePoints = indicators ? indicators.points.slice(startIndex) : [];

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || visibleCandles.length === 0) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const { width, height: h } = dimensions;
    canvas.width = width * dpr;
    canvas.height = h * dpr;
    ctx.scale(dpr, dpr);

    // Sleek Institutional Obsidian Dark Canvas
    ctx.fillStyle = '#0B111E';
    ctx.fillRect(0, 0, width, h);

    const rightAxisWidth = 76;
    const padLeft = 16;
    const padTop = 16;
    const chartWidth = width - padLeft - rightAxisWidth;

    const pricePaneHeight = Math.floor(h * 0.72);
    const dividerY = padTop + pricePaneHeight;
    const rsiTop = dividerY + 20;
    const rsiHeight = h - rsiTop - 24;

    let minPrice = Infinity;
    let maxPrice = -Infinity;
    let maxVolume = 1;

    for (let i = 0; i < visibleCandles.length; i++) {
      const c = visibleCandles[i];
      if (c.low < minPrice) minPrice = c.low;
      if (c.high > maxPrice) maxPrice = c.high;
      if (c.volume > maxVolume) maxVolume = c.volume;

      const pt = visiblePoints[i];
      if (pt && showBollinger) {
        if (pt.bbLower !== null && pt.bbLower < minPrice) minPrice = pt.bbLower;
        if (pt.bbUpper !== null && pt.bbUpper > maxPrice) maxPrice = pt.bbUpper;
      }
    }

    if (!Number.isFinite(minPrice) || !Number.isFinite(maxPrice) || maxPrice <= minPrice) {
      minPrice = 0;
      maxPrice = 100;
    }

    const padding = (maxPrice - minPrice) * 0.08 || 1;
    minPrice -= padding;
    maxPrice += padding;
    const priceRange = maxPrice - minPrice;

    const count = visibleCandles.length;
    const stepX = chartWidth / Math.max(1, count);
    const idxToX = (i: number) => padLeft + (i + 0.5) * stepX;
    const priceToY = (p: number) =>
      padTop + pricePaneHeight - ((p - minPrice) / priceRange) * pricePaneHeight;

    // Subtle Dark Gridlines
    ctx.strokeStyle = '#162032';
    ctx.lineWidth = 1;
    ctx.fillStyle = '#94A3B8';
    ctx.font = '11px "Inter", sans-serif';
    ctx.textAlign = 'left';

    const gridSteps = 5;
    for (let s = 0; s <= gridSteps; s++) {
      const ratio = s / gridSteps;
      const y = Math.floor(padTop + ratio * pricePaneHeight) + 0.5;
      const priceVal = maxPrice - ratio * priceRange;

      ctx.beginPath();
      ctx.moveTo(padLeft, y);
      ctx.lineTo(padLeft + chartWidth, y);
      ctx.stroke();

      ctx.fillText(`₹${priceVal.toFixed(2)}`, padLeft + chartWidth + 6, y + 3.5);
    }

    const vStride = Math.max(1, Math.floor(count / 6));
    for (let i = 0; i < count; i += vStride) {
      const vx = Math.floor(idxToX(i)) + 0.5;
      ctx.beginPath();
      ctx.moveTo(vx, padTop);
      ctx.lineTo(vx, h - 22);
      ctx.stroke();
    }

    // Right-axis vertical border
    ctx.strokeStyle = '#1E293B';
    ctx.beginPath();
    ctx.moveTo(padLeft + chartWidth + 0.5, 0);
    ctx.lineTo(padLeft + chartWidth + 0.5, h);
    ctx.stroke();

    // Bollinger Bands (20, 2σ) Shaded Channel
    if (showBollinger && visiblePoints.length === visibleCandles.length) {
      ctx.save();
      ctx.beginPath();
      let started = false;
      for (let i = 0; i < count; i++) {
        const u = visiblePoints[i]?.bbUpper;
        if (u !== null && u !== undefined) {
          const x = idxToX(i);
          const y = priceToY(u);
          if (!started) {
            ctx.moveTo(x, y);
            started = true;
          } else {
            ctx.lineTo(x, y);
          }
        }
      }
      for (let i = count - 1; i >= 0; i--) {
        const l = visiblePoints[i]?.bbLower;
        if (l !== null && l !== undefined) {
          ctx.lineTo(idxToX(i), priceToY(l));
        }
      }
      ctx.closePath();
      ctx.fillStyle = 'rgba(245, 158, 11, 0.07)';
      ctx.fill();
      ctx.restore();

      const drawBandLine = (
        getter: (pt: (typeof visiblePoints)[number]) => number | null,
        dashed = false
      ) => {
        ctx.save();
        ctx.strokeStyle = dashed ? 'rgba(245, 158, 11, 0.45)' : 'rgba(245, 158, 11, 0.65)';
        ctx.lineWidth = 1.1;
        if (dashed) ctx.setLineDash([4, 4]);
        ctx.beginPath();
        let lineStarted = false;
        for (let i = 0; i < count; i++) {
          const val = getter(visiblePoints[i]);
          if (val !== null && val !== undefined) {
            const x = idxToX(i);
            const y = priceToY(val);
            if (!lineStarted) {
              ctx.moveTo(x, y);
              lineStarted = true;
            } else {
              ctx.lineTo(x, y);
            }
          }
        }
        ctx.stroke();
        ctx.restore();
      };

      drawBandLine((p) => p?.bbUpper ?? null, false);
      drawBandLine((p) => p?.bbMiddle ?? null, true);
      drawBandLine((p) => p?.bbLower ?? null, false);
    }

    // Volume Bars along bottom of price pane
    const maxVolHeight = pricePaneHeight * 0.17;
    const candleWidth = Math.max(2.5, Math.min(10, Math.floor(stepX * 0.65)));

    for (let i = 0; i < count; i++) {
      const c = visibleCandles[i];
      const x = idxToX(i);
      const volH = (c.volume / maxVolume) * maxVolHeight;
      const isBull = c.close >= c.open;
      ctx.fillStyle = isBull ? 'rgba(0, 208, 156, 0.18)' : 'rgba(244, 63, 94, 0.18)';
      ctx.fillRect(x - candleWidth / 2, dividerY - volH, candleWidth, volH);
    }

    if (chartMode === 'AREA') {
      const firstClose = visibleCandles[0]?.close ?? 0;
      const lastClose = visibleCandles[count - 1]?.close ?? 0;
      const isUp = lastClose >= firstClose;
      const lineColor = isUp ? '#00D09C' : '#F43F5E';

      ctx.save();
      ctx.beginPath();
      for (let i = 0; i < count; i++) {
        const x = idxToX(i);
        const y = priceToY(visibleCandles[i].close);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.strokeStyle = lineColor;
      ctx.lineWidth = 2;
      ctx.stroke();

      ctx.lineTo(idxToX(count - 1), dividerY);
      ctx.lineTo(idxToX(0), dividerY);
      ctx.closePath();
      const grad = ctx.createLinearGradient(0, padTop, 0, dividerY);
      grad.addColorStop(0, isUp ? 'rgba(0, 208, 156, 0.25)' : 'rgba(244, 63, 94, 0.25)');
      grad.addColorStop(1, 'rgba(11, 17, 30, 0.0)');
      ctx.fillStyle = grad;
      ctx.fill();
      ctx.restore();
    } else {
      // OHLC Candlesticks (Luminous Bullish Emerald #00D09C & Bearish Crimson #F43F5E)
      for (let i = 0; i < count; i++) {
        const c = visibleCandles[i];
        const x = Math.floor(idxToX(i)) + 0.5;
        const isBull = c.close >= c.open;
        const color = isBull ? '#00D09C' : '#F43F5E';

        const highY = priceToY(c.high);
        const lowY = priceToY(c.low);
        const openY = priceToY(c.open);
        const closeY = priceToY(c.close);

        ctx.strokeStyle = color;
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.moveTo(x, highY);
        ctx.lineTo(x, lowY);
        ctx.stroke();

        const bodyTop = Math.min(openY, closeY);
        const bodyHeight = Math.max(2, Math.abs(closeY - openY));
        ctx.fillStyle = color;
        ctx.fillRect(x - candleWidth / 2, bodyTop, candleWidth, bodyHeight);
      }
    }

    const drawOverlay = (
      getter: (pt: (typeof visiblePoints)[number]) => number | null,
      color: string,
      lineWidth = 1.6
    ) => {
      if (visiblePoints.length !== count) return;
      ctx.save();
      ctx.strokeStyle = color;
      ctx.lineWidth = lineWidth;
      ctx.beginPath();
      let started = false;
      for (let i = 0; i < count; i++) {
        const val = getter(visiblePoints[i]);
        if (val !== null && val !== undefined) {
          const x = idxToX(i);
          const y = priceToY(val);
          if (!started) {
            ctx.moveTo(x, y);
            started = true;
          } else {
            ctx.lineTo(x, y);
          }
        }
      }
      ctx.stroke();
      ctx.restore();
    };

    if (showSma) {
      drawOverlay((p) => p?.sma20 ?? null, '#38BDF8', 1.6);
      drawOverlay((p) => p?.sma50 ?? null, '#F59E0B', 1.6);
    }

    if (showEma) {
      drawOverlay((p) => p?.ema12 ?? null, '#00D09C', 1.3);
      drawOverlay((p) => p?.ema26 ?? null, '#FB7185', 1.3);
    }

    // Latest Price Horizontal Guide & Right-Axis Pill
    const latestCandle = visibleCandles[count - 1];
    if (latestCandle) {
      const latestY = Math.floor(priceToY(latestCandle.close)) + 0.5;
      const isBull = latestCandle.close >= latestCandle.open;
      const tagColor = isBull ? '#059669' : '#E11D48';

      ctx.save();
      ctx.setLineDash([3, 3]);
      ctx.strokeStyle = tagColor;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(padLeft, latestY);
      ctx.lineTo(padLeft + chartWidth, latestY);
      ctx.stroke();
      ctx.restore();

      ctx.fillStyle = tagColor;
      ctx.fillRect(padLeft + chartWidth + 1, latestY - 10, rightAxisWidth - 2, 20);
      ctx.fillStyle = '#FFFFFF';
      ctx.font = '600 11px "Inter", sans-serif';
      ctx.fillText(`₹${latestCandle.close.toFixed(2)}`, padLeft + chartWidth + 5, latestY + 4);
    }

    // --- RSI (14) Sub-Pane ---
    ctx.strokeStyle = '#1E293B';
    ctx.beginPath();
    ctx.moveTo(0, dividerY);
    ctx.lineTo(width, dividerY);
    ctx.stroke();

    ctx.fillStyle = '#94A3B8';
    ctx.font = '600 10px "Inter", sans-serif';
    ctx.fillText('RSI (14) Momentum', padLeft + 2, dividerY + 14);

    const rsiToY = (rsi: number) => rsiTop + rsiHeight - (rsi / 100) * rsiHeight;
    const y70 = Math.floor(rsiToY(70)) + 0.5;
    const y30 = Math.floor(rsiToY(30)) + 0.5;

    ctx.fillStyle = 'rgba(0, 208, 156, 0.05)';
    ctx.fillRect(padLeft, y70, chartWidth, y30 - y70);

    ctx.save();
    ctx.setLineDash([3, 3]);
    ctx.strokeStyle = '#334155';
    ctx.beginPath();
    ctx.moveTo(padLeft, y70);
    ctx.lineTo(padLeft + chartWidth, y70);
    ctx.moveTo(padLeft, y30);
    ctx.lineTo(padLeft + chartWidth, y30);
    ctx.stroke();
    ctx.restore();

    ctx.fillStyle = '#64748B';
    ctx.font = '10px "Inter", sans-serif';
    ctx.fillText('70', padLeft + chartWidth + 8, y70 + 3);
    ctx.fillText('30', padLeft + chartWidth + 8, y30 + 3);

    if (visiblePoints.length === count) {
      ctx.save();
      ctx.strokeStyle = '#F59E0B';
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      let started = false;
      for (let i = 0; i < count; i++) {
        const r = visiblePoints[i]?.rsi14;
        if (r !== null && r !== undefined) {
          const x = idxToX(i);
          const y = rsiToY(r);
          if (!started) {
            ctx.moveTo(x, y);
            started = true;
          } else {
            ctx.lineTo(x, y);
          }
        }
      }
      ctx.stroke();
      ctx.restore();
    }

    // Time Axis Labels
    ctx.fillStyle = '#94A3B8';
    ctx.font = '11px "Inter", sans-serif';
    for (let i = 0; i < count; i += vStride) {
      const c = visibleCandles[i];
      const x = idxToX(i);
      const dateStr = new Date(c.time * 1000).toLocaleTimeString([], {
        hour: '2-digit',
        minute: '2-digit',
      });
      ctx.fillText(dateStr, Math.max(padLeft, x - 20), h - 6);
    }

    // Crosshair on hover
    if (hoverIndex !== null && hoverIndex >= 0 && hoverIndex < count) {
      const hx = Math.floor(idxToX(hoverIndex)) + 0.5;
      ctx.save();
      ctx.setLineDash([4, 4]);
      ctx.strokeStyle = '#64748B';
      ctx.beginPath();
      ctx.moveTo(hx, padTop);
      ctx.lineTo(hx, h - 22);
      ctx.stroke();
      ctx.restore();
    }
  }, [
    visibleCandles,
    visiblePoints,
    dimensions,
    showSma,
    showEma,
    showBollinger,
    hoverIndex,
    chartMode,
  ]);

  const handleMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left - 16;
    const chartWidth = dimensions.width - 16 - 76;
    if (x < 0 || x > chartWidth || visibleCandles.length === 0) {
      setHoverIndex(null);
      return;
    }
    const idx = Math.min(
      visibleCandles.length - 1,
      Math.max(0, Math.floor((x / chartWidth) * visibleCandles.length))
    );
    setHoverIndex(idx);
  };

  const activeIdx =
    hoverIndex !== null && hoverIndex < visibleCandles.length
      ? hoverIndex
      : visibleCandles.length - 1;
  const activeCandle = visibleCandles[activeIdx];
  const activePoint = visiblePoints[activeIdx];

  return (
    <div className="bg-[#0D1421] border border-slate-800 rounded-xl overflow-hidden shadow-lg">
      {/* Top Dark Chart Toolbar */}
      <div className="px-4 py-2.5 border-b border-slate-800 flex flex-wrap items-center justify-between gap-3 bg-[#111A2B]">
        <div className="flex flex-wrap items-center gap-3 text-xs tabular-nums">
          <div className="inline-flex rounded-lg border border-slate-700 bg-[#070B12] p-0.5">
            <button
              type="button"
              onClick={() => setChartMode('CANDLES')}
              className={`px-2.5 py-1 rounded-md text-xs font-semibold cursor-pointer transition-colors ${
                chartMode === 'CANDLES'
                  ? 'bg-[#059669] text-white'
                  : 'text-slate-400 hover:text-white'
              }`}
            >
              Candles
            </button>
            <button
              type="button"
              onClick={() => setChartMode('AREA')}
              className={`px-2.5 py-1 rounded-md text-xs font-semibold cursor-pointer transition-colors ${
                chartMode === 'AREA'
                  ? 'bg-[#059669] text-white'
                  : 'text-slate-400 hover:text-white'
              }`}
            >
              Area Line
            </button>
          </div>

          {activeCandle && (
            <div className="flex flex-wrap items-center gap-3 text-slate-400">
              <span>
                O <strong className="text-slate-100 font-semibold">₹{activeCandle.open.toFixed(2)}</strong>
              </span>
              <span>
                H <strong className="text-[#00D09C] font-semibold">₹{activeCandle.high.toFixed(2)}</strong>
              </span>
              <span>
                L <strong className="text-[#FB7185] font-semibold">₹{activeCandle.low.toFixed(2)}</strong>
              </span>
              <span>
                C{' '}
                <strong
                  className={
                    activeCandle.close >= activeCandle.open
                      ? 'text-[#00D09C] font-bold'
                      : 'text-[#FB7185] font-bold'
                  }
                >
                  ₹{activeCandle.close.toFixed(2)}
                </strong>
              </span>
              <span className="hidden sm:inline">
                Vol <strong className="text-slate-200 font-medium">{activeCandle.volume.toLocaleString('en-IN')}</strong>
              </span>
            </div>
          )}

          {activePoint && (
            <div className="hidden xl:flex items-center gap-3 pl-3 border-l border-slate-800">
              {activePoint.sma20 !== null && (
                <span className="text-sky-400 font-medium">SMA20: ₹{activePoint.sma20.toFixed(2)}</span>
              )}
              {activePoint.sma50 !== null && (
                <span className="text-amber-400 font-medium">SMA50: ₹{activePoint.sma50.toFixed(2)}</span>
              )}
              {activePoint.rsi14 !== null && (
                <span className="text-emerald-400 font-medium">RSI: {activePoint.rsi14.toFixed(1)}</span>
              )}
            </div>
          )}
        </div>

        {/* Indicator Toggles */}
        <div className="flex items-center gap-1.5">
          <span className="text-xs text-slate-400 mr-1 hidden sm:inline">Indicators:</span>
          <button
            type="button"
            onClick={onToggleSma}
            className={`px-2.5 py-1 rounded-md text-xs font-semibold transition-colors cursor-pointer border ${
              showSma
                ? 'bg-sky-500/15 text-sky-300 border-sky-500/40'
                : 'bg-[#070B12] text-slate-400 border-slate-800 hover:text-white'
            }`}
          >
            SMA 20/50
          </button>
          <button
            type="button"
            onClick={onToggleEma}
            className={`px-2.5 py-1 rounded-md text-xs font-semibold transition-colors cursor-pointer border ${
              showEma
                ? 'bg-emerald-500/15 text-[#00D09C] border-emerald-500/40'
                : 'bg-[#070B12] text-slate-400 border-slate-800 hover:text-white'
            }`}
          >
            EMA 12/26
          </button>
          <button
            type="button"
            onClick={onToggleBollinger}
            className={`px-2.5 py-1 rounded-md text-xs font-semibold transition-colors cursor-pointer border ${
              showBollinger
                ? 'bg-amber-500/15 text-amber-300 border-amber-500/40'
                : 'bg-[#070B12] text-slate-400 border-slate-800 hover:text-white'
            }`}
          >
            Bollinger Bands
          </button>
        </div>
      </div>

      {/* Chart Canvas */}
      <div ref={containerRef} className="w-full relative select-none">
        <canvas
          ref={canvasRef}
          style={{ width: `${dimensions.width}px`, height: `${dimensions.height}px` }}
          onMouseMove={handleMouseMove}
          onMouseLeave={() => setHoverIndex(null)}
          className="block cursor-crosshair"
        />
      </div>

      {/* Bottom Dark Indicator Legend */}
      {indicators && (
        <div className="px-4 py-2 border-t border-slate-800 bg-[#111A2B] flex flex-wrap items-center justify-between gap-2 text-xs text-slate-400 tabular-nums">
          <div className="flex flex-wrap items-center gap-4">
            <span>
              Momentum Signal:{' '}
              <strong
                className={
                  indicators.signal === 'BULLISH_TREND' || indicators.signal === 'OVERSOLD'
                    ? 'text-[#00D09C]'
                    : indicators.signal === 'BEARISH_TREND' || indicators.signal === 'OVERBOUGHT'
                      ? 'text-[#FB7185]'
                      : 'text-slate-200'
                }
              >
                {indicators.signal.replace('_', ' ')}
              </strong>
            </span>
            <span>
              Upper Band: <strong className="text-slate-200">₹{indicators.bbUpper?.toFixed(2) ?? '—'}</strong>
            </span>
            <span>
              Lower Band: <strong className="text-slate-200">₹{indicators.bbLower?.toFixed(2) ?? '—'}</strong>
            </span>
            <span>
              RSI(14): <strong className="text-amber-400">{indicators.rsi14?.toFixed(1) ?? '—'}</strong>
            </span>
          </div>
          <span className="text-[11px] text-slate-400">
            {symbol} • 5-Min Intraday NSE/BSE Interval ({indicators.computeTimeMs}ms Worker)
          </span>
        </div>
      )}
    </div>
  );
};
