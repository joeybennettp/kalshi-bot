/**
 * Position monitor — trailing stop loss on open positions.
 *
 * Tracks the peak price each position reaches. If the price drops
 * more than TRAILING_STOP_PCT from the peak, sells to lock in profit.
 * Lets winners ride to max payout; only exits on reversals.
 */

import { kalshiGet, kalshiPost } from "./kalshi_api.js";
import { getOpenPositions, updateTrade, logEvent } from "./logger.js";

// Sell if price drops 30% from peak (e.g., peak $0.80 → sell at $0.56)
const TRAILING_STOP_PCT = 0.30;

// Only activate trailing stop once position is profitable (above entry)
const MIN_PROFIT_TO_ACTIVATE = 0.05; // at least 5 cents above entry

// In-memory peak price tracker — resets on restart (fine for short-lived contracts)
const peakPrices = new Map<string, number>();

export interface LivePosition {
  ticker: string;
  market_id: string;
  position: number;
  side: string;
}

export interface MarketPrices {
  yesBid: number;
  yesAsk: number;
  noBid: number;
  noAsk: number;
}

export async function fetchMarketPrices(
  ticker: string,
  options?: { _apiOverride?: (path: string, params?: Record<string, string>) => Promise<Record<string, unknown>> },
): Promise<MarketPrices | null> {
  try {
    const getFn = options?._apiOverride ?? kalshiGet;
    const data = await getFn(`/markets/${ticker}`);
    const market = (data["market"] ?? data) as Record<string, unknown>;

    return {
      yesBid: parseFloat((market["yes_bid"] as string) ?? "0") || 0,
      yesAsk: parseFloat((market["yes_ask"] as string) ?? "0") || 0,
      noBid: parseFloat((market["no_bid"] as string) ?? "0") || 0,
      noAsk: parseFloat((market["no_ask"] as string) ?? "0") || 0,
    };
  } catch {
    return null;
  }
}

export function calculatePnL(
  entryPrice: number,
  currentBid: number,
  contracts: number,
): { pnl: number; pnlPercent: number } {
  const pnlPerContract = currentBid - entryPrice;
  const pnl = pnlPerContract * contracts;
  const pnlPercent = entryPrice > 0 ? pnlPerContract / entryPrice : 0;
  return { pnl, pnlPercent };
}

/**
 * Check trailing stop logic for a position.
 * Returns sell reason string if should sell, null if should hold.
 */
export function checkTrailingStop(
  ticker: string,
  entryPrice: number,
  currentBid: number,
): string | null {
  // Update peak price
  const prevPeak = peakPrices.get(ticker) ?? currentBid;
  const peak = Math.max(prevPeak, currentBid);
  peakPrices.set(ticker, peak);

  // Don't activate until position is meaningfully profitable
  if (currentBid < entryPrice + MIN_PROFIT_TO_ACTIVATE) {
    return null;
  }

  // Check if price has dropped enough from peak
  const dropFromPeak = (peak - currentBid) / peak;
  if (dropFromPeak >= TRAILING_STOP_PCT) {
    return `TRAILING_STOP (peak=$${peak.toFixed(2)}, drop=${(dropFromPeak * 100).toFixed(0)}%>${(TRAILING_STOP_PCT * 100).toFixed(0)}%)`;
  }

  return null;
}

/**
 * Clean up peak tracking for positions that no longer exist.
 */
export function cleanupPeaks(activeTickers: Set<string>): void {
  for (const ticker of peakPrices.keys()) {
    if (!activeTickers.has(ticker)) {
      peakPrices.delete(ticker);
    }
  }
}

/**
 * Monitor all open positions with trailing stop.
 * Returns the number of positions closed.
 */
