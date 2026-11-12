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

    // Crisp Daylight TradingView / Kite White Canvas
    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(0, 0, width, h);

    const rightAxisWidth = 72;
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
      if (pt && showBollinger && pt.bbUpper !== null && pt.bbLower !== null) {
        if (pt.bbLower < minPrice) minPrice = pt.bbLower;
        if (pt.bbUpper > maxPrice) maxPrice = pt.bbUpper;
      }
    }

    const pricePadding = Math.max(0.15, (maxPrice - minPrice) * 0.08);
    minPrice -= pricePadding;
    maxPrice += pricePadding;
    const priceRange = Math.max(0.01, maxPrice - minPrice);

    const priceToY = (p: number) =>
      padTop + pricePaneHeight - ((p - minPrice) / priceRange) * pricePaneHeight;

    const count = visibleCandles.length;
    const stepX = chartWidth / Math.max(1, count);
    const idxToX = (i: number) => padLeft + (i + 0.5) * stepX;

    // Horizontal & Vertical Subtle Gridlines (#F1F5F9)
    ctx.strokeStyle = '#F1F5F9';
    ctx.lineWidth = 1;
    ctx.fillStyle = '#64748B';
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
    ctx.strokeStyle = '#E2E8F0';
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
      ctx.fillStyle = 'rgba(56, 126, 209, 0.06)';
      ctx.fill();
      ctx.restore();

      const drawBandLine = (
        getter: (pt: (typeof visiblePoints)[number]) => number | null,
        dashed = false
      ) => {
        ctx.save();
        ctx.strokeStyle = dashed ? 'rgba(56, 126, 209, 0.45)' : 'rgba(56, 126, 209, 0.65)';
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
    const maxVolHeight = pricePaneHeight * 0.16;
    const candleWidth = Math.max(2.5, Math.min(10, Math.floor(stepX * 0.65)));

    for (let i = 0; i < count; i++) {
      const c = visibleCandles[i];
      const x = idxToX(i);
      const volH = (c.volume / maxVolume) * maxVolHeight;
      const isBull = c.close >= c.open;
      ctx.fillStyle = isBull ? 'rgba(0, 179, 134, 0.15)' : 'rgba(235, 91, 60, 0.15)';
      ctx.fillRect(x - candleWidth / 2, dividerY - volH, candleWidth, volH);
    }

    if (chartMode === 'AREA') {
      const firstClose = visibleCandles[0]?.close ?? 0;
      const lastClose = visibleCandles[count - 1]?.close ?? 0;
      const isUp = lastClose >= firstClose;
      const lineColor = isUp ? '#00B386' : '#EB5B3C';

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
      grad.addColorStop(0, isUp ? 'rgba(0, 179, 134, 0.18)' : 'rgba(235, 91, 60, 0.18)');
      grad.addColorStop(1, 'rgba(255, 255, 255, 0.0)');
      ctx.fillStyle = grad;
      ctx.fill();
      ctx.restore();
    } else {
      // OHLC Candlesticks (Zerodha Kite / Groww Green #00B386 & Coral Red #EB5B3C)
      for (let i = 0; i < count; i++) {
        const c = visibleCandles[i];
        const x = Math.floor(idxToX(i)) + 0.5;
        const isBull = c.close >= c.open;
        const color = isBull ? '#00B386' : '#EB5B3C';

        const highY = priceToY(c.high);
        const lowY = priceToY(c.low);
        const openY = priceToY(c.open);
        const closeY = priceToY(c.close);

        ctx.strokeStyle = color;
        ctx.lineWidth = 1.1;
        ctx.beginPath();
        ctx.moveTo(x, highY);
        ctx.lineTo(x, lowY);
        ctx.stroke();

        const bodyTop = Math.min(openY, closeY);
        const bodyHeight = Math.max(1.5, Math.abs(closeY - openY));
        ctx.fillStyle = color;
        ctx.fillRect(x - candleWidth / 2, bodyTop, candleWidth, bodyHeight);
      }
    }

    // Moving Average Overlays (SMA 20/50 & EMA 12/26)
    const drawOverlayLine = (
      getter: (pt: (typeof visiblePoints)[number]) => number | null,
      color: string,
      widthPx = 1.6
    ) => {
      if (visiblePoints.length !== count) return;
      ctx.save();
      ctx.strokeStyle = color;
      ctx.lineWidth = widthPx;
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
      drawOverlayLine((p) => p?.sma20 ?? null, '#2563EB', 1.6); // Royal Blue SMA 20
      drawOverlayLine((p) => p?.sma50 ?? null, '#D97706', 1.5); // Warm Amber SMA 50
    }

    if (showEma) {
      drawOverlayLine((p) => p?.ema12 ?? null, '#0D9488', 1.5); // Teal EMA 12
      drawOverlayLine((p) => p?.ema26 ?? null, '#9333EA', 1.4); // Plum EMA 26
    }

    // Current Price Line & Axis Tag
    const latestCandle = visibleCandles[count - 1];
    if (latestCandle) {
      const latestY = Math.floor(priceToY(latestCandle.close)) + 0.5;
      const isBull = latestCandle.close >= latestCandle.open;
      const tagColor = isBull ? '#00B386' : '#EB5B3C';

      ctx.save();
      ctx.setLineDash([4, 4]);
      ctx.strokeStyle = tagColor;
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
    ctx.strokeStyle = '#E2E8F0';
    ctx.beginPath();
    ctx.moveTo(0, dividerY);
    ctx.lineTo(width, dividerY);
    ctx.stroke();

    ctx.fillStyle = '#64748B';
    ctx.font = '600 10px "Inter", sans-serif';
    ctx.fillText('RSI (14)', padLeft + 2, dividerY + 14);

    const rsiToY = (rsi: number) => rsiTop + rsiHeight - (rsi / 100) * rsiHeight;
    const y70 = Math.floor(rsiToY(70)) + 0.5;
    const y30 = Math.floor(rsiToY(30)) + 0.5;

    ctx.fillStyle = 'rgba(56, 126, 209, 0.04)';
    ctx.fillRect(padLeft, y70, chartWidth, y30 - y70);

    ctx.save();
    ctx.setLineDash([3, 3]);
    ctx.strokeStyle = '#CBD5E1';
    ctx.beginPath();
    ctx.moveTo(padLeft, y70);
    ctx.lineTo(padLeft + chartWidth, y70);
    ctx.moveTo(padLeft, y30);
    ctx.lineTo(padLeft + chartWidth, y30);
    ctx.stroke();
    ctx.restore();

    ctx.fillStyle = '#94A3B8';
    ctx.font = '10px "Inter", sans-serif';
    ctx.fillText('70', padLeft + chartWidth + 8, y70 + 3);
    ctx.fillText('30', padLeft + chartWidth + 8, y30 + 3);

    if (visiblePoints.length === count) {
      ctx.save();
      ctx.strokeStyle = '#387ED1';
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
    ctx.fillStyle = '#64748B';
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
      ctx.strokeStyle = '#94A3B8';
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
    const chartWidth = dimensions.width - 16 - 72;
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
    <div className="bg-white border border-[#E2E8F0] rounded-lg overflow-hidden shadow-[0_1px_2px_rgba(15,23,42,0.03)]">
      {/* Top Chart Toolbar (TradingView / Kite Style) */}
      <div className="px-4 py-2.5 border-b border-[#E2E8F0] flex flex-wrap items-center justify-between gap-3 bg-[#FAFBFC]">
        <div className="flex flex-wrap items-center gap-3 text-xs tabular-nums">
          <div className="inline-flex rounded-md border border-[#E2E8F0] bg-white p-0.5">
            <button
              type="button"
              onClick={() => setChartMode('CANDLES')}
              className={`px-2.5 py-1 rounded text-xs font-medium cursor-pointer transition-colors ${
                chartMode === 'CANDLES'
                  ? 'bg-[#387ED1] text-white'
                  : 'text-[#64748B] hover:text-[#0F172A]'
              }`}
            >
              Candles
            </button>
            <button
              type="button"
              onClick={() => setChartMode('AREA')}
              className={`px-2.5 py-1 rounded text-xs font-medium cursor-pointer transition-colors ${
                chartMode === 'AREA'
                  ? 'bg-[#387ED1] text-white'
                  : 'text-[#64748B] hover:text-[#0F172A]'
              }`}
            >
              Line / Area
            </button>
          </div>

          {activeCandle && (
            <div className="flex flex-wrap items-center gap-3 text-[#64748B]">
              <span>
                O <strong className="text-[#0F172A] font-medium">₹{activeCandle.open.toFixed(2)}</strong>
              </span>
              <span>
                H <strong className="text-[#0F172A] font-medium">₹{activeCandle.high.toFixed(2)}</strong>
              </span>
              <span>
                L <strong className="text-[#0F172A] font-medium">₹{activeCandle.low.toFixed(2)}</strong>
              </span>
              <span>
                C{' '}
                <strong
                  className={
                    activeCandle.close >= activeCandle.open
                      ? 'text-[#00B386] font-semibold'
                      : 'text-[#EB5B3C] font-semibold'
                  }
                >
                  ₹{activeCandle.close.toFixed(2)}
                </strong>
              </span>
              <span className="hidden sm:inline">
                Vol <strong className="text-[#0F172A] font-medium">{activeCandle.volume.toLocaleString('en-IN')}</strong>
              </span>
            </div>
          )}

          {activePoint && (
            <div className="hidden xl:flex items-center gap-3 pl-3 border-l border-[#E2E8F0]">
              {activePoint.sma20 !== null && (
                <span className="text-[#2563EB] font-medium">SMA20: ₹{activePoint.sma20.toFixed(2)}</span>
              )}
              {activePoint.sma50 !== null && (
                <span className="text-[#D97706] font-medium">SMA50: ₹{activePoint.sma50.toFixed(2)}</span>
              )}
              {activePoint.rsi14 !== null && (
                <span className="text-[#387ED1] font-medium">RSI: {activePoint.rsi14.toFixed(1)}</span>
              )}
            </div>
          )}
        </div>

        {/* Indicator Toggles */}
        <div className="flex items-center gap-1.5">
          <span className="text-xs text-[#64748B] mr-1 hidden sm:inline">Studies:</span>
          <button
            type="button"
            onClick={onToggleSma}
            className={`px-2.5 py-1 rounded text-xs font-medium transition-colors cursor-pointer border ${
              showSma
                ? 'bg-[#2563EB]/10 text-[#2563EB] border-[#2563EB]/30'
                : 'bg-white text-[#64748B] border-[#E2E8F0] hover:text-[#0F172A]'
            }`}
          >
            SMA 20/50
          </button>
          <button
            type="button"
            onClick={onToggleEma}
            className={`px-2.5 py-1 rounded text-xs font-medium transition-colors cursor-pointer border ${
              showEma
                ? 'bg-[#0D9488]/10 text-[#0D9488] border-[#0D9488]/30'
                : 'bg-white text-[#64748B] border-[#E2E8F0] hover:text-[#0F172A]'
            }`}
          >
            EMA 12/26
          </button>
          <button
            type="button"
            onClick={onToggleBollinger}
            className={`px-2.5 py-1 rounded text-xs font-medium transition-colors cursor-pointer border ${
              showBollinger
                ? 'bg-[#387ED1]/10 text-[#387ED1] border-[#387ED1]/30'
                : 'bg-white text-[#64748B] border-[#E2E8F0] hover:text-[#0F172A]'
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

      {/* Subtle Bottom Indicator Legend */}
      {indicators && (
        <div className="px-4 py-2 border-t border-[#E2E8F0] bg-[#FAFBFC] flex flex-wrap items-center justify-between gap-2 text-xs text-[#64748B] tabular-nums">
          <div className="flex flex-wrap items-center gap-4">
            <span>
              Trend Signal:{' '}
              <strong
                className={
                  indicators.signal === 'BULLISH_TREND' || indicators.signal === 'OVERSOLD'
                    ? 'text-[#00B386]'
                    : indicators.signal === 'BEARISH_TREND' || indicators.signal === 'OVERBOUGHT'
                    ? 'text-[#EB5B3C]'
                    : 'text-[#0F172A]'
                }
              >
                {indicators.signal.replace('_', ' ')}
              </strong>
            </span>
            <span>
              Upper Band: <strong className="text-[#0F172A]">₹{indicators.bbUpper?.toFixed(2) ?? '—'}</strong>
            </span>
            <span>
              Lower Band: <strong className="text-[#0F172A]">₹{indicators.bbLower?.toFixed(2) ?? '—'}</strong>
            </span>
            <span>
              RSI(14): <strong className="text-[#0F172A]">{indicators.rsi14?.toFixed(1) ?? '—'}</strong>
            </span>
          </div>
          <span className="text-[11px] text-[#94A3B8]">
            {symbol} • 1-Minute Real-Time Interval
          </span>
        </div>
      )}
    </div>
  );
};
