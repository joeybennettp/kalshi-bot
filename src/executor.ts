/**
 * Executor subagent — places orders on Kalshi and confirms fills.
 */

import * as readline from "readline";

import { logTrade, updateTrade, logEvent } from "./logger.js";
import { kalshiPost, kalshiGet, kalshiDelete } from "./kalshi_api.js";
import type { SizedTrade } from "./sizer.js";

const FILL_DEVIATION_THRESHOLD = 0.1;
const RESTING_ORDER_TIMEOUT_MS = 60_000; // Cancel unfilled orders after 60s
const PRICE_BUFFER_CENTS = 2; // Pay up to 2c more than scanned ask to ensure fill

function askUser(question: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase());
    });
  });
}

export interface ExecutionResult {
  tradeId: number;
  status: "EXECUTED" | "FAILED" | "REJECTED";
  fillPrice?: number;
  orderId?: string;
  bankrollAfter?: number;
  error?: string;
  rejectReason?: string;
}

export async function executeTrade(
  trade: SizedTrade,
  sessionId: string,
  bankroll: number,
  options?: {
    firstTrade?: boolean;
    dbPath?: string;
    /** For testing: skip interactive prompt */
    _approvalOverride?: boolean;
    /** For testing: override the API call */
    _apiOverride?: (path: string, payload: Record<string, unknown>) => Promise<Record<string, unknown>>;
  },
): Promise<ExecutionResult> {
  const firstTrade = options?.firstTrade ?? false;
  const dbPath = options?.dbPath;

  // Step 1: Pre-execution logging (Rule 7)
  let tradeId: number;
  try {
    tradeId = logTrade(
      {
        session_id: sessionId,
        market_id: trade.marketId,
        market_title: trade.marketTitle,
        direction: trade.direction,
        edge_source: trade.edgeSource,
        edge_rationale: trade.edgeRationale,
        p_estimate: trade.pEstimate,
        market_price: trade.marketPrice,
        ev_per_dollar: trade.evPerDollar,
        kelly_fraction: trade.kellyFraction,
        position_size: trade.positionSize,
        bankroll_before: bankroll,
        status: "PENDING",
      },
      dbPath,
    );
  } catch (e) {
    throw new Error(
      `Database write failed, cannot execute trade: ${e instanceof Error ? e.message : e}`,
    );
  }

  // Step 2: Human approval gate (Rule 6)
  if (firstTrade) {
    console.log("\n" + "=".repeat(50));
    console.log("  FIRST TRADE APPROVAL REQUIRED");
    console.log("=".repeat(50));
    console.log(`  Market:    ${trade.marketTitle}`);
    console.log(`  Direction: ${trade.direction}`);
    console.log(`  Size:      $${trade.positionSize.toFixed(2)}`);
    console.log(`  Price:     ${trade.marketPrice}`);
    console.log(`  P(est):    ${trade.pEstimate}`);
    console.log(`  EV/dollar: ${trade.evPerDollar}`);
    console.log(`  Edge:      ${trade.edgeSource}`);
    console.log(`  Rationale: ${trade.edgeRationale}`);
    console.log("=".repeat(50));

    let approved: boolean;
    if (options?._approvalOverride !== undefined) {
      approved = options._approvalOverride;
    } else {
      const answer = await askUser("  Approve? (y/n): ");
      approved = answer === "y";
    }

    if (!approved) {
      updateTrade(tradeId, { status: "REJECTED", reject_reason: "HUMAN_REJECTED" }, dbPath);
      return { tradeId, status: "REJECTED", rejectReason: "HUMAN_REJECTED" };
    }
  }

  // Step 3: Place limit order
  try {
    // marketPrice is always yesPrice; NO contracts cost (1 - yesPrice)
    const pricePerContract = trade.direction === "YES"
      ? trade.marketPrice
      : 1 - trade.marketPrice;
    const numContracts = Math.max(1, Math.floor(trade.positionSize / pricePerContract));
    const orderPayload: Record<string, unknown> = {
      ticker: trade.marketId,
      action: "buy",
      side: trade.direction.toLowerCase(),
      type: "limit",
      count: numContracts,
    };

    if (trade.direction === "YES") {
      orderPayload["yes_price"] = Math.round(trade.marketPrice * 100);
    } else {
      orderPayload["no_price"] = Math.round((1 - trade.marketPrice) * 100);
    }

    const postFn = options?._apiOverride ?? kalshiPost;
    const result = await postFn("/portfolio/orders", orderPayload);

    // Step 4: Extract fill info
    const order = (result["order"] ?? {}) as Record<string, unknown>;
    const orderId = (order["order_id"] as string) ?? "";
    const orderStatus = (order["status"] as string) ?? "";

    let fillPrice = (order["avg_price"] as number) ?? trade.marketPrice;

    // If order is resting, wait briefly and re-check for fill
    if (orderStatus === "resting" && orderId) {
      const getFn = kalshiGet;
      // Wait 5 seconds, then check if it filled
      await new Promise((r) => setTimeout(r, 5000));
      try {
        const check = await getFn(`/portfolio/orders/${orderId}`);
        const updated = (check["order"] ?? check) as Record<string, unknown>;
        const updatedStatus = (updated["status"] as string) ?? "resting";
        if (updatedStatus === "resting") {
          // Still unfilled — cancel and mark failed
          try { await kalshiDelete(`/portfolio/orders/${orderId}`); } catch {}
          updateTrade(tradeId, { status: "FAILED", reject_reason: "ORDER_RESTING_UNFILLED" }, dbPath);
          return { tradeId, status: "FAILED", orderId, error: "Order resting (unfilled after 5s)" };
        }
        // Order filled or partially filled — update fill price
        const updatedAvgPrice = (updated["avg_price"] as number) ?? 0;
        if (updatedAvgPrice > 0) {
          fillPrice = typeof updatedAvgPrice === "number" && updatedAvgPrice > 1
            ? updatedAvgPrice / 100
            : updatedAvgPrice;
        }
      } catch {
        // Can't check order — mark failed to be safe
        updateTrade(tradeId, { status: "FAILED", reject_reason: "ORDER_STATUS_CHECK_FAILED" }, dbPath);
        return { tradeId, status: "FAILED", orderId, error: "Could not verify order status" };
      }
    } else if (orderStatus === "resting") {
      updateTrade(tradeId, { status: "FAILED", reject_reason: "ORDER_RESTING_UNFILLED" }, dbPath);
      return { tradeId, status: "FAILED", orderId, error: "Order resting (unfilled)" };
    }
    if (typeof fillPrice === "number" && fillPrice > 1) {
      fillPrice = fillPrice / 100; // cents to dollars
    }

    // Step 5: Fill deviation check
    let haltRequired = false;
    let deviation = 0;
    if (trade.marketPrice > 0) {
      deviation = Math.abs(fillPrice - trade.marketPrice) / trade.marketPrice;
      if (deviation > FILL_DEVIATION_THRESHOLD) {
        haltRequired = true;
      }
    }

    const bankrollAfter = bankroll - trade.positionSize;

    // Step 6: Update trade record
    updateTrade(
      tradeId,
      {
        status: "EXECUTED",
        fill_price: fillPrice,
        resolution: "PENDING",
        bankroll_after: bankrollAfter,
      },
      dbPath,
    );

    if (haltRequired) {
      logEvent(
        "HALT",
        {
          reason: "FILL_DEVIATION",
          trade_id: tradeId,
          expected_price: trade.marketPrice,
          fill_price: fillPrice,
          deviation,
        },
        dbPath,
      );
      throw new Error(
        `Fill price deviation ${(deviation * 100).toFixed(1)}% exceeds ${FILL_DEVIATION_THRESHOLD * 100}% threshold — HALT`,
      );
    }

    return { tradeId, status: "EXECUTED", fillPrice, orderId, bankrollAfter };
  } catch (e) {
    if (e instanceof Error && e.message.includes("HALT")) throw e;

    const errorMsg = e instanceof Error ? e.message : String(e);
    updateTrade(tradeId, { status: "FAILED", reject_reason: errorMsg }, dbPath);
    return { tradeId, status: "FAILED", error: errorMsg };
  }
}

/**
 * Cancel resting (unfilled) orders older than the timeout.
 * Returns the number of orders cancelled.
 */
export async function cancelRestingOrders(dbPath?: string): Promise<number> {
  try {
    const data = await kalshiGet("/portfolio/orders", { status: "resting" });
    const orders = (data["orders"] ?? []) as Record<string, unknown>[];
    let cancelled = 0;

    for (const order of orders) {
      const orderId = order["order_id"] as string;
      const createdTime = order["created_time"] as string | undefined;
      if (!orderId) continue;

      // Check age
      if (createdTime) {
        const age = Date.now() - new Date(createdTime).getTime();
        if (age < RESTING_ORDER_TIMEOUT_MS) continue;
      }

      try {
        await kalshiDelete(`/portfolio/orders/${orderId}`);
        const ticker = (order["ticker"] as string) ?? "unknown";
        console.log(`  Cancelled resting order: ${ticker} (${orderId})`);
        cancelled++;
      } catch (e) {
        console.log(`  Failed to cancel order ${orderId}: ${e instanceof Error ? e.message : e}`);
      }
    }

    return cancelled;
  } catch (e) {
    console.log(`[WARN] Failed to check resting orders: ${e instanceof Error ? e.message : e}`);
    return 0;
  }
}
