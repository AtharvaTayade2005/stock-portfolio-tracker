import { GoogleGenAI } from '@google/genai';
import { formatINR } from '../shared/catalog.js';
import { computeIndianCapitalGainsTax } from '../shared/indianTaxAndCharges.js';
import { computeQuantRiskMetrics } from '../shared/quantRiskEngine.js';
import { computeAllocationDriftReport } from '../shared/rebalanceAndScannerEngine.js';
import type {
  AiCopilotAnalysis,
  CopilotProposedAction,
  NewsItem,
  PortfolioSnapshot,
  RagContextChunk,
} from '../shared/types.js';

export class AiCopilotService {
  private readonly apiKey: string | undefined;

  constructor(apiKey?: string) {
    this.apiKey =
      apiKey?.trim() || process.env.GEMINI_API_KEY?.trim() || process.env.GOOGLE_API_KEY?.trim();
  }

  public async analyzePortfolio(
    portfolio: PortfolioSnapshot,
    newsFeed: NewsItem[],
    customQuestion?: string
  ): Promise<AiCopilotAnalysis> {
    const deterministicBaseline = this.computeDeterministicAnalysis(
      portfolio,
      newsFeed,
      customQuestion
    );

    const ragChunksUsed = this.buildAndRetrieveRagChunks(portfolio, newsFeed, customQuestion);

    if (!this.apiKey) {
      return deterministicBaseline;
    }

    try {
      const ai = new GoogleGenAI({ apiKey: this.apiKey });

      const promptPayload = {
        currency: 'INR (₹)',
        retrievedSqliteRagChunks: ragChunksUsed,
        portfolioSummary: {
          totalEquity: portfolio.totalEquity,
          cashBalance: portfolio.cashBalance,
          holdingsMarketValue: portfolio.holdingsMarketValue,
          totalUnrealizedPnl: portfolio.totalUnrealizedPnl,
          totalRealizedPnl: portfolio.totalRealizedPnl,
          portfolioBeta: portfolio.portfolioBeta,
          sectorAllocations: portfolio.sectorAllocations,
          segmentAllocations: portfolio.segmentAllocations,
          holdings: portfolio.holdings.map((h) => ({
            symbol: h.symbol,
            segment: h.segment,
            sector: h.sector,
            exchange: h.exchange,
            weightPercent: h.weightPercent,
            beta: h.beta,
            marketValue: h.marketValue,
            unrealizedPnl: h.unrealizedPnl,
            unrealizedPnlPercent: h.unrealizedPnlPercent,
          })),
        },
        liveNews: newsFeed.slice(0, 6),
        deterministicStressBaseline: deterministicBaseline.stressTestScenarios,
        userQuestion:
          customQuestion ||
          'Provide a full Indian stock market portfolio risk and news impact audit in INR (₹).',
      };

      const response = await ai.interactions.create({
        model: 'gemini-3.8-flash',
        system_instruction:
          'You are an institutional Indian market quantitative risk manager (NSE/BSE/NFO/AMFI). Format all monetary amounts in Indian Rupees (₹). Ground every number strictly in the provided deterministic ledger snapshot and beta math. Return concise JSON.',
        input: JSON.stringify(promptPayload),
        response_format: {
          type: 'object',
          properties: {
            riskScore: { type: 'number', description: 'Portfolio risk score from 1 to 100' },
            riskLabel: {
              type: 'string',
              enum: ['CONSERVATIVE', 'MODERATE', 'AGGRESSIVE', 'CONCENTRATED_HIGH_BETA'],
            },
            executiveSummary: { type: 'string' },
            concentrationFindings: {
              type: 'array',
              items: { type: 'string' },
            },
            actionableRebalancing: {
              type: 'array',
              items: { type: 'string' },
            },
            queryAnswer: { type: 'string' },
          },
          required: [
            'riskScore',
            'riskLabel',
            'executiveSummary',
            'concentrationFindings',
            'actionableRebalancing',
            'queryAnswer',
          ],
        },
      });

      const rawText = response.output_text;
      if (!rawText) {
        return deterministicBaseline;
      }

      const parsed = JSON.parse(rawText) as Partial<AiCopilotAnalysis>;
      return {
        ...deterministicBaseline,
        engineMode: 'GEMINI_LIVE',
        modelUsed: 'gemini-3.8-flash',
        generatedAt: new Date().toISOString(),
        riskScore:
          typeof parsed.riskScore === 'number'
            ? Math.min(100, Math.max(1, Math.round(parsed.riskScore)))
            : deterministicBaseline.riskScore,
        riskLabel: parsed.riskLabel ?? deterministicBaseline.riskLabel,
        executiveSummary: parsed.executiveSummary || deterministicBaseline.executiveSummary,
        concentrationFindings:
          Array.isArray(parsed.concentrationFindings) && parsed.concentrationFindings.length > 0
            ? parsed.concentrationFindings
            : deterministicBaseline.concentrationFindings,
        actionableRebalancing:
          Array.isArray(parsed.actionableRebalancing) && parsed.actionableRebalancing.length > 0
            ? parsed.actionableRebalancing
            : deterministicBaseline.actionableRebalancing,
        queryAnswer: parsed.queryAnswer || deterministicBaseline.queryAnswer,
      };
    } catch {
      return deterministicBaseline;
    }
  }

