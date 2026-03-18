/**
 * Edge model subagent — estimates true probabilities and computes EV.
 *
 * Routes candidates to the appropriate edge source by market category:
 *   - crypto_15m / crypto_hourly → trend analysis (Binance data)
 *   - financial_hourly → Polymarket arbitrage
 *   - sports → sports edge (stale liquidity, momentum, odds filter)
 */

import { getConsecutiveLosses, getOpenPositions, hasRecentLoss, hasRecentFailedOrder, type TradeRecord } from "./logger.js";
import type { CandidateMarket } from "./scanner.js";
import type { PriceData } from "./price_feeds.js";
import type { MarketCategory } from "./market_registry.js";
import { MARKET_REGISTRY } from "./market_registry.js";
import { analyzeTrend } from "./trend_analysis.js";
import { evaluateSportsCandidate, isWithinOddsRange } from "./sports_edge.js";

// Max positions in the same category going the same direction
const MAX_SAME_CATEGORY_DIRECTION = 3;

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

/**
 * Look up a market's category from its market_id (e.g. "KXBTC15M-..." → "crypto_15m").
 */
export function getCategoryFromMarketId(marketId: string): MarketCategory | null {
  for (const config of MARKET_REGISTRY) {
    if (marketId.startsWith(config.seriesTicker)) {
      return config.category;
    }
  }
  return null;
}

/**
 * Count how many open positions + already-approved signals share the same
 * category and direction as the candidate.
 */
export function countCategoryDirection(
  category: MarketCategory,
  direction: "YES" | "NO",
  openPositions: TradeRecord[],
  approvedSignals: TradeSignal[],
): number {
  let count = 0;

  // Count existing open positions
  for (const pos of openPositions) {
    const posCategory = getCategoryFromMarketId(pos.market_id);
    if (posCategory === category && pos.direction === direction) {
      count++;
    }
  }

  // Count signals already approved this cycle
  for (const sig of approvedSignals) {
    const sigCategory = getCategoryFromMarketId(sig.marketId);
    if (sigCategory === category && sig.direction === direction) {
      count++;
    }
  }

  return count;
}

// ──────────────────────── Crypto Trend Edge ────────────────────────

/**
 * Evaluate a crypto market using multi-indicator trend analysis.
 * Returns a signal or a rejection reason string.
 */
