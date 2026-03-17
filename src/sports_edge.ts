/**
 * Sports edge detection — Kalshi-only data, no external API needed.
 *
 * Edge sources:
 *   1. Stale liquidity — wide bid-ask spread indicates outdated pricing
 *   2. Price momentum — significant recent price movement within the market
 *
 * Constraints:
 *   - Straight bets only (binary markets, no parlays)
 *   - Odds between -250 and +250 (YES/NO price between $0.286 and $0.714)
 */

import type { CandidateMarket } from "./scanner.js";
import type { TradeSignal } from "./edge_model.js";
import { computeEv } from "./edge_model.js";

// Odds range: -250 to +250 American odds → Kalshi price $0.286 to $0.714
const MIN_PRICE = 0.286;
const MAX_PRICE = 0.714;

// Stale liquidity thresholds
const STALE_SPREAD_THRESHOLD = 0.08; // bid-ask spread > 8 cents suggests stale book

export const SOURCE_SPORTS_STALE = "sports_stale_liquidity";
export const SOURCE_SPORTS_MOMENTUM = "sports_price_momentum";

/**
 * Check if a market's odds are within the -250 to +250 range.
 */
export function isWithinOddsRange(yesPrice: number, noPrice: number): boolean {
  const yesInRange = yesPrice >= MIN_PRICE && yesPrice <= MAX_PRICE;
  const noInRange = noPrice >= MIN_PRICE && noPrice <= MAX_PRICE;
  return yesInRange || noInRange;
}

/**
 * Evaluate a sports market for stale liquidity edge.
 *
 * When the bid-ask spread is wide, the midpoint is our best estimate
 * of true probability. If the ask is far from the midpoint, there's edge.
 */
function evaluateStaleLiquidity(
  candidate: CandidateMarket,
  edgeFloor: number,
): TradeSignal | null {
  const yesSpread = candidate.yesPrice - candidate.yesBid;
  const noSpread = candidate.noPrice - candidate.noBid;

  // Need meaningful bid-ask data
  if (candidate.yesBid <= 0 && candidate.noBid <= 0) return null;

  // Check YES side
  if (yesSpread >= STALE_SPREAD_THRESHOLD && candidate.yesBid > 0) {
    // Midpoint estimate of true probability
    const midpoint = (candidate.yesPrice + candidate.yesBid) / 2;
    // We'd buy YES at the ask — edge if midpoint > ask implies underpriced
    // Actually: if spread is wide, we can buy at ask and true value is midpoint
    // Edge exists if midpoint > ask (we're getting it cheap)
    // But typically: ask > midpoint, so we look for YES being cheap
    // If yesBid is high relative to yesAsk, the ask may be stale-low
    const pEstimate = midpoint;
    const ev = computeEv(pEstimate, candidate.yesPrice, "YES");
    if (ev >= edgeFloor) {
      return {
        marketId: candidate.marketId,
        marketTitle: candidate.marketTitle,
        direction: "YES",
        pEstimate: Math.round(pEstimate * 10000) / 10000,
        marketPrice: Math.round(candidate.yesPrice * 10000) / 10000,
        evPerDollar: Math.round(ev * 10000) / 10000,
        edgeSource: SOURCE_SPORTS_STALE,
        edgeRationale:
          `Stale spread detected: YES bid=$${candidate.yesBid.toFixed(2)} ask=$${candidate.yesPrice.toFixed(2)} ` +
          `(spread=${(yesSpread * 100).toFixed(0)}c). Midpoint estimate: ${(midpoint * 100).toFixed(1)}%.`,
      };
    }
  }

  // Check NO side
  if (noSpread >= STALE_SPREAD_THRESHOLD && candidate.noBid > 0) {
    const noMidpoint = (candidate.noPrice + candidate.noBid) / 2;
    // pEstimate must be p(YES) — convert from p(NO) midpoint
    const pEstimate = 1 - noMidpoint;
    const ev = computeEv(pEstimate, candidate.yesPrice, "NO");
    if (ev >= edgeFloor) {
      return {
        marketId: candidate.marketId,
        marketTitle: candidate.marketTitle,
        direction: "NO",
        pEstimate: Math.round(pEstimate * 10000) / 10000,
        marketPrice: Math.round(candidate.yesPrice * 10000) / 10000,
        evPerDollar: Math.round(ev * 10000) / 10000,
        edgeSource: SOURCE_SPORTS_STALE,
        edgeRationale:
          `Stale spread detected: NO bid=$${candidate.noBid.toFixed(2)} ask=$${candidate.noPrice.toFixed(2)} ` +
          `(spread=${(noSpread * 100).toFixed(0)}c). Midpoint estimate: ${(noMidpoint * 100).toFixed(1)}%.`,
      };
    }
  }

  return null;
}

