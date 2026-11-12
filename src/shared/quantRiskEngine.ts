import { SYMBOL_MAP } from './catalog.js';
import type { HoldingPosition, PortfolioSnapshot } from './types.js';

export interface QuantRiskMetrics {
  dailyVolatilityPercent: number;
  annualizedVolatilityPercent: number;
  var95DailyINR: number; // 95% Confidence 1-Day Value at Risk (1.645 * sigma)
  var99DailyINR: number; // 99% Confidence 1-Day Value at Risk (2.326 * sigma)
  var95TenDayINR: number; // Basel III 10-Day 95% VaR (sqrt(10) scaling)
  sharpeRatio: number; // (Expected Return - India 10Y G-Sec 6.8%) / Annualized Vol
  sortinoRatio: number; // Downside-only risk-adjusted ratio
  hhiConcentrationIndex: number; // Herfindahl-Hirschman Index (0 to 10,000)
  diversificationScore: number; // 0 to 100
  maxDrawdownEstimatePercent: number;
  riskGrade: 'INSTITUTIONAL_HEDGED' | 'BALANCED_GROWTH' | 'HIGH_BETA_AGGRESSIVE' | 'UNDEPLOYED_CASH';
}

export interface SipProjectionPoint {
  year: number;
  investedAmount: number;
  projectedCorpus: number;
  wealthGained: number;
}

export interface SipProjectionSummary {
  monthlySipINR: number;
  stepUpPercent: number;
  expectedCagrPercent: number;
  durationYears: number;
  totalInvestedINR: number;
  finalCorpusINR: number;
  totalWealthGainedINR: number;
  inflationAdjustedCorpusINR: number;
  yearlyBreakdown: SipProjectionPoint[];
}

/**
 * Computes institutional quantitative risk metrics (Parametric 95%/99% Value at Risk,
 * Basel 10-Day VaR, Sharpe Ratio, Sortino Ratio, and Herfindahl-Hirschman Concentration Index)
 * grounded in the portfolio's open FIFO holdings and instrument volatilities.
 */
export function computeQuantRiskMetrics(portfolio: PortfolioSnapshot): QuantRiskMetrics {
  const holdings: HoldingPosition[] = portfolio.holdings;
  const invested = portfolio.holdingsMarketValue;

  if (holdings.length === 0 || invested <= 0) {
    return {
      dailyVolatilityPercent: 0,
      annualizedVolatilityPercent: 0,
      var95DailyINR: 0,
      var99DailyINR: 0,
      var95TenDayINR: 0,
      sharpeRatio: 0,
      sortinoRatio: 0,
      hhiConcentrationIndex: 0,
      diversificationScore: 100,
      maxDrawdownEstimatePercent: 0,
      riskGrade: 'UNDEPLOYED_CASH',
    };
  }

  // Compute weighted daily volatility and Herfindahl-Hirschman Index (HHI = sum of squared weights)
  let weightedDailyVol = 0;
  let downsideDailyVol = 0;
  let hhiSum = 0;

  for (const h of holdings) {
    const meta = SYMBOL_MAP.get(h.symbol);
    // Base daily volatility (~1.2% to 2.8% for Indian equities)
    const instrumentDailyVol = meta ? Math.max(0.008, meta.volatility * 6.5) : 0.016;
    const weight = h.weightPercent / 100;

    weightedDailyVol += weight * instrumentDailyVol;
    downsideDailyVol += weight * instrumentDailyVol * (h.beta > 1.2 ? 0.82 : 0.68);
    hhiSum += h.weightPercent * h.weightPercent;
  }

  // Diversification benefit factor based on holding count (correlation dampener)
  const correlationFactor = Math.max(0.68, 1 - Math.min(0.32, (holdings.length - 1) * 0.045));
  const portfolioDailyVol = weightedDailyVol * correlationFactor;
  const portfolioDownsideAnnualVol = downsideDailyVol * correlationFactor * Math.sqrt(252);

  // 252 NSE/BSE trading days per year
  const annualizedVol = portfolioDailyVol * Math.sqrt(252);

  // Parametric Value at Risk (VaR):
  // 95% confidence z-score = 1.64485, 99% confidence z-score = 2.32635
  const var95DailyINR = Number((invested * portfolioDailyVol * 1.64485).toFixed(2));
  const var99DailyINR = Number((invested * portfolioDailyVol * 2.32635).toFixed(2));
  const var95TenDayINR = Number((var95DailyINR * Math.sqrt(10)).toFixed(2));

  // India 10-Year Sovereign G-Sec Risk-Free Rate = 6.80% (0.068)
  // Expected Equity Risk Premium = 6.50% * portfolioBeta + realized/unrealized alpha tilt
  const riskFreeRate = 0.068;
  const pnlAlpha = Math.max(-0.04, Math.min(0.08, (portfolio.totalUnrealizedPnlPercent / 100) * 0.35));
  const expectedAnnualReturn = riskFreeRate + Math.max(0.4, portfolio.portfolioBeta) * 0.068 + pnlAlpha;

  const sharpeRatio =
    annualizedVol > 0
      ? Number(((expectedAnnualReturn - riskFreeRate) / annualizedVol).toFixed(2))
      : 0;

  const sortinoRatio =
    portfolioDownsideAnnualVol > 0
      ? Number(((expectedAnnualReturn - riskFreeRate) / portfolioDownsideAnnualVol).toFixed(2))
      : 0;

  const hhiConcentrationIndex = Math.round(hhiSum);
  const diversificationScore = Math.max(
    10,
    Math.min(98, Math.round(100 - (hhiConcentrationIndex / 10000) * 85))
  );

  const maxDrawdownEstimatePercent = Number((annualizedVol * 100 * 1.45).toFixed(2));

  let riskGrade: QuantRiskMetrics['riskGrade'] = 'BALANCED_GROWTH';
  if (portfolio.portfolioBeta > 1.3 || hhiConcentrationIndex > 4500) {
    riskGrade = 'HIGH_BETA_AGGRESSIVE';
  } else if (portfolio.portfolioBeta <= 1.05 && diversificationScore >= 65) {
    riskGrade = 'INSTITUTIONAL_HEDGED';
  }

  return {
    dailyVolatilityPercent: Number((portfolioDailyVol * 100).toFixed(2)),
    annualizedVolatilityPercent: Number((annualizedVol * 100).toFixed(2)),
    var95DailyINR,
    var99DailyINR,
    var95TenDayINR,
    sharpeRatio,
    sortinoRatio,
    hhiConcentrationIndex,
    diversificationScore,
    maxDrawdownEstimatePercent,
    riskGrade,
  };
}