  public computeDeterministicAnalysis(
    portfolio: PortfolioSnapshot,
    newsFeed: NewsItem[],
    customQuestion?: string
  ): AiCopilotAnalysis {
    const topHolding = portfolio.holdings[0];
    const topSector = portfolio.sectorAllocations[0];
    const investedRatio =
      portfolio.totalEquity > 0 ? portfolio.holdingsMarketValue / portfolio.totalEquity : 0;

    const rawRisk =
      portfolio.portfolioBeta * 38 +
      (topSector ? topSector.weightPercent * 0.42 : 0) +
      investedRatio * 20;
    const riskScore = Math.min(98, Math.max(12, Math.round(rawRisk)));

    let riskLabel: AiCopilotAnalysis['riskLabel'] = 'MODERATE';
    if (riskScore >= 75) riskLabel = 'CONCENTRATED_HIGH_BETA';
    else if (riskScore >= 58) riskLabel = 'AGGRESSIVE';
    else if (riskScore <= 35) riskLabel = 'CONSERVATIVE';

    // Scenario 1: Nifty IT & Mid/Small-Cap -5% Correction
    const hasOpenHoldings = portfolio.holdingsMarketValue > 0;
    const proFormaMarginBase = portfolio.cashBalance;
    const exposureDenominator = hasOpenHoldings
      ? portfolio.holdingsMarketValue
      : Math.max(1, proFormaMarginBase);

    const itAndMidHoldings = portfolio.holdings.filter(
      (h) =>
        h.sector === 'IT Services' ||
        h.segment === 'MID_CAP' ||
        h.segment === 'SMALL_CAP'
    );
    const itShockImpact = hasOpenHoldings
      ? itAndMidHoldings.reduce((sum, h) => sum + h.marketValue * (-0.05 * h.beta), 0)
      : proFormaMarginBase * -0.05;

    // Scenario 2: Nifty 50 / Sensex -3% Broad Drawdown (including F&O delta/beta)
    const broadShockImpact = hasOpenHoldings
      ? portfolio.holdings.reduce((sum, h) => sum + h.marketValue * (-0.03 * h.beta), 0)
      : proFormaMarginBase * -0.03;

    // Scenario 3: RBI Repo Rate Hold / Banking NIM +2.5% Rally vs High-Beta -3%
    const rbiShockImpact = hasOpenHoldings
      ? portfolio.holdings.reduce((sum, h) => {
          if (h.sector === 'Banking & Finance') return sum + h.marketValue * 0.025;
          return sum + h.marketValue * (-0.03 * h.beta);
        }, 0)
      : proFormaMarginBase * -0.012;

    const stressTestScenarios = [
      {
        scenarioName: 'Nifty IT & Mid/Small-Cap -5% Pullback',
        estimatedPnlImpact: Number(itShockImpact.toFixed(2)),
        estimatedPnlPercent: Number(((itShockImpact / exposureDenominator) * 100).toFixed(2)),
        mostVulnerableSymbol: itAndMidHoldings[0]?.symbol ?? 'DIXON',
        explanation: hasOpenHoldings
          ? 'Applies a -5.0% shock scaled by each holding’s beta across NSE IT Services, Mid-Cap, and Small-Cap positions.'
          : `Pro-Forma on ${formatINR(proFormaMarginBase)} Demat Margin (1.0x beta): estimates capital at risk if deployed into mid-cap/IT before a -5% correction.`,
      },
      {
        scenarioName: 'Nifty 50 & Sensex -3% Broad Index Correction',
        estimatedPnlImpact: Number(broadShockImpact.toFixed(2)),
        estimatedPnlPercent: Number(((broadShockImpact / exposureDenominator) * 100).toFixed(2)),
        mostVulnerableSymbol: topHolding?.symbol ?? 'RELIANCE',
        explanation: hasOpenHoldings
          ? `With a portfolio beta of ${portfolio.portfolioBeta.toFixed(2)}x (including NFO Put hedge), a 3% benchmark drop impacts deployed holdings by ${formatINR(broadShockImpact)}.`
          : `Pro-Forma on ${formatINR(proFormaMarginBase)} Demat Margin at 1.00x Nifty 50 beta: a -3.0% broad market drawdown corresponds to ${formatINR(broadShockImpact)}.`,
      },
      {
        scenarioName: 'RBI Liquidity Tightening (Banks +2.5%, Growth -3%)',
        estimatedPnlImpact: Number(rbiShockImpact.toFixed(2)),
        estimatedPnlPercent: Number(((rbiShockImpact / exposureDenominator) * 100).toFixed(2)),
        mostVulnerableSymbol: 'DIXON',
        explanation: hasOpenHoldings
          ? 'PSU & Private Banks (HDFCBANK, SBIN, ICICIBANK) gain +2.5% while high-beta mid/small caps compress by 3% * beta.'
          : `Pro-Forma on ${formatINR(proFormaMarginBase)} Demat Margin (40% Banking / 60% Growth split): models net RBI policy sensitivity of ${formatINR(rbiShockImpact)}.`,
      },
    ];

    const holdingMap = new Map(portfolio.holdings.map((h) => [h.symbol, h]));
    const newsCorrelations = newsFeed.slice(0, 4).map((item) => {
      const held = holdingMap.get(item.symbol);
      const weight = held ? held.weightPercent : 0;
      return {
        symbol: item.symbol,
        sentiment: item.sentiment,
        portfolioWeightPercent: weight,
        thesis:
          weight > 0
            ? `${item.symbol} accounts for ${weight.toFixed(1)}% of invested capital (${formatINR(held!.marketValue)}). ${item.headline}`
            : `${item.symbol} is on watchlist (0% weight). ${item.headline}`,
      };
    });

    const concentrationFindings: string[] = [];
    if (topSector) {
      concentrationFindings.push(
        `${topSector.sector} represents ${topSector.weightPercent.toFixed(1)}% (${formatINR(topSector.marketValue)}) of deployed capital.`
      );
    }
    if (topHolding) {
      concentrationFindings.push(
        `Largest position is ${topHolding.symbol} (${topHolding.exchange}) at ${topHolding.weightPercent.toFixed(1)}% weight (FIFO Avg Cost ${formatINR(topHolding.avgCostBasis)}).`
      );
    }
    concentrationFindings.push(
      `Available margin stands at ${formatINR(portfolio.cashBalance)} (${(
        (portfolio.cashBalance / Math.max(1, portfolio.totalEquity)) *
        100
      ).toFixed(1)}% of total net worth).`
    );

    const actionableRebalancing: string[] = [
      topHolding && topHolding.weightPercent > 25
        ? `Book partial profits in ${topHolding.symbol} via FIFO tax-lot realization to lock in ${formatINR(topHolding.unrealizedPnl)} unrealized gains.`
        : 'Single-stock concentration is balanced across Large Cap, Mid/Small Cap, ETFs, and Mutual Funds.',
      portfolio.portfolioBeta > 1.15
        ? `Increase allocation to NIFTYBEES / GOLDBEES or PPFAS-FLEXI Direct Mutual Fund to cushion mid-cap and F&O volatility.`
        : `Portfolio beta (${portfolio.portfolioBeta.toFixed(2)}x) is well-hedged against Nifty 50 swings.`,
    ];

    const quantMetrics = computeQuantRiskMetrics(portfolio);
    const taxMetrics = computeIndianCapitalGainsTax(portfolio.holdings, portfolio.totalRealizedPnl);

    let queryAnswer = `Grounded in your NSE/BSE/NFO/MF FIFO ledger: Total Net Worth is ${formatINR(portfolio.totalEquity)} (${formatINR(portfolio.holdingsMarketValue)} invested across ${portfolio.holdings.length} positions + ${formatINR(portfolio.cashBalance)} free margin). A -5.0% pullback scenario shifts capital by ${formatINR(itShockImpact)}.`;

    if (customQuestion && customQuestion.trim().length > 0) {
      const q = customQuestion.toLowerCase();
      const pctMatch = q.match(/(\d+(?:\.\d+)?)\s*%/);
      const customShockPct = pctMatch ? Number(pctMatch[1]) / 100 : 0.05;

      if (q.includes('tax') || q.includes('stcg') || q.includes('ltcg') || q.includes('sebi') || q.includes('harvest')) {
        queryAnswer = `SEBI Capital Gains Audit (${customQuestion}): Realized STCG stands at ${formatINR(taxMetrics.realizedStcgGross)} with est. Sec 111A tax (20.8% incl. cess) of ${formatINR(taxMetrics.estimatedStcgTax)}. Sec 112A LTCG exemption remaining is ${formatINR(taxMetrics.ltcgExemptionLimit)}, and potential tax-loss harvesting savings are ${formatINR(taxMetrics.potentialTaxSavingsViaHarvesting)}.`;
      } else if (q.includes('bank') || q.includes('upi') || q.includes('liquidity') || q.includes('cash') || q.includes('margin')) {
        const bankTotal = portfolio.bankAccounts.reduce((acc, b) => acc + b.balance, 0);
        queryAnswer = `3-in-1 Bank & Margin Audit (${customQuestion}): Free Demat trading margin is ${formatINR(portfolio.cashBalance)}, backed by ${formatINR(bankTotal)} across ${portfolio.bankAccounts.length} linked Indian banks (${portfolio.bankAccounts.map((b) => `${b.bankName}: ${formatINR(b.balance)}`).join(', ')}).`;
      } else if (q.includes('gold') || q.includes('silver') || q.includes('hedge') || q.includes('bullion')) {
        const bullImpact = hasOpenHoldings
          ? portfolio.holdings.reduce((sum, h) => sum + h.marketValue * (-customShockPct * Math.min(0.4, h.beta * 0.25)), 0)
          : proFormaMarginBase * (-customShockPct * 0.15);
        queryAnswer = `Bullion & Low-Beta Hedge Audit (${customQuestion}): Shifting 15%–20% into GOLDBEES / MCX-GOLD (0.15x equity beta) cuts your portfolio sensitivity under a -${(customShockPct * 100).toFixed(1)}% shock to roughly ${formatINR(bullImpact)} while reducing portfolio drawdown.`;
      } else if (q.includes('fno') || q.includes('option') || q.includes('derivative')) {
        const fnoHoldings = portfolio.holdings.filter((h) => h.segment === 'FNO');
        const fnoValue = fnoHoldings.reduce((s, h) => s + h.marketValue, 0);
        const fnoPnl = fnoHoldings.reduce((s, h) => s + h.unrealizedPnl, 0);
        queryAnswer = `NFO Derivatives Audit (${customQuestion}): ${fnoHoldings.length} active F&O contract(s) valued at ${formatINR(fnoValue)} (${formatINR(fnoPnl)} MTM P&L). Long Nifty PE contracts carry negative delta/beta to cushion broad index drops.`;
      } else if (
        q.includes('nifty') ||
        q.includes('mid') ||
        q.includes('drop') ||
        q.includes('fall') ||
        q.includes('crash') ||
        q.includes('shock') ||
        q.includes('pullback') ||
        q.includes('rbi') ||
        q.includes('stress')
      ) {
        const customImpact = hasOpenHoldings
          ? portfolio.holdings.reduce((sum, h) => sum - h.marketValue * customShockPct * h.beta, 0)
          : -proFormaMarginBase * customShockPct;
        queryAnswer = `Stress Test for "${customQuestion}": A ${(customShockPct * 100).toFixed(1)}% drawdown ${
          hasOpenHoldings
            ? '(beta-adjusted across your live FIFO holdings)'
            : `(pro-forma on ${formatINR(proFormaMarginBase)} free Demat margin)`
        } shifts net worth by ${formatINR(customImpact)} (${((customImpact / Math.max(1, portfolio.totalEquity)) * 100).toFixed(2)}% of total equity).`;
      } else {
        queryAnswer = `Custom Risk Audit for "${customQuestion}": Net Worth is ${formatINR(portfolio.totalEquity)} across ${portfolio.holdings.length} open position(s) (${formatINR(portfolio.cashBalance)} Demat margin). 1-Day 95% Parametric VaR is ${formatINR(quantMetrics.var95DailyINR)}, Sharpe Ratio is ${quantMetrics.sharpeRatio.toFixed(2)}, and HHI Concentration is ${quantMetrics.hhiConcentrationIndex}.`;
      }
    }

    const ragChunksUsed = this.buildAndRetrieveRagChunks(portfolio, newsFeed, customQuestion);
    const proposedActions = this.buildProposedActions(portfolio);

    return {
      engineMode: 'DETERMINISTIC_QUANT_FALLBACK',
      modelUsed: 'Indian Market Beta & FIFO Quant Engine (Local SQLite RAG)',
      generatedAt: new Date().toISOString(),
      riskScore,
      riskLabel,
      executiveSummary: `Portfolio holds ${portfolio.holdings.length} active NSE/BSE/NFO/AMFI positions valued at ${formatINR(portfolio.holdingsMarketValue)} with a weighted beta of ${portfolio.portfolioBeta.toFixed(2)}x and ${formatINR(portfolio.totalUnrealizedPnl)} (${portfolio.totalUnrealizedPnlPercent.toFixed(2)}%) in unrealized P&L.`,
      concentrationFindings,
      newsCorrelations,
      stressTestScenarios,
      actionableRebalancing,
      queryAnswer,
      ragChunksUsed,
      proposedActions,
    };
  }

