/**
 * Position monitor — profit-locking stop-loss on open positions.
 *
 * Once a position's price reaches 2x the entry price (100% gain),
 * a profit-lock activates with a floor at 1.5x entry. If the price
 * drops back to that floor, the position is sold to guarantee profit.
 *
 * If a position never reaches 2x entry, it is left to expire naturally.
 */

import { kalshiGet, kalshiPost } from "./kalshi_api.js";
import { getOpenPositions, updateTrade, logEvent } from "./logger.js";

// Profit lock triggers when price reaches 2x entry (100% gain)
const PROFIT_LOCK_TRIGGER = 2.0;

// Once triggered, floor is set at 1.5x entry (guaranteed 50% profit)
const PROFIT_LOCK_FLOOR = 1.5;

// In-memory peak price tracker — used to detect if 2x was ever reached
const peakPrices = new Map<string, number>();

// Track which positions have had their profit lock activated
const profitLockActive = new Map<string, boolean>();

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
 * Check profit-lock logic for a position.
 * Returns sell reason string if should sell, null if should hold.
 *
 * Rules:
 * - Track peak price for each position
 * - If peak ever reached 2x entry → profit lock is activated
 * - Once activated, if current price drops to 1.5x entry → sell
 * - If never reached 2x entry → hold (let it expire naturally)
 */
export function checkProfitLock(
  ticker: string,
  entryPrice: number,
  currentBid: number,
): string | null {
  // Update peak price
  const prevPeak = peakPrices.get(ticker) ?? currentBid;
  const peak = Math.max(prevPeak, currentBid);
  peakPrices.set(ticker, peak);

  const triggerPrice = entryPrice * PROFIT_LOCK_TRIGGER;
  const floorPrice = entryPrice * PROFIT_LOCK_FLOOR;

  // Check if profit lock should activate (peak ever reached 2x entry)
  if (peak >= triggerPrice && !profitLockActive.get(ticker)) {
    profitLockActive.set(ticker, true);
  }

  // If profit lock is not active, hold
  if (!profitLockActive.get(ticker)) {
    return null;
  }

  // Profit lock is active — check if price dropped to floor
  if (currentBid <= floorPrice) {
    return `PROFIT_LOCK (entry=$${entryPrice.toFixed(2)}, peak=$${peak.toFixed(2)}, floor=$${floorPrice.toFixed(2)})`;
  }

  return null;
}

/**
 * Clean up peak tracking and profit lock state for positions that no longer exist.
 */
export function cleanupPeaks(activeTickers: Set<string>): void {
  for (const ticker of peakPrices.keys()) {
    if (!activeTickers.has(ticker)) {
      peakPrices.delete(ticker);
      profitLockActive.delete(ticker);
    }
  }
}

/**
 * Monitor all open positions with profit-lock stop-loss.
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

    // Debug: dump first position to see actual field names
    if (raw.length > 0) {
      console.log(`  [MONITOR] Kalshi returned ${raw.length} position(s)`);
      console.log(`    RAW[0]: ${JSON.stringify(raw[0])}`);
    }

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

  // Clean up state for expired positions
  const activeTickers = new Set(livePositions.map((p) => p.ticker));
  cleanupPeaks(activeTickers);

  // Get open trades from DB to match entry prices
  const openTrades = getOpenPositions(dbPath);

  let closed = 0;

  for (const pos of livePositions) {
    const trade = openTrades.find(
      (t) => t.market_id === pos.ticker || t.market_id === pos.market_id,
    );
    if (!trade) {
      console.log(`  [MONITOR] No DB match for ${pos.ticker} (market_id=${pos.market_id})`);
      continue;
    }
    if (!trade.fill_price) {
      console.log(`  [MONITOR] No fill_price for ${pos.ticker} (trade id=${trade.id})`);
      continue;
    }

    // Fetch current market price
    const prices = await fetchMarketPrices(pos.ticker, { _apiOverride: getFn });
    if (!prices) continue;

    const isYes = pos.side.toLowerCase() === "yes";
    const currentBid = isYes ? prices.yesBid : prices.noBid;
    const entryPrice = trade.fill_price;

    if (currentBid <= 0) continue;

    const triggerPrice = entryPrice * PROFIT_LOCK_TRIGGER;
    const floorPrice = entryPrice * PROFIT_LOCK_FLOOR;
    const isLocked = profitLockActive.get(pos.ticker) || false;
    const peak = peakPrices.get(pos.ticker) ?? currentBid;

    // Log position status each cycle so we can verify it's working
    console.log(
      `  [MONITOR] ${pos.ticker}: entry=$${entryPrice.toFixed(2)} bid=$${currentBid.toFixed(2)} peak=$${Math.max(peak, currentBid).toFixed(2)} ` +
      `trigger=$${triggerPrice.toFixed(2)} floor=$${floorPrice.toFixed(2)} lock=${isLocked ? "ACTIVE" : "waiting"}`,
    );

    // Check profit-lock stop
    const sellReason = checkProfitLock(pos.ticker, entryPrice, currentBid);
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
        console.log(`  Profit-lock order resting (unfilled): ${pos.ticker}`);
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
        "PROFIT_LOCK_EXIT",
        {
          session_id: sessionId,
          market_id: pos.ticker,
          side: pos.side,
          contracts: pos.position,
          entry_price: entryPrice,
          exit_price: currentBid,
          peak_price: peakPrices.get(pos.ticker) ?? currentBid,
          floor_price: entryPrice * PROFIT_LOCK_FLOOR,
          pnl: Math.round(pnl * 100) / 100,
        },
        dbPath,
      );

      const pnlSign = pnl >= 0 ? "+" : "";
      console.log(
        `  PROFIT LOCK: ${pos.ticker} (${pos.side.toUpperCase()}) ` +
        `entry=$${entryPrice.toFixed(2)} peak=$${(peakPrices.get(pos.ticker) ?? currentBid).toFixed(2)} → exit=$${currentBid.toFixed(2)} ` +
        `P&L=${pnlSign}$${pnl.toFixed(2)}`,
      );

      // Remove from tracking
      peakPrices.delete(pos.ticker);
      profitLockActive.delete(pos.ticker);
      closed++;
    } catch (e) {
      console.log(`[WARN] Failed to sell ${pos.ticker}: ${e instanceof Error ? e.message : e}`);
    }
  }

  return closed;
}