/**
 * Evaluate a sports market using price momentum.
 *
 * If the last traded price differs significantly from the current ask,
 * the market may be moving and we can trade in the direction of movement.
 */
function evaluatePriceMomentum(
  candidate: CandidateMarket,
  edgeFloor: number,
): TradeSignal | null {
  if (candidate.lastPrice <= 0) return null;

  // How much has the price moved since last trade?
  const priceDiff = candidate.lastPrice - candidate.yesPrice;
  const absDiff = Math.abs(priceDiff);

  // Need at least 6-cent movement to consider momentum
  if (absDiff < 0.06) return null;

  // If lastPrice > yesAsk: price was higher, now it's dropping → lean NO
  // If lastPrice < yesAsk: price was lower, now it's rising → lean YES
  let direction: "YES" | "NO";
  let pEstimate: number;

  if (priceDiff < 0) {
    // Price rising (last was lower, current ask is higher)
    direction = "YES";
    // Estimate: current price momentum suggests continuation
    pEstimate = Math.min(0.70, candidate.yesPrice + absDiff * 0.4);
  } else {
    // Price falling — pEstimate is p(YES), which is LOW (why we bet NO)
    direction = "NO";
    const noEstimate = Math.min(0.70, candidate.noPrice + absDiff * 0.4);
    pEstimate = 1 - noEstimate;
  }

  const ev = computeEv(pEstimate, candidate.yesPrice, direction);
  if (ev < edgeFloor) return null;

  const moveDir = priceDiff < 0 ? "up" : "down";
  return {
    marketId: candidate.marketId,
    marketTitle: candidate.marketTitle,
    direction,
    pEstimate: Math.round(pEstimate * 10000) / 10000,
    marketPrice: Math.round(candidate.yesPrice * 10000) / 10000,
    evPerDollar: Math.round(ev * 10000) / 10000,
    edgeSource: SOURCE_SPORTS_MOMENTUM,
    edgeRationale:
      `Price moved ${moveDir} by ${(absDiff * 100).toFixed(0)}c (last=$${candidate.lastPrice.toFixed(2)} → ask=$${candidate.yesPrice.toFixed(2)}). ` +
      `Trading ${direction} on momentum.`,
  };
}

/**
 * Evaluate a sports candidate market for tradeable edge.
 * Returns a TradeSignal if edge found, null otherwise.
 */
export function evaluateSportsCandidate(
  candidate: CandidateMarket,
  edgeFloor: number,
): TradeSignal | null {
  // Filter: odds range -250 to +250
  if (!isWithinOddsRange(candidate.yesPrice, candidate.noPrice)) {
    return null; // rejected — will be handled by caller with reason
  }

  // Try stale liquidity first
  const staleSignal = evaluateStaleLiquidity(candidate, edgeFloor);
  if (staleSignal) return staleSignal;

  // Try price momentum
  const momentumSignal = evaluatePriceMomentum(candidate, edgeFloor);
  if (momentumSignal) return momentumSignal;

  return null;
}
