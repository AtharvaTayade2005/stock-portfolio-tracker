import type {
  HoldingPosition,
  InstrumentSegment,
  MarketExchange,
  MarketTick,
  OrderSide,
} from './types.js';

export interface StatutoryChargesBreakdown {
  notionalTurnover: number;
  brokerage: number;
  stt: number; // Securities Transaction Tax
  exchangeTxnCharge: number; // NSE / BSE / NFO transaction charge
  sebiTurnoverFee: number; // ₹10 per Crore (0.0001%)
  stampDuty: number; // State Stamp Duty on BUY orders
  dpCharge: number; // CDSL / NSDL Depository Participant charge on Delivery SELL (₹15.93)
  gst: number; // 18% GST on (Brokerage + Exchange Charge + SEBI Fee)
  totalCharges: number;
  netSettlementAmount: number; // Total debit on BUY, or net credit on SELL
  breakevenPointsPerUnit: number;
}

export interface TaxHarvestCandidate {
  symbol: string;
  name: string;
  quantity: number;
  avgCostBasis: number;
  currentPrice: number;
  unrealizedLoss: number;
  potentialStcgTaxSaved: number; // 20.8% (20% STCG + 4% cess)
}

export interface CapitalGainsTaxReport {
  realizedStcgGross: number;
  estimatedStcgTax: number; // 20% + 4% Cess = 20.8% under Sec 111A
  unrealizedGainsTotal: number;
  unrealizedLossesTotal: number;
  netTaxableStcgAfterHarvesting: number;
  potentialTaxSavingsViaHarvesting: number;
  ltcgExemptionLimit: number; // ₹1,25,000 under Sec 112A
  harvestCandidates: TaxHarvestCandidate[];
}

export interface DepthLevel {
  price: number;
  orders: number;
  quantity: number;
}

export interface MarketDepthBook {
  bids: DepthLevel[];
  asks: DepthLevel[];
  totalBidQty: number;
  totalAskQty: number;
  buyPressurePercent: number;
  sellPressurePercent: number;
}

/**
 * Computes exact Indian statutory charges (STT, NSE/BSE Transaction Charges, SEBI Turnover Fee,
 * Stamp Duty, CDSL DP Charges, and 18% GST) for a given trade.
 */
