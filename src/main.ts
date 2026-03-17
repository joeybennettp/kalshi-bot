/**
 * Orchestrator — main entry point for the Kalshi trading bot.
 * Runs the subagent pipeline: pacer → scanner → edge_model → sizer → executor → logger
 *
 * Cycles every 30 seconds. Pre-fetches Binance price data in parallel with scanning.
 * Fully autonomous — no interactive prompts.
 */

import "dotenv/config";
import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";

import { initDb, logEvent, getBankrollAfterLastTrade, getConsecutiveLosses, getOpenPositions } from "./logger.js";
import { computePace } from "./pacer.js";
import { scanMarkets } from "./scanner.js";
import { evaluateCandidates } from "./edge_model.js";
import { sizeTrades } from "./sizer.js";
import { executeTrade, cancelRestingOrders } from "./executor.js";
import { kalshiGet } from "./kalshi_api.js";
import { fetchAllPriceData } from "./price_feeds.js";
import { getUniqueBinanceSymbols } from "./market_registry.js";
import { monitorPositions } from "./position_monitor.js";
import { checkResolutions } from "./resolution_checker.js";

const CYCLE_INTERVAL_MS = 30_000; // 30 seconds
const BANKROLL_FLOOR_ABSOLUTE = 10.0; // Hard minimum — never go below $10
const DEFAULT_STARTING_BANKROLL = 100.0;
const SESSION_LOSS_LIMIT_PCT = 0.30; // Halt if down 30% from session start
const MAX_OPEN_POSITIONS = 5; // Never hold more than 5 positions at once
const MODEL_REVIEW_COOLDOWN_MS = 60 * 60 * 1000; // 1 hour cooldown after 3 consecutive losses
const MODEL_REVIEW_LOCKFILE = path.resolve(__dirname, "..", ".model_review_lock");

function getLocalBankroll(dbPath?: string): number {
  const last = getBankrollAfterLastTrade(dbPath);
  return last ?? DEFAULT_STARTING_BANKROLL;
}

async function getCurrentBankroll(): Promise<number> {
  try {
    const data = await kalshiGet("/portfolio/balance");
    const balance = (data["balance"] as number) ?? 0;
    const portfolioValue = (data["portfolio_value"] as number) ?? 0;
    // balance is in cents; portfolio_value includes open positions
    return (balance + portfolioValue) / 100;
  } catch {
    // Fallback to local DB if API fails
    return getLocalBankroll();
  }
}

