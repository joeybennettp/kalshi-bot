/**
 * Resolution checker — queries Kalshi for settled markets and updates trade records.
 *
 * Each cycle, checks all open trades in the DB. If the market has settled,
 * marks the trade as WIN or LOSS with realized P&L. This clears stale
 * positions from the correlation check so new trades can flow.
 */

import { kalshiGet } from "./kalshi_api.js";
import { getOpenPositions, updateTrade, logEvent } from "./logger.js";

export interface ResolutionResult {
  resolved: number;
  wins: number;
  losses: number;
  totalPnl: number;
}

/**
 * Check all open trades for resolution. Returns count of resolved trades.
 */
export async function checkResolutions(
  bankroll: number,
  dbPath?: string,
  options?: {
    _apiOverride?: (path: string, params?: Record<string, string>) => Promise<Record<string, unknown>>;
  },
): Promise<ResolutionResult> {
  const getFn = options?._apiOverride ?? kalshiGet;
  const openTrades = getOpenPositions(dbPath);

  if (openTrades.length === 0) {
    return { resolved: 0, wins: 0, losses: 0, totalPnl: 0 };
  }

  let resolved = 0;
  let wins = 0;
  let losses = 0;
  let totalPnl = 0;
  let runningBankroll = bankroll;

  for (const trade of openTrades) {
    try {
      const data = await getFn(`/markets/${trade.market_id}`);
      const market = (data["market"] ?? data) as Record<string, unknown>;

      const status = (market["status"] as string) ?? "";
      const result = (market["result"] as string) ?? "";

      // Only process settled/finalized markets
      if (status !== "settled" && status !== "finalized") continue;
      if (!result) continue;

      // Determine win/loss
      const direction = trade.direction.toUpperCase();
      const resultUpper = result.toLowerCase();

      let isWin: boolean;
      if (direction === "YES") {
        isWin = resultUpper === "yes" || resultUpper === "all_yes";
      } else {
        isWin = resultUpper === "no" || resultUpper === "all_no";
      }

      // Calculate P&L
      const fillPrice = trade.fill_price ?? trade.market_price;
      const contracts = fillPrice > 0 ? trade.position_size / fillPrice : 0;

      let pnl: number;
      if (isWin) {
        // Each contract pays $1, we paid fillPrice per contract
        pnl = contracts * (1 - fillPrice);
      } else {
        // Each contract pays $0, we lose our stake
        pnl = -trade.position_size;
      }

      pnl = Math.round(pnl * 100) / 100;
      runningBankroll += pnl;
      const bankrollAfter = Math.round(runningBankroll * 100) / 100;

      // Update trade record
      if (trade.id != null) {
        updateTrade(
          trade.id,
          {
            resolution: isWin ? "WIN" : "LOSS",
            pnl,
            bankroll_after: bankrollAfter,
          },
          dbPath,
        );
      }

      logEvent(
        "RESOLUTION",
        {
          market_id: trade.market_id,
          market_title: trade.market_title,
          direction: trade.direction,
          result,
          resolution: isWin ? "WIN" : "LOSS",
          fill_price: fillPrice,
          pnl,
          bankroll_after: bankrollAfter,
        },
        dbPath,
      );

      const pnlSign = pnl >= 0 ? "+" : "";
      console.log(
        `  RESOLVED: ${trade.market_id} → ${result.toUpperCase()} | ` +
        `Our ${direction} = ${isWin ? "WIN" : "LOSS"} | ` +
        `P&L=${pnlSign}$${pnl.toFixed(2)}`,
      );

      resolved++;
      totalPnl += pnl;
      if (isWin) wins++;
      else losses++;
    } catch (e) {
      // Market may not exist anymore or API error — skip silently
      console.log(
        `[WARN] Resolution check failed for ${trade.market_id}: ${e instanceof Error ? e.message : e}`,
      );
    }
  }

  return { resolved, wins, losses, totalPnl: Math.round(totalPnl * 100) / 100 };
}