export function calculateIndianStatutoryCharges(
  side: OrderSide,
  segment: InstrumentSegment,
  exchange: MarketExchange,
  quantity: number,
  price: number
): StatutoryChargesBreakdown {
  const notionalTurnover = Number((quantity * price).toFixed(2));
  if (notionalTurnover <= 0 || quantity <= 0) {
    return {
      notionalTurnover: 0,
      brokerage: 0,
      stt: 0,
      exchangeTxnCharge: 0,
      sebiTurnoverFee: 0,
      stampDuty: 0,
      dpCharge: 0,
      gst: 0,
      totalCharges: 0,
      netSettlementAmount: 0,
      breakevenPointsPerUnit: 0,
    };
  }

  // Zero brokerage on Equity Delivery, ETFs, and Direct Mutual Funds; flat ₹20 on F&O and MCX Commodity orders
  const brokerage = segment === 'FNO' || exchange === 'MCX' ? 20.0 : 0.0;

  // 1. Securities / Commodity Transaction Tax (STT / CTT)
  let stt = 0;
  if (exchange === 'MCX') {
    stt = side === 'SELL' ? notionalTurnover * 0.0001 : 0; // 0.01% CTT on MCX Commodity sell
  } else if (segment === 'FNO') {
    stt = side === 'SELL' ? notionalTurnover * 0.000625 : 0; // 0.0625% on F&O options/futures sell
  } else if (segment === 'MUTUAL_FUND') {
    stt = side === 'SELL' ? notionalTurnover * 0.00001 : 0; // 0.001% on equity MF redemption
  } else if (segment === 'ETF') {
    stt = side === 'SELL' ? notionalTurnover * 0.00001 : 0;
  } else {
    // Equity Delivery (LARGE_CAP / MID_CAP / SMALL_CAP / COMMODITY stocks): 0.1% on both BUY and SELL
    stt = notionalTurnover * 0.001;
  }
  stt = Number(stt.toFixed(2));

  // 2. Exchange Transaction Charges (NSE: 0.00297%, BSE: 0.00375%, NFO: 0.03503%, MCX: 0.0026%, AMFI: 0%)
  let exchangeRate = 0.0000297;
  if (exchange === 'BSE') exchangeRate = 0.0000375;
  else if (exchange === 'NFO') exchangeRate = 0.0003503;
  else if (exchange === 'MCX') exchangeRate = 0.000026;
  else if (exchange === 'AMFI') exchangeRate = 0;
  const exchangeTxnCharge = Number((notionalTurnover * exchangeRate).toFixed(2));

  // 3. SEBI Turnover Fees: ₹10 per Crore (0.0001%)
  const sebiTurnoverFee = Number((notionalTurnover * 0.000001).toFixed(2));

  // 4. Stamp Duty (charged only on BUY orders)
  let stampDuty = 0;
  if (side === 'BUY') {
    if (segment === 'FNO') stampDuty = notionalTurnover * 0.00003; // 0.003%
    else if (segment === 'MUTUAL_FUND') stampDuty = notionalTurnover * 0.00005; // 0.005%
    else stampDuty = notionalTurnover * 0.00015; // 0.015% on Equity Delivery Buy
  }
  stampDuty = Number(stampDuty.toFixed(2));

  // 5. CDSL / NSDL Depository Participant (DP) Charge: ₹15.93 (₹13.50 + 18% GST) on Equity Delivery SELL
  const isEquityDelivery =
    segment === 'LARGE_CAP' || segment === 'MID_CAP' || segment === 'SMALL_CAP';
  const dpCharge = side === 'SELL' && isEquityDelivery ? 15.93 : 0;

  // 6. GST @ 18% on (Brokerage + Exchange Transaction Charge + SEBI Fee)
  const gst = Number(((brokerage + exchangeTxnCharge + sebiTurnoverFee) * 0.18).toFixed(2));

  const totalCharges = Number(
    (brokerage + stt + exchangeTxnCharge + sebiTurnoverFee + stampDuty + dpCharge + gst).toFixed(2)
  );

  const netSettlementAmount =
    side === 'BUY'
      ? Number((notionalTurnover + totalCharges).toFixed(2))
      : Number(Math.max(0, notionalTurnover - totalCharges).toFixed(2));

  const breakevenPointsPerUnit = Number(((totalCharges * 2) / Math.max(1, quantity)).toFixed(2));

  return {
    notionalTurnover,
    brokerage,
    stt,
    exchangeTxnCharge,
    sebiTurnoverFee,
    stampDuty,
    dpCharge,
    gst,
    totalCharges,
    netSettlementAmount,
    breakevenPointsPerUnit,
  };
}

/**
 * Computes Indian Short-Term Capital Gains (STCG @ 20% under Sec 111A + 4% Cess = 20.8%),
 * LTCG exemption parameters (Sec 112A ₹1.25L), and Tax-Loss Harvesting candidates across open lots.
 */
