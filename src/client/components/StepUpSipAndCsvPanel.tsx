import React, { useMemo, useState } from 'react';
import { Download, TrendingUp } from 'lucide-react';
import { formatINR } from '../../shared/catalog.js';
import type { PortfolioSnapshot } from '../../shared/types.js';
import { computeStepUpSipProjection } from '../../shared/quantRiskEngine.js';
import type { CapitalGainsTaxReport } from '../../shared/indianTaxAndCharges.js';

interface StepUpSipAndCsvPanelProps {
  portfolio: PortfolioSnapshot;
  taxReport: CapitalGainsTaxReport | null;
}

export const StepUpSipAndCsvPanel: React.FC<StepUpSipAndCsvPanelProps> = ({
  portfolio,
  taxReport,
}) => {
  const [monthlySip, setMonthlySip] = useState<string>('25000');
  const [annualStepUp, setAnnualStepUp] = useState<string>('10');
  const [expectedCagr, setExpectedCagr] = useState<string>('14.5');
  const [tenureYears, setTenureYears] = useState<string>('10');

  const sipProjection = useMemo(() => {
    const sip = Math.max(500, Number(monthlySip) || 25000);
    const stepUp = Math.max(0, Math.min(50, Number(annualStepUp) || 10));
    const cagr = Math.max(1, Math.min(40, Number(expectedCagr) || 14.5));
    const years = Math.max(1, Math.min(40, Number(tenureYears) || 10));
    return computeStepUpSipProjection(sip, stepUp, cagr, years);
  }, [monthlySip, annualStepUp, expectedCagr, tenureYears]);

  const handleExportCsv = () => {
    const header = [
      'RecordType',
      'Symbol',
      'Exchange',
      'Brokers',
      'Quantity',
      'FifoAvgCostINR',
      'LiveLtpINR',
      'MarketValueINR',
      'UnrealizedPnlINR',
      'UnrealizedPnlPct',
    ].join(',');

    const holdingRows = portfolio.holdings.map((h) =>
      [
        'FIFO_HOLDING',
        h.symbol,
        h.exchange,
        `"${h.brokers.join(' | ')}"`,
        h.quantity,
        h.avgCostBasis.toFixed(2),
        h.currentPrice.toFixed(2),
        h.marketValue.toFixed(2),
        h.unrealizedPnl.toFixed(2),
        h.unrealizedPnlPercent.toFixed(2),
      ].join(',')
    );

    const summaryRows = [
      [
        'PORTFOLIO_SUMMARY',
        'TOTAL_EQUITY',
        'NSE/BSE',
        '"All Linked Demat"',
        portfolio.holdings.length,
        portfolio.totalCostBasis.toFixed(2),
        '0.00',
        portfolio.holdingsMarketValue.toFixed(2),
        portfolio.totalUnrealizedPnl.toFixed(2),
        portfolio.totalUnrealizedPnlPercent.toFixed(2),
      ].join(','),
      [
        'TAX_SUMMARY',
        'SEBI_STCG_111A',
        'INDIA_IT',
        '"FIFO Tax Engine"',
        0,
        (taxReport?.realizedStcgGross ?? portfolio.totalRealizedPnl).toFixed(2),
        '0.00',
        (taxReport?.estimatedStcgTax ?? 0).toFixed(2),
        (taxReport?.potentialTaxSavingsViaHarvesting ?? 0).toFixed(2),
        '20.80',
      ].join(','),
    ];

    const csvContent = [header, ...holdingRows, ...summaryRows].join('\n');
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `kitepulse-fifo-ledger-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  return (
    <div className="bg-[#0D1421] rounded-xl border border-slate-800 p-4 space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-800 pb-3">
        <div className="flex items-center gap-2">
          <TrendingUp className="w-4 h-4 text-[#00D09C]" />
          <div>
            <h3 className="text-sm font-semibold text-white">
              Step-Up SIP Wealth Projector & Verified Ledger CSV Export
            </h3>
            <p className="text-xs text-slate-400">
              Models annual step-up compounding with 6% CPI inflation adjustment and exports your raw SQLite FIFO ledger.
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={handleExportCsv}
          className="px-3 py-1.5 rounded-lg text-xs font-semibold bg-[#111A2B] text-[#00D09C] border border-emerald-500/30 hover:bg-slate-800 cursor-pointer flex items-center gap-1.5"
        >
          <Download className="w-3.5 h-3.5" />
          <span>Export Real FIFO Ledger (.CSV)</span>
        </button>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <div>
          <label className="block text-[11px] font-medium text-slate-300 mb-1">
            Monthly SIP (₹)
          </label>
          <input
            type="number"
            min="500"
            step="500"
            value={monthlySip}
            onChange={(e) => setMonthlySip(e.target.value)}
            className="w-full px-2.5 py-1.5 text-xs font-mono font-semibold rounded-lg border border-slate-700 bg-[#070B12] text-white"
          />
        </div>
        <div>
          <label className="block text-[11px] font-medium text-slate-300 mb-1">
            Annual Step-Up (%)
          </label>
          <input
            type="number"
            min="0"
            max="50"
            step="1"
            value={annualStepUp}
            onChange={(e) => setAnnualStepUp(e.target.value)}
            className="w-full px-2.5 py-1.5 text-xs font-mono font-semibold rounded-lg border border-slate-700 bg-[#070B12] text-white"
          />
        </div>
        <div>
          <label className="block text-[11px] font-medium text-slate-300 mb-1">
            Expected CAGR (%)
          </label>
          <input
            type="number"
            min="1"
            max="40"
            step="0.5"
            value={expectedCagr}
            onChange={(e) => setExpectedCagr(e.target.value)}
            className="w-full px-2.5 py-1.5 text-xs font-mono font-semibold rounded-lg border border-slate-700 bg-[#070B12] text-white"
          />
        </div>
        <div>
          <label className="block text-[11px] font-medium text-slate-300 mb-1">
            Horizon (Years)
          </label>
          <input
            type="number"
            min="1"
            max="40"
            step="1"
            value={tenureYears}
            onChange={(e) => setTenureYears(e.target.value)}
            className="w-full px-2.5 py-1.5 text-xs font-mono font-semibold rounded-lg border border-slate-700 bg-[#070B12] text-white"
          />
        </div>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 font-mono text-xs pt-1">
        <div className="bg-[#070B12] rounded-lg p-3 border border-slate-800">
          <div className="text-[11px] text-slate-400">Total Principal Invested</div>
          <div className="text-sm font-bold text-slate-100 mt-1">
            {formatINR(sipProjection.totalInvestedINR)}
          </div>
        </div>
        <div className="bg-[#070B12] rounded-lg p-3 border border-emerald-500/30">
          <div className="text-[11px] text-slate-400">Compounded Wealth Gain</div>
          <div className="text-sm font-bold text-[#00D09C] mt-1">
            +{formatINR(sipProjection.totalWealthGainedINR)}
          </div>
        </div>
        <div className="bg-emerald-950/25 rounded-lg p-3 border border-emerald-500/40">
          <div className="text-[11px] text-emerald-300">Projected Maturity Value</div>
          <div className="text-sm font-bold text-[#00D09C] mt-1">
            {formatINR(sipProjection.finalCorpusINR)}
          </div>
        </div>
        <div className="bg-[#070B12] rounded-lg p-3 border border-amber-500/30">
          <div className="text-[11px] text-amber-300">Real Value (6% CPI Adj.)</div>
          <div className="text-sm font-bold text-amber-400 mt-1">
            {formatINR(sipProjection.inflationAdjustedCorpusINR)}
          </div>
        </div>
      </div>
    </div>
  );
};