function getTradingDay(): number {
  const now = new Date();
  const day = now.getUTCDay(); // 0=Sunday
  return day === 0 ? 7 : day; // Convert to 1=Monday...7=Sunday
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runCycle(
  sessionId: string,
  sessionStartBankroll: number,
  dbPath?: string,
): Promise<{ shouldContinue: boolean }> {
  let bankroll = await getCurrentBankroll();

  // Safety: dynamic bankroll floor (50% of session start, min $10)
  const bankrollFloor = Math.max(BANKROLL_FLOOR_ABSOLUTE, sessionStartBankroll * 0.5);
  if (bankroll < bankrollFloor) {
    logEvent("HALT", { reason: "BANKROLL_FLOOR", bankroll, floor: bankrollFloor, session_start: sessionStartBankroll }, dbPath);
    console.log(
      `\n[HALT] Bankroll $${bankroll.toFixed(2)} below floor $${bankrollFloor.toFixed(2)} (50% of session start $${sessionStartBankroll.toFixed(2)}). Stopping.`,
    );
    return { shouldContinue: false };
  }

  // Safety: session loss limit — halt if down 30% from session start
  const sessionDrawdown = (sessionStartBankroll - bankroll) / sessionStartBankroll;
  if (sessionDrawdown >= SESSION_LOSS_LIMIT_PCT) {
    logEvent("HALT", { reason: "SESSION_LOSS_LIMIT", bankroll, session_start: sessionStartBankroll, drawdown_pct: Math.round(sessionDrawdown * 100) }, dbPath);
    console.log(
      `\n[HALT] Session drawdown ${(sessionDrawdown * 100).toFixed(1)}% exceeds ${SESSION_LOSS_LIMIT_PCT * 100}% limit. ` +
      `Started at $${sessionStartBankroll.toFixed(2)}, now $${bankroll.toFixed(2)}. Stopping.`,
    );
    return { shouldContinue: false };
  }

  // Safety: consecutive losses (Rule 8) — cooldown instead of halt to prevent PM2 restart loop
  if (getConsecutiveLosses(dbPath) >= 3) {
    if (fs.existsSync(MODEL_REVIEW_LOCKFILE)) {
      const lockContent = fs.readFileSync(MODEL_REVIEW_LOCKFILE, "utf-8").trim();

      // "RESUMED" means cooldown already served — allow trading until streak breaks
      if (lockContent === "RESUMED") {
        // Keep trading — the streak will break when the next trade wins
      } else {
        const lockTime = parseInt(lockContent, 10);
        const elapsed = Date.now() - lockTime;
        if (elapsed < MODEL_REVIEW_COOLDOWN_MS) {
          const remaining = Math.ceil((MODEL_REVIEW_COOLDOWN_MS - elapsed) / 60_000);
          console.log(`  [PAUSED] MODEL_REVIEW cooldown: ${remaining} min remaining. Skipping trading.`);
          return { shouldContinue: true };
        }
        // Cooldown expired — mark as resumed so we don't re-pause
        fs.writeFileSync(MODEL_REVIEW_LOCKFILE, "RESUMED");
        console.log("  MODEL_REVIEW cooldown expired. Resuming trading.");
      }
    } else {
      // First time hitting 3 losses — create lockfile with timestamp
      fs.writeFileSync(MODEL_REVIEW_LOCKFILE, Date.now().toString());
      logEvent("MODEL_REVIEW", { bankroll, cooldown_minutes: MODEL_REVIEW_COOLDOWN_MS / 60_000 }, dbPath);
      console.log(`\n[MODEL_REVIEW] 3 consecutive losses — pausing trading for ${MODEL_REVIEW_COOLDOWN_MS / 60_000} minutes.`);
      return { shouldContinue: true };
    }
  } else {
    // Consecutive losses < 3 — clear lockfile if it exists (streak broken)
    if (fs.existsSync(MODEL_REVIEW_LOCKFILE)) {
      fs.unlinkSync(MODEL_REVIEW_LOCKFILE);
    }
  }

  // Step 0: Cancel stale resting orders (unfilled after 60s)
  const cancelledCount = await cancelRestingOrders(dbPath);
  if (cancelledCount > 0) {
    console.log(`  Cancelled ${cancelledCount} stale resting order(s)`);
    bankroll = await getCurrentBankroll();
  }

  // Step 0.25: Check resolutions — clear settled markets from DB
  const resolutions = await checkResolutions(bankroll, dbPath);
  if (resolutions.resolved > 0) {
    const pnlSign = resolutions.totalPnl >= 0 ? "+" : "";
    console.log(
      `  Resolved ${resolutions.resolved} market(s): ${resolutions.wins}W/${resolutions.losses}L (${pnlSign}$${resolutions.totalPnl.toFixed(2)})`,
    );
    bankroll = await getCurrentBankroll();
  }

  // Step 0.5: Monitor positions — sell profitable ones
  const closedCount = await monitorPositions(sessionId, bankroll, dbPath);
  if (closedCount > 0) {
    console.log(`  Closed ${closedCount} profitable position(s)`);
    bankroll = await getCurrentBankroll();
  }

  // Step 1: Pacer
  const tradingDay = getTradingDay();
  console.log(
    `\n--- Cycle Start | Bankroll: $${bankroll.toFixed(2)} | Day ${tradingDay} ---`,
  );

  let pace;
  try {
    pace = computePace(bankroll, tradingDay, undefined, dbPath);
  } catch (e) {
    console.log(`[ERROR] Pacer failed: ${e}`);
    return { shouldContinue: true };
  }

  console.log(
    `  Pace: ${pace.paceStatus} (ratio: ${pace.paceRatio.toFixed(2)}) | Edge floor: ${pace.edgeFloor}`,
  );

  // Step 2: Scanner + Binance price data in parallel
  let candidates;
  let priceData;
  try {
    const binanceSymbols = getUniqueBinanceSymbols();
    [candidates, priceData] = await Promise.all([
      scanMarkets(),
      fetchAllPriceData(binanceSymbols),
    ]);
  } catch (e) {
    if (e instanceof Error && e.message.includes("auth")) {
      logEvent("HALT", { reason: "AUTH_ERROR", error: String(e) }, dbPath);
      console.log(`\n[HALT] Auth error: ${e.message}`);
      return { shouldContinue: false };
    }
    console.log(`[ERROR] Scanner/price fetch failed: ${e}`);
    return { shouldContinue: true };
  }

  // Safety: max open positions
  const openPositions = getOpenPositions(dbPath);
  if (openPositions.length >= MAX_OPEN_POSITIONS) {
    console.log(`  At max open positions (${openPositions.length}/${MAX_OPEN_POSITIONS}). Skipping new entries.`);
    return { shouldContinue: true };
  }

  if (candidates.length === 0) {
    console.log("  No candidate markets found this cycle.");
    return { shouldContinue: true };
  }

  // Group by category for reporting
  const byCat = new Map<string, number>();
  for (const c of candidates) {
    byCat.set(c.marketCategory, (byCat.get(c.marketCategory) ?? 0) + 1);
  }
  const catSummary = [...byCat.entries()].map(([k, v]) => `${k}:${v}`).join(" ");
  console.log(`  Found ${candidates.length} candidate(s) [${catSummary}]`);

  // Step 3: Edge Model
  let signals, rejected;
  try {
    const result = await evaluateCandidates(candidates, pace.edgeFloor, {
      priceData,
      dbPath,
    });
    signals = result.signals;
    rejected = result.rejected;
  } catch (e) {
    console.log(`[ERROR] Edge model failed: ${e}`);
    return { shouldContinue: true };
  }

  if (signals.length === 0) {
    // Summarize rejection reasons
    const reasonCounts = new Map<string, number>();
    for (const r of rejected) {
      // Group by reason prefix (before any parenthetical details)
      const key = r.reason.replace(/\s*\(.*\)$/, "");
      reasonCounts.set(key, (reasonCounts.get(key) ?? 0) + 1);
    }
    const reasonSummary = [...reasonCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([reason, count]) => `${reason}:${count}`)
      .join(" ");
    console.log(`  No edge found. Rejected: ${rejected.length} [${reasonSummary}]`);
    return { shouldContinue: true };
  }

  console.log(`  Signals: ${signals.length} | Rejected: ${rejected.length}`);

  // Step 4: Sizer
  let sized;
  try {
    sized = sizeTrades(signals, bankroll);
  } catch (e) {
    logEvent("HALT", { reason: "SIZER_ERROR", error: String(e) }, dbPath);
    console.log(`\n[HALT] Sizer error: ${e}`);
    return { shouldContinue: false };
  }

  if (sized.length === 0) {
    console.log("  All signals failed sizing (below minimum or negative Kelly).");
    return { shouldContinue: true };
  }

  console.log(`  Sized trades: ${sized.length}`);

  // Step 5: Executor — fully autonomous, no approval needed
  for (const trade of sized) {
    try {
      const result = await executeTrade(trade, sessionId, bankroll, {
        dbPath,
      });
      console.log(
        `  Trade ${result.status}: ${trade.marketTitle} (${trade.direction}) $${trade.positionSize.toFixed(2)}`,
      );

      if (result.status === "EXECUTED") {
        bankroll = result.bankrollAfter ?? bankroll;
      }
    } catch (e) {
      if (e instanceof Error && e.message.includes("HALT")) {
        console.log(`\n[HALT] ${e.message}`);
        return { shouldContinue: false };
      }
      console.log(`[ERROR] Execution failed: ${e}`);
    }
  }

  return { shouldContinue: true };
}

async function main(): Promise<void> {
  const env = process.env["KALSHI_ENV"] ?? "demo";

  console.log(`Running in ${env.toUpperCase()} mode`);

  // Initialize
  initDb();
  const sessionId = crypto.randomUUID();
  const bankroll = await getCurrentBankroll();

  const sessionStartBankroll = bankroll;
  const bankrollFloor = Math.max(BANKROLL_FLOOR_ABSOLUTE, sessionStartBankroll * 0.5);

  logEvent("SESSION_START", {
    session_id: sessionId,
    env,
    bankroll,
    bankroll_floor: bankrollFloor,
    session_loss_limit_pct: SESSION_LOSS_LIMIT_PCT * 100,
    max_open_positions: MAX_OPEN_POSITIONS,
  });

  console.log(`Session: ${sessionId}`);
  console.log(`Starting bankroll: $${bankroll.toFixed(2)}`);
  console.log(`Bankroll floor: $${bankrollFloor.toFixed(2)} | Loss limit: ${SESSION_LOSS_LIMIT_PCT * 100}% | Max positions: ${MAX_OPEN_POSITIONS}`);
  console.log(`Cycle interval: ${CYCLE_INTERVAL_MS / 1000}s`);

  let shouldContinue = true;

  try {
    while (shouldContinue) {
      const result = await runCycle(sessionId, sessionStartBankroll);
      shouldContinue = result.shouldContinue;

      if (shouldContinue) {
        console.log(`\n  Sleeping ${CYCLE_INTERVAL_MS / 1000}s until next cycle...`);
        await sleep(CYCLE_INTERVAL_MS);
      }
    }
  } catch (e) {
    if (e instanceof Error && e.message !== "SIGINT") {
      console.log(`\n[ERROR] Unexpected: ${e.message}`);
    }
  }

  const finalBankroll = await getCurrentBankroll();
  logEvent("SESSION_END", {
    session_id: sessionId,
    final_bankroll: finalBankroll,
  });
  console.log(`\nSession ended. Final bankroll: $${finalBankroll.toFixed(2)}`);
  process.exit(shouldContinue ? 0 : 1);
}

main().catch((e) => {
  console.error("Fatal error:", e);
  process.exit(1);
});