export function computeIndianCapitalGainsTax(
  holdings: HoldingPosition[],
  realizedPnl: number
): CapitalGainsTaxReport {
  const STCG_EFFECTIVE_RATE = 0.208; // 20% base STCG + 4% Health & Education Cess
  const LTCG_EXEMPTION_LIMIT = 125000; // ₹1,25,000 per FY under Union Budget Sec 112A

  const realizedStcgGross = Math.max(0, Number(realizedPnl.toFixed(2)));
  const estimatedStcgTax = Number((realizedStcgGross * STCG_EFFECTIVE_RATE).toFixed(2));

  let unrealizedGainsTotal = 0;
  let unrealizedLossesTotal = 0;
  const harvestCandidates: TaxHarvestCandidate[] = [];

  for (const h of holdings) {
    if (h.unrealizedPnl >= 0) {
      unrealizedGainsTotal += h.unrealizedPnl;
    } else {
      const absLoss = Math.abs(h.unrealizedPnl);
      unrealizedLossesTotal += absLoss;
      harvestCandidates.push({
        symbol: h.symbol,
        name: h.name,
        quantity: h.quantity,
        avgCostBasis: h.avgCostBasis,
        currentPrice: h.currentPrice,
        unrealizedLoss: Number(absLoss.toFixed(2)),
        potentialStcgTaxSaved: Number((absLoss * STCG_EFFECTIVE_RATE).toFixed(2)),
      });
    }
  }

  harvestCandidates.sort((a, b) => b.unrealizedLoss - a.unrealizedLoss);

  const offsettableAmount = Math.min(
    realizedStcgGross + unrealizedGainsTotal,
    unrealizedLossesTotal
  );
  const potentialTaxSavingsViaHarvesting = Number(
    (offsettableAmount * STCG_EFFECTIVE_RATE).toFixed(2)
  );
  const netTaxableStcgAfterHarvesting = Number(
    Math.max(0, realizedStcgGross - unrealizedLossesTotal).toFixed(2)
  );

  return {
    realizedStcgGross,
    estimatedStcgTax,
    unrealizedGainsTotal: Number(unrealizedGainsTotal.toFixed(2)),
    unrealizedLossesTotal: Number(unrealizedLossesTotal.toFixed(2)),
    netTaxableStcgAfterHarvesting,
    potentialTaxSavingsViaHarvesting,
    ltcgExemptionLimit: LTCG_EXEMPTION_LIMIT,
    harvestCandidates,
  };
}

/**
 * Generates a realistic 5-Level NSE/BSE Order Book Depth Ladder (Top 5 Bids vs Top 5 Asks)
 * anchored to the live market tick price and change direction.
 */
export function generateMarketDepthLadder(tick: MarketTick | undefined, basePrice: number): MarketDepthBook {
  const price = tick?.price ?? basePrice;
  const changePct = tick?.changePercent ?? 0;
  const tickStep = price >= 1000 ? 0.5 : price >= 100 ? 0.1 : 0.05;
  const seed = Math.floor(price * 100) % 97;

  const bids: DepthLevel[] = [];
  const asks: DepthLevel[] = [];
  let totalBidQty = 0;
  let totalAskQty = 0;

  const bullBias = changePct >= 0 ? 1.35 : 0.78;
  const bearBias = changePct < 0 ? 1.35 : 0.78;

  for (let level = 0; level < 5; level++) {
    const bidPrice = Number(Math.max(0.05, price - (level + 1) * tickStep).toFixed(2));
    const askPrice = Number((price + (level + 1) * tickStep).toFixed(2));

    const bidOrders = 4 + ((seed + level * 7) % 19);
    const askOrders = 4 + ((seed + level * 11) % 19);

    const bidQty = Math.round((85 + ((seed * (level + 2)) % 340)) * bullBias);
    const askQty = Math.round((85 + ((seed * (level + 3)) % 340)) * bearBias);

    totalBidQty += bidQty;
    totalAskQty += askQty;

    bids.push({ price: bidPrice, orders: bidOrders, quantity: bidQty });
    asks.push({ price: askPrice, orders: askOrders, quantity: askQty });
  }

  const combined = Math.max(1, totalBidQty + totalAskQty);
  const buyPressurePercent = Number(((totalBidQty / combined) * 100).toFixed(1));
  const sellPressurePercent = Number((100 - buyPressurePercent).toFixed(1));

  return {
    bids,
    asks,
    totalBidQty,
    totalAskQty,
    buyPressurePercent,
    sellPressurePercent,
  };
}
