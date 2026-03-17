/**
 * Sizer subagent — computes half-Kelly position sizes with hard caps.
 */

import type { TradeSignal } from "./edge_model.js";

const MINIMUM_POSITION = 2.0;

// [upperBound, maxPercent]
const SIZE_CAPS: [number, number][] = [
  [500, 0.25],
  [5_000, 0.2],
  [50_000, 0.15],
  [Infinity, 0.1],
];

export interface SizedTrade {
  // From TradeSignal
  marketId: string;
  marketTitle: string;
  direction: "YES" | "NO";
  pEstimate: number;
  marketPrice: number;
  evPerDollar: number;
  edgeSource: string;
  edgeRationale: string;
  // Sizing fields
  kellyFraction: number;
  halfKellyFraction: number;
  uncappedSize: number;
  positionSize: number;
  sizeCapApplied: string | null;
}

export function getMaxPositionPercent(bankroll: number): number {
  for (const [upperBound, maxPct] of SIZE_CAPS) {
    if (bankroll <= upperBound) return maxPct;
  }
  return 0.1;
}

export function computeKelly(
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

  const b = (1 - price) / price; // net odds
  const q = 1 - p;
  return (b * p - q) / b;
}

export function sizeTrade(
  signal: TradeSignal,
  bankroll: number,
  visibleLiquidity?: number | null,
): SizedTrade | null {
  const kelly = computeKelly(signal.pEstimate, signal.marketPrice, signal.direction);

  if (kelly <= 0) return null; // no edge per Kelly

  const halfKelly = kelly / 2;
  const uncappedSize = halfKelly * bankroll;

  // Apply hard cap
  const maxPct = getMaxPositionPercent(bankroll);
  const cap = maxPct * bankroll;
  let sizeCapApplied: string | null = null;

  let positionSize = uncappedSize;
  if (positionSize > cap) {
    positionSize = cap;
    sizeCapApplied = `BANKROLL_CAP_${Math.round(maxPct * 100)}PCT`;
  }

  // Liquidity check for large bankrolls
  if (bankroll > 10_000 && visibleLiquidity != null) {
    const liquidityMax = 0.25 * visibleLiquidity;
    if (positionSize > liquidityMax) {
      positionSize = liquidityMax;
      sizeCapApplied = "LIQUIDITY_CAP_25PCT";
    }
  }

  // Round down to nearest cent
  positionSize = Math.floor(positionSize * 100) / 100;

  // Minimum size check
  if (positionSize < MINIMUM_POSITION) return null;

  return {
    marketId: signal.marketId,
    marketTitle: signal.marketTitle,
    direction: signal.direction,
    pEstimate: signal.pEstimate,
    marketPrice: signal.marketPrice,
    evPerDollar: signal.evPerDollar,
    edgeSource: signal.edgeSource,
    edgeRationale: signal.edgeRationale,
    kellyFraction: Math.round(kelly * 1_000_000) / 1_000_000,
    halfKellyFraction: Math.round(halfKelly * 1_000_000) / 1_000_000,
    uncappedSize: Math.round(uncappedSize * 100) / 100,
    positionSize,
    sizeCapApplied,
  };
}

export function sizeTrades(
  signals: TradeSignal[],
  bankroll: number,
  liquidityMap?: Record<string, number>,
): SizedTrade[] {
  const map = liquidityMap ?? {};
  const sized: SizedTrade[] = [];

  for (const signal of signals) {
    const liquidity = map[signal.marketId] ?? null;
    const result = sizeTrade(signal, bankroll, liquidity);
    if (result != null) {
      sized.push(result);
    }
  }

  return sized;
}
