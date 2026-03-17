/**
 * Edge model subagent — estimates true probabilities and computes EV.
 *
 * Routes candidates to the appropriate edge source by market category:
 *   - crypto_15m / crypto_hourly → trend analysis (Binance data)
 *   - financial_hourly → Polymarket arbitrage
 *   - sports → sports edge (stale liquidity, momentum, odds filter)
 */

import { getConsecutiveLosses, getOpenPositions, hasRecentLoss, type TradeRecord } from "./logger.js";
import type { CandidateMarket } from "./scanner.js";
import type { PriceData } from "./price_feeds.js";
import { analyzeTrend } from "./trend_analysis.js";
import { evaluateSportsCandidate, isWithinOddsRange } from "./sports_edge.js";

const POLYMARKET_API = "https://gamma-api.polymarket.com";

// Edge source identifiers
export const SOURCE_TREND = "crypto_trend_analysis";
export const SOURCE_ARBITRAGE = "external_odds_arbitrage";

export interface TradeSignal {
  marketId: string;
  marketTitle: string;
  direction: "YES" | "NO";
  pEstimate: number;
  marketPrice: number;
  evPerDollar: number;
  edgeSource: string;
  edgeRationale: string;
}

export interface RejectedCandidate {
  marketId: string;
  marketTitle: string;
  reason: string;
}

/**
 * Compute expected value per dollar risked.
 */
export function computeEv(
  pEstimate: number,
  marketPrice: number,
  direction: "YES" | "NO",
): number {
  let price: number;
  let p: number;

  if (direction === "YES") {
    price = marketPrice;
    p = pEstimate;
  } else {
    price = 1 - marketPrice;
    p = 1 - pEstimate;
  }

  if (price <= 0 || price >= 1) return 0;

  const ev = (p * (1 - price) - (1 - p) * price) / price;
  return Math.round(ev * 1_000_000) / 1_000_000;
}

export function checkCorrelation(
  marketId: string,
  marketTitle: string,
  openPositions: TradeRecord[],
): boolean {
  for (const pos of openPositions) {
    if (pos.market_id === marketId) return true;

    const stopWords = new Set([
      "the", "a", "an", "will", "be", "to", "in", "of", "at", "on", "is",
    ]);
    const posWords = new Set(
      pos.market_title.toLowerCase().split(/\s+/).filter((w) => !stopWords.has(w)),
    );
    const newWords = new Set(
      marketTitle.toLowerCase().split(/\s+/).filter((w) => !stopWords.has(w)),
    );

    let overlap = 0;
    for (const w of posWords) {
      if (newWords.has(w)) overlap++;
    }
    if (overlap >= 3) return true;
  }
  return false;
}

// ──────────────────────── Crypto Trend Edge ────────────────────────

/**
 * Evaluate a crypto market using multi-indicator trend analysis.
 */
function evaluateCryptoTrend(
  candidate: CandidateMarket,
  edgeFloor: number,
  priceData: PriceData,
  timeframe: "15m" | "1h",
): TradeSignal | null {
  const trend = analyzeTrend(priceData, timeframe);

  if (trend.direction === "NEUTRAL") return null;

  const kalshiImpliedUp = candidate.yesPrice;

  // Skip extreme prices — our model can't reliably estimate probabilities
  // when the market is near certainty (the market has information we don't)
  if (kalshiImpliedUp > 0.85 || kalshiImpliedUp < 0.15) return null;

  let direction: "YES" | "NO";
  let pEstimate: number;

  if (trend.pUp > kalshiImpliedUp + 0.04) {
    // Trend says UP more likely than market implies
    direction = "YES";
    pEstimate = trend.pUp;
  } else if (trend.pUp < kalshiImpliedUp - 0.04) {
    // Trend says DOWN more likely — pEstimate is p(YES) which is low
    direction = "NO";
    pEstimate = trend.pUp;
  } else {
    return null; // no meaningful divergence
  }

  const ev = computeEv(pEstimate, candidate.yesPrice, direction);
  if (ev < edgeFloor) return null;

  const coinLabel = candidate.binanceSymbol?.replace("USDT", "") ?? "CRYPTO";
  const rationale =
    `${coinLabel} ${trend.rationale} ` +
    `Kalshi implied p(up)=${(kalshiImpliedUp * 100).toFixed(1)}%. ` +
    `Trading ${direction} at $${(direction === "YES" ? candidate.yesPrice : candidate.noPrice).toFixed(2)}.`;

  return {
    marketId: candidate.marketId,
    marketTitle: candidate.marketTitle,
    direction,
    pEstimate: Math.round(pEstimate * 10000) / 10000,
    marketPrice: Math.round(candidate.yesPrice * 10000) / 10000,
    evPerDollar: Math.round(ev * 10000) / 10000,
    edgeSource: SOURCE_TREND,
    edgeRationale: rationale,
  };
}