export async function monitorPositions(
  sessionId: string,
  bankroll: number,
  dbPath?: string,
  options?: {
    _getOverride?: (path: string, params?: Record<string, string>) => Promise<Record<string, unknown>>;
    _postOverride?: (path: string, payload: Record<string, unknown>) => Promise<Record<string, unknown>>;
  },
): Promise<number> {
  const getFn = options?._getOverride ?? kalshiGet;
  const postFn = options?._postOverride ?? kalshiPost;

  // Fetch live positions from Kalshi
  let livePositions: LivePosition[];
  try {
    const data = await getFn("/portfolio/positions", { limit: "50" });
    const raw = (data["market_positions"] ?? []) as Record<string, unknown>[];
    livePositions = raw
      .filter((p) => ((p["position"] as number) ?? 0) > 0)
      .map((p) => ({
        ticker: (p["ticker"] as string) ?? "",
        market_id: (p["market_id"] as string) ?? (p["ticker"] as string) ?? "",
        position: (p["position"] as number) ?? 0,
        side: (p["side"] as string) ?? "",
      }));
  } catch (e) {
    console.log(`[WARN] Failed to fetch positions: ${e instanceof Error ? e.message : e}`);
    return 0;
  }

  if (livePositions.length === 0) {
    cleanupPeaks(new Set());
    return 0;
  }

  // Clean up peaks for expired positions
  const activeTickers = new Set(livePositions.map((p) => p.ticker));
  cleanupPeaks(activeTickers);

  // Get open trades from DB to match entry prices
  const openTrades = getOpenPositions(dbPath);

  let closed = 0;

  for (const pos of livePositions) {
    const trade = openTrades.find(
      (t) => t.market_id === pos.ticker || t.market_id === pos.market_id,
    );
    if (!trade || !trade.fill_price) continue;

    // Fetch current market price
    const prices = await fetchMarketPrices(pos.ticker, { _apiOverride: getFn });
    if (!prices) continue;

    const isYes = pos.side.toLowerCase() === "yes";
    const currentBid = isYes ? prices.yesBid : prices.noBid;
    const entryPrice = trade.fill_price;

    if (currentBid <= 0) continue;

    // Check trailing stop
    const sellReason = checkTrailingStop(pos.ticker, entryPrice, currentBid);
    if (!sellReason) continue;

    // Place sell order
    try {
      const orderPayload: Record<string, unknown> = {
        ticker: pos.ticker,
        action: "sell",
        side: pos.side.toLowerCase(),
        type: "limit",
        count: pos.position,
      };

      if (isYes) {
        orderPayload["yes_price"] = Math.round(currentBid * 100);
      } else {
        orderPayload["no_price"] = Math.round(currentBid * 100);
      }

      const result = await postFn("/portfolio/orders", orderPayload);
      const order = (result["order"] ?? {}) as Record<string, unknown>;
      const orderStatus = (order["status"] as string) ?? "";

      if (orderStatus === "resting") {
        console.log(`  Trailing stop order resting (unfilled): ${pos.ticker}`);
        continue;
      }

      const { pnl } = calculatePnL(entryPrice, currentBid, pos.position);
      const bankrollAfter = bankroll + pnl;

      if (trade.id != null) {
        updateTrade(
          trade.id,
          {
            resolution: pnl > 0 ? "WIN" : "LOSS",
            pnl: Math.round(pnl * 100) / 100,
            bankroll_after: Math.round(bankrollAfter * 100) / 100,
            reject_reason: sellReason,
          },
          dbPath,
        );
      }

      logEvent(
        "TRAILING_STOP",
        {
          session_id: sessionId,
          market_id: pos.ticker,
          side: pos.side,
          contracts: pos.position,
          entry_price: entryPrice,
          exit_price: currentBid,
          peak_price: peakPrices.get(pos.ticker) ?? currentBid,
          pnl: Math.round(pnl * 100) / 100,
        },
        dbPath,
      );

      const pnlSign = pnl >= 0 ? "+" : "";
      console.log(
        `  TRAILING STOP: ${pos.ticker} (${pos.side.toUpperCase()}) ` +
        `entry=$${entryPrice.toFixed(2)} peak=$${(peakPrices.get(pos.ticker) ?? currentBid).toFixed(2)} → exit=$${currentBid.toFixed(2)} ` +
        `P&L=${pnlSign}$${pnl.toFixed(2)}`,
      );

      // Remove from peak tracking
      peakPrices.delete(pos.ticker);
      closed++;
    } catch (e) {
      console.log(`[WARN] Failed to sell ${pos.ticker}: ${e instanceof Error ? e.message : e}`);
    }
  }

  return closed;
}