function evaluateCryptoTrend(
  candidate: CandidateMarket,
  edgeFloor: number,
  priceData: PriceData,
  timeframe: "15m" | "1h",
): TradeSignal | string {
  const trend = analyzeTrend(priceData, timeframe);

  if (trend.direction === "NEUTRAL") return `TREND_NEUTRAL (pUp=${(trend.pUp * 100).toFixed(1)}%)`;

  const kalshiImpliedUp = candidate.yesPrice;

  // Skip extreme prices — our model can't reliably estimate probabilities
  // when the market is near certainty (the market has information we don't)
  if (kalshiImpliedUp > 0.85 || kalshiImpliedUp < 0.15) return `EXTREME_PRICE (yes=${(kalshiImpliedUp * 100).toFixed(0)}%)`;

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
    const gap = Math.abs(trend.pUp - kalshiImpliedUp);
    return `NO_DIVERGENCE (trend=${(trend.pUp * 100).toFixed(1)}% vs kalshi=${(kalshiImpliedUp * 100).toFixed(1)}%, gap=${(gap * 100).toFixed(1)}%<4%)`;
  }

  const ev = computeEv(pEstimate, candidate.yesPrice, direction);
  if (ev < edgeFloor) return `EV_BELOW_FLOOR (ev=${(ev * 100).toFixed(2)}c < floor=${(edgeFloor * 100).toFixed(0)}c)`;

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

  // Rule 8: consecutive losses check is handled by main.ts cooldown logic.
  // If we reach this point, main.ts has already approved trading for this cycle.

  // Rule 5: get open positions for correlation check
  const openPositions = getOpenPositions(dbPath);

  const signals: TradeSignal[] = [];
  const rejected: RejectedCandidate[] = [];

  for (const candidate of candidates) {
    // Dedup: never enter a market we already hold a position in
    if (openPositions.some((p) => p.market_id === candidate.marketId)) {
      rejected.push({
        marketId: candidate.marketId,
        marketTitle: candidate.marketTitle,
        reason: "ALREADY_HOLDING_POSITION",
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

    // Skip markets that recently failed to fill (5-minute cooldown)
    if (hasRecentFailedOrder(candidate.marketId, 300_000, dbPath)) {
      rejected.push({
        marketId: candidate.marketId,
        marketTitle: candidate.marketTitle,
        reason: "RECENT_FILL_FAILURE",
      });
      continue;
    }

    let foundEdge = false;
    let rejectReason = "";

    // Skip non-directional crypto markets (range markets)
    if ((candidate.marketCategory === "crypto_15m" || candidate.marketCategory === "crypto_hourly") && !candidate.directional) {
      rejected.push({
        marketId: candidate.marketId,
        marketTitle: candidate.marketTitle,
        reason: "RANGE_MARKET_SKIPPED",
      });
      continue;
    }

    // Route by category — edge model determines direction, then we check category limits
    let signal: TradeSignal | null = null;

    if (candidate.marketCategory === "crypto_15m" && candidate.directional) {
      const symbol = candidate.binanceSymbol;
      if (!symbol) {
        rejectReason = "NO_BINANCE_SYMBOL";
      } else {
        const pd = priceDataMap.get(symbol);
        if (!pd) {
          rejectReason = `NO_PRICE_DATA (${symbol})`;
        } else {
          const result = evaluateCryptoTrend(candidate, edgeFloor, pd, "15m");
          if (typeof result === "string") {
            rejectReason = result;
          } else {
            signal = result;
          }
        }
      }
    } else if (candidate.marketCategory === "crypto_hourly" && candidate.directional) {
      const symbol = candidate.binanceSymbol;
      if (!symbol) {
        rejectReason = "NO_BINANCE_SYMBOL";
      } else {
        const pd = priceDataMap.get(symbol);
        if (!pd) {
          rejectReason = `NO_PRICE_DATA (${symbol})`;
        } else {
          const result = evaluateCryptoTrend(candidate, edgeFloor, pd, "1h");
          if (typeof result === "string") {
            rejectReason = result;
          } else {
            signal = result;
          }
        }
      }
    } else if (candidate.marketCategory === "sports") {
      if (!isWithinOddsRange(candidate.yesPrice, candidate.noPrice)) {
        rejectReason = `OUTSIDE_ODDS_RANGE (yes=${(candidate.yesPrice * 100).toFixed(0)}c)`;
      } else {
        signal = evaluateSportsCandidate(candidate, edgeFloor);
        if (!signal) rejectReason = "SPORTS_NO_EDGE";
      }
    } else if (candidate.marketCategory === "financial_hourly") {
      const polyProb = await fetchPolymarketOdds(candidate.marketTitle);
      if (polyProb == null) {
        rejectReason = "NO_POLYMARKET_MATCH";
      } else {
        signal = evaluateArbitrage(candidate, edgeFloor, polyProb);
        if (!signal) rejectReason = `ARB_SPREAD_TOO_SMALL (poly=${(polyProb * 100).toFixed(0)}% vs kalshi=${(candidate.yesPrice * 100).toFixed(0)}%)`;
      }
    }

    // Rule 5: Category + direction correlation limit (max 3 same category + same direction)
    if (signal) {
      const sameCount = countCategoryDirection(candidate.marketCategory, signal.direction, openPositions, signals);
      if (sameCount >= MAX_SAME_CATEGORY_DIRECTION) {
        rejectReason = `CATEGORY_LIMIT (${sameCount} ${candidate.marketCategory} ${signal.direction} already open)`;
        signal = null;
      }
    }

    if (signal) {
      signals.push(signal);
      foundEdge = true;
    }

    if (!foundEdge) {
      rejected.push({
        marketId: candidate.marketId,
        marketTitle: candidate.marketTitle,
        reason: rejectReason || "NO_EDGE_FOUND",
      });
    }
  }

  return { signals, rejected };
}