// ──────────────────────── Polymarket Arbitrage ────────────────────────

function titlesMatch(titleA: string, titleB: string): boolean {
  const stopWords = new Set(["the", "a", "an", "will", "be", "to"]);
  const wordsA = new Set(
    titleA.toLowerCase().split(/\s+/).filter((w) => !stopWords.has(w)),
  );
  const wordsB = new Set(
    titleB.toLowerCase().split(/\s+/).filter((w) => !stopWords.has(w)),
  );

  if (wordsA.size === 0 || wordsB.size === 0) return false;

  let overlap = 0;
  for (const w of wordsA) {
    if (wordsB.has(w)) overlap++;
  }

  return overlap / Math.min(wordsA.size, wordsB.size) >= 0.6;
}

async function fetchPolymarketOdds(
  marketTitle: string,
): Promise<number | null> {
  try {
    const resp = await fetch(
      `${POLYMARKET_API}/markets?closed=false&limit=20`,
      { signal: AbortSignal.timeout(10_000) },
    );
    if (!resp.ok) return null;

    const markets = (await resp.json()) as Record<string, unknown>[];
    if (!Array.isArray(markets)) return null;

    for (const m of markets) {
      const title =
        ((m["question"] as string) ?? (m["title"] as string) ?? "").toLowerCase();
      if (titlesMatch(marketTitle.toLowerCase(), title)) {
        const prices = m["outcomePrices"] as unknown[];
        if (Array.isArray(prices) && prices.length > 0) {
          return Number(prices[0]);
        }
      }
    }
    return null;
  } catch {
    return null;
  }
}

function evaluateArbitrage(
  candidate: CandidateMarket,
  edgeFloor: number,
  polyProb: number,
): TradeSignal | null {
  const kalshiImplied = candidate.yesPrice;
  const spread = Math.abs(polyProb - kalshiImplied);

  if (spread < 0.08) return null;

  let direction: "YES" | "NO";

  if (polyProb > kalshiImplied) {
    direction = "YES";
  } else {
    direction = "NO";
  }

  // pEstimate is always p(YES) — computeEv/computeKelly invert for NO direction
  const pEstimate = polyProb;
  const ev = computeEv(pEstimate, candidate.yesPrice, direction);
  if (ev < edgeFloor) return null;

  const tradePrice = direction === "YES" ? candidate.yesPrice : candidate.noPrice;
  const rationale =
    `Polymarket shows ${Math.round(polyProb * 100)}% vs Kalshi ${Math.round(kalshiImplied * 100)}% on same event. ` +
    `${Math.round(spread * 100)}-point spread exceeds 8% threshold. Trading ${direction} at ${tradePrice.toFixed(2)}.`;

  return {
    marketId: candidate.marketId,
    marketTitle: candidate.marketTitle,
    direction,
    pEstimate: Math.round(pEstimate * 10000) / 10000,
    marketPrice: Math.round(candidate.yesPrice * 10000) / 10000,
    evPerDollar: Math.round(ev * 10000) / 10000,
    edgeSource: SOURCE_ARBITRAGE,
    edgeRationale: rationale,
  };
}