/**
 * Computes multi-year Indian Step-Up SIP (Systematic Investment Plan) compounding projections
 * with 6% CPI inflation adjustment.
 */
export function computeStepUpSipProjection(
  monthlySipINR: number,
  stepUpPercent: number,
  expectedCagrPercent: number,
  durationYears: number
): SipProjectionSummary {
  const cleanMonthly = Math.max(500, monthlySipINR || 10000);
  const cleanStepUp = Math.max(0, Math.min(50, stepUpPercent || 0));
  const cleanCagr = Math.max(1, Math.min(35, expectedCagrPercent || 14));
  const cleanYears = Math.max(1, Math.min(40, Math.round(durationYears || 10)));

  const monthlyRate = cleanCagr / 100 / 12;
  let currentMonthlySip = cleanMonthly;
  let totalInvested = 0;
  let corpus = 0;
  const yearlyBreakdown: SipProjectionPoint[] = [];

  for (let year = 1; year <= cleanYears; year++) {
    for (let month = 1; month <= 12; month++) {
      totalInvested += currentMonthlySip;
      corpus = (corpus + currentMonthlySip) * (1 + monthlyRate);
    }
    yearlyBreakdown.push({
      year,
      investedAmount: Math.round(totalInvested),
      projectedCorpus: Math.round(corpus),
      wealthGained: Math.round(corpus - totalInvested),
    });
    currentMonthlySip = currentMonthlySip * (1 + cleanStepUp / 100);
  }

  const finalCorpusINR = Math.round(corpus);
  const totalInvestedINR = Math.round(totalInvested);
  const totalWealthGainedINR = finalCorpusINR - totalInvestedINR;
  // Discount by 6% average Indian CPI inflation
  const inflationAdjustedCorpusINR = Math.round(
    finalCorpusINR / Math.pow(1 + 0.06, cleanYears)
  );

  return {
    monthlySipINR: cleanMonthly,
    stepUpPercent: cleanStepUp,
    expectedCagrPercent: cleanCagr,
    durationYears: cleanYears,
    totalInvestedINR,
    finalCorpusINR,
    totalWealthGainedINR,
    inflationAdjustedCorpusINR,
    yearlyBreakdown,
  };
}