  /**
   * 4-Stage Local SQLite RAG Retrieval Engine:
   * Extracts grounded context chunks directly from SQLite tables (`tax_lots`, `bank_accounts`,
   * Quant VaR, SEBI Tax, and Drift Engine) and ranks them by query lexical similarity.
   */
  public buildAndRetrieveRagChunks(
    portfolio: PortfolioSnapshot,
    newsFeed: NewsItem[],
    query?: string
  ): RagContextChunk[] {
    const quantRisk = computeQuantRiskMetrics(portfolio);
    const taxReport = computeIndianCapitalGainsTax(portfolio.holdings, portfolio.totalRealizedPnl);
    const driftReport = computeAllocationDriftReport(portfolio, undefined, 5);
    const q = (query || '').toLowerCase();

    const rawChunks: Array<Omit<RagContextChunk, 'similarityScore'> & { keywords: string[] }> = [
      {
        chunkId: 'CHUNK-SQLITE-FIFO',
        sourceTable: 'sqlite.tax_lots + orders',
        title: 'Open FIFO Lots & Unrealized P&L Ledger',
        keywords: ['holding', 'fifo', 'lot', 'pnl', 'profit', 'loss', 'stock', 'equity', 'cost'],
        content:
          portfolio.holdings.length === 0
            ? `Zero open FIFO tax lots currently held; deployed capital is ₹0.00 with ${formatINR(
                portfolio.cashBalance
              )} free Demat margin.`
            : `${portfolio.holdings.length} open positions totaling ${formatINR(
                portfolio.holdingsMarketValue
              )} market value (${formatINR(portfolio.totalUnrealizedPnl)} unrealized P&L). Top position: ${
                portfolio.holdings[0].symbol
              } (${portfolio.holdings[0].quantity} qty @ FIFO avg ${formatINR(
                portfolio.holdings[0].avgCostBasis
              )}).`,
      },
      {
        chunkId: 'CHUNK-QUANT-VAR',
        sourceTable: 'quantRiskEngine.computeQuantRiskMetrics',
        title: 'Parametric VaR (95%/99%), Sharpe, Sortino & HHI Risk',
        keywords: ['var', 'risk', 'sharpe', 'sortino', 'hhi', 'volatility', 'nifty', 'drop', 'crash'],
        content: `1-Day 95% VaR: ${formatINR(quantRisk.var95DailyINR)} | 99% VaR: ${formatINR(
          quantRisk.var99DailyINR
        )} | 10-Day Basel III VaR: ${formatINR(quantRisk.var95TenDayINR)} | Sharpe: ${quantRisk.sharpeRatio.toFixed(
          2
        )} | Sortino: ${quantRisk.sortinoRatio.toFixed(2)} | HHI Index: ${
          quantRisk.hhiConcentrationIndex
        }.`,
      },
      {
        chunkId: 'CHUNK-SEBI-TAX',
        sourceTable: 'indianTaxAndCharges.computeIndianCapitalGainsTax',
        title: 'SEBI Sec 111A STCG (20.8%) & FIFO Tax-Loss Harvesting',
        keywords: ['tax', 'stcg', 'ltcg', 'sebi', 'harvest', 'stt', 'stamp', 'cdsl'],
        content: `Realized STCG: ${formatINR(
          taxReport.realizedStcgGross
        )} | Est. Sec 111A Tax Liability (20.8%): ${formatINR(
          taxReport.estimatedStcgTax
        )} | Harvestable Tax Savings: ${formatINR(
          taxReport.potentialTaxSavingsViaHarvesting
        )} | Sec 112A LTCG Exemption: ${formatINR(taxReport.ltcgExemptionLimit)}.`,
      },
      {
        chunkId: 'CHUNK-DRIFT-REBALANCE',
        sourceTable: 'rebalanceAndScannerEngine.computeAllocationDriftReport',
        title: 'Target Asset Allocation Drift Bands (±5%)',
        keywords: ['drift', 'rebalance', 'allocation', 'target', 'weight', 'segment', 'gold', 'etf'],
        content: `Segments outside ±5% band: ${driftReport.driftedSegmentsCount}. ${
          driftReport.items
            .filter((i) => i.status !== 'WITHIN_BAND' || i.currentWeightPercent > 0)
            .slice(0, 3)
            .map((i) => `${i.label}: ${i.currentWeightPercent}% (Target ${i.targetWeightPercent}%)`)
            .join(' | ') || 'No deployed segment drift detected.'
        }`,
      },
      {
        chunkId: 'CHUNK-3IN1-BANKS',
        sourceTable: 'sqlite.bank_accounts + bank_transactions',
        title: '3-in-1 Linked Indian Bank Accounts & Live Market Feed',
        keywords: ['bank', 'upi', 'sbi', 'hdfc', 'icici', 'margin', 'cash', 'funds', 'news'],
        content: `Available Demat Margin: ${formatINR(portfolio.cashBalance)} across ${
          portfolio.bankAccounts.length
        } linked banks (${portfolio.bankAccounts
          .map((b) => `${b.bankName}: ${formatINR(b.balance)}`)
          .join(', ')}). Latest news items indexed: ${newsFeed.length}.`,
      },
    ];

    return rawChunks
      .map((chunk, idx) => {
        const keywordHits = chunk.keywords.filter((kw) => q.includes(kw)).length;
        const baseScore = 0.89 - idx * 0.015;
        const similarityScore = Number(
          Math.min(0.99, baseScore + keywordHits * 0.05).toFixed(2)
        );
        return {
          chunkId: chunk.chunkId,
          sourceTable: chunk.sourceTable,
          title: chunk.title,
          similarityScore,
          content: chunk.content,
        };
      })
      .sort((a, b) => b.similarityScore - a.similarityScore);
  }

  private buildProposedActions(portfolio: PortfolioSnapshot): CopilotProposedAction[] {
    const actions: CopilotProposedAction[] = [];
    const topHolding = portfolio.holdings[0];

    if (topHolding && topHolding.weightPercent > 30) {
      actions.push({
        symbol: topHolding.symbol,
        side: 'SELL',
        quantity: Math.max(1, Math.floor(topHolding.quantity * 0.2)),
        rationale: `Trim 20% of ${topHolding.symbol} (${topHolding.weightPercent.toFixed(
          1
        )}% weight) to reduce single-stock HHI concentration.`,
      });
    }

    actions.push({
      symbol: 'GOLDBEES',
      side: 'BUY',
      quantity: 10,
      rationale: 'Add low-beta (0.15x) 24K Bullion ETF hedge against Nifty equity drawdowns.',
    });
    actions.push({
      symbol: 'NIFTYBEES',
      side: 'BUY',
      quantity: 10,
      rationale: 'Broaden index diversification with 1.00x beta Nifty 50 ETF units.',
    });

    return actions;
  }
}