// ──────────────────────── Main Entry ────────────────────────

export interface EdgeModelOptions {
  priceData?: Map<string, PriceData>;
  dbPath?: string;
}

export async function evaluateCandidates(
  candidates: CandidateMarket[],
  edgeFloor: number,
  options?: EdgeModelOptions,
): Promise<{ signals: TradeSignal[]; rejected: RejectedCandidate[] }> {
  const dbPath = options?.dbPath;
  const priceDataMap = options?.priceData ?? new Map<string, PriceData>();

  // Rule 8: check consecutive losses
  const consecutiveLosses = getConsecutiveLosses(dbPath);
  if (consecutiveLosses >= 3) {
    return {
      signals: [],
      rejected: candidates.map((c) => ({
        marketId: c.marketId,
        marketTitle: c.marketTitle,
        reason: "MODEL_REVIEW: 3 consecutive losses",
      })),
    };
  }

  // Rule 5: get open positions for correlation check
  const openPositions = getOpenPositions(dbPath);

  const signals: TradeSignal[] = [];
  const rejected: RejectedCandidate[] = [];

  for (const candidate of candidates) {
    // Correlation check (Rule 5)
    if (checkCorrelation(candidate.marketId, candidate.marketTitle, openPositions)) {
      rejected.push({
        marketId: candidate.marketId,
        marketTitle: candidate.marketTitle,
        reason: "CORRELATED_POSITION",
      });
      continue;
    }

    // No-chasing rule (Rule 2): 15-minute cooldown after loss on similar market
    if (hasRecentLoss(candidate.marketTitle, 900_000, dbPath)) {
      rejected.push({
        marketId: candidate.marketId,
        marketTitle: candidate.marketTitle,
        reason: "NO_CHASING_COOLDOWN",
      });
      continue;
    }

    let foundEdge = false;

    // Route by category
    if (candidate.marketCategory === "crypto_15m" && candidate.directional) {
      const symbol = candidate.binanceSymbol;
      if (symbol) {
        const pd = priceDataMap.get(symbol);
        if (pd) {
          const signal = evaluateCryptoTrend(candidate, edgeFloor, pd, "15m");
          if (signal) { signals.push(signal); foundEdge = true; }
        }
      }
    } else if (candidate.marketCategory === "crypto_hourly" && candidate.directional) {
      const symbol = candidate.binanceSymbol;
      if (symbol) {
        const pd = priceDataMap.get(symbol);
        if (pd) {
          const signal = evaluateCryptoTrend(candidate, edgeFloor, pd, "1h");
          if (signal) { signals.push(signal); foundEdge = true; }
        }
      }
    } else if (candidate.marketCategory === "sports") {
      // Check odds range
      if (!isWithinOddsRange(candidate.yesPrice, candidate.noPrice)) {
        rejected.push({
          marketId: candidate.marketId,
          marketTitle: candidate.marketTitle,
          reason: "OUTSIDE_ODDS_RANGE",
        });
        continue;
      }
      const signal = evaluateSportsCandidate(candidate, edgeFloor);
      if (signal) { signals.push(signal); foundEdge = true; }
    }

    // Fallback: Polymarket arbitrage for financial and unmatched markets
    if (!foundEdge && candidate.marketCategory === "financial_hourly") {
      const polyProb = await fetchPolymarketOdds(candidate.marketTitle);
      if (polyProb != null) {
        const signal = evaluateArbitrage(candidate, edgeFloor, polyProb);
        if (signal) { signals.push(signal); foundEdge = true; }
      }
    }

    if (!foundEdge) {
      rejected.push({
        marketId: candidate.marketId,
        marketTitle: candidate.marketTitle,
        reason: "NO_EDGE_FOUND",
      });
    }
  }

  return { signals, rejected };
}
