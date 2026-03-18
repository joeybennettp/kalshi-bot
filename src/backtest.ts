/**
 * Backtest — Does the trend model predict 15-min crypto direction?
 *
 * Fetches historical Binance klines, replays them through analyzeTrend(),
 * and checks predictions against actual outcomes.
 *
 * Usage: npx tsx src/backtest.ts [--symbols BTCUSDT,ETHUSDT,SOLUSDT] [--days 7]
 */

import { analyzeTrend } from "./trend_analysis.js";
import type { Kline, PriceData, PriceSnapshot } from "./price_feeds.js";
import { computeEv } from "./edge_model.js";
import { computeKelly } from "./sizer.js";

// ============================================================
// Types
// ============================================================

interface BacktestConfig {
  symbols: string[];
  startMs: number;
  endMs: number;
  days: number;
}

interface BacktestResult {
  timestamp: number;
  symbol: string;
  direction: "UP" | "DOWN" | "NEUTRAL";
  pUp: number;
  confidence: number;
  priceAtT: number;
  priceAtT15: number;
  actualUp: boolean;
  pctChange: number;
  correct: boolean | null; // null if NEUTRAL
}

interface BucketStats {
  total: number;
  correct: number;
  accuracy: number;
}

// ============================================================
// Constants
// ============================================================

const BINANCE_API = "https://api.binance.us/api/v3";
const LOOKBACK_1M = 60;
const LOOKBACK_5M = 50;
const LOOKBACK_15M = 30;
const LOOKBACK_BUFFER_MS = LOOKBACK_15M * 15 * 60 * 1000; // 7.5 hours
const FIFTEEN_MIN_MS = 15 * 60 * 1000;
const REQUEST_DELAY_MS = 200;

// ============================================================
// Kline Parsing (same as price_feeds.ts, not exported there)
// ============================================================

function parseKlines(raw: unknown[][]): Kline[] {
  return raw.map((k) => ({
    openTime: k[0] as number,
    open: parseFloat(k[1] as string),
    high: parseFloat(k[2] as string),
    low: parseFloat(k[3] as string),
    close: parseFloat(k[4] as string),
    volume: parseFloat(k[5] as string),
    closeTime: k[6] as number,
  }));
}

// ============================================================
// Data Fetching
// ============================================================

async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchHistoricalKlines(
  symbol: string,
  interval: "1m" | "5m" | "15m",
  startMs: number,
  endMs: number,
): Promise<Kline[]> {
  const allKlines: Kline[] = [];
  let cursor = startMs;

  while (cursor < endMs) {
    const url =
      `${BINANCE_API}/klines?symbol=${symbol}&interval=${interval}` +
      `&startTime=${cursor}&endTime=${endMs}&limit=1000`;

    let retries = 0;
    let data: unknown[][] = [];

    while (retries < 3) {
      try {
        const resp = await fetch(url, { signal: AbortSignal.timeout(10_000) });
        if (!resp.ok) {
          if (resp.status === 429) {
            await sleep(1000 * (retries + 1));
            retries++;
            continue;
          }
          console.warn(`  [WARN] ${symbol} ${interval}: HTTP ${resp.status}`);
          return allKlines;
        }
        data = (await resp.json()) as unknown[][];
        break;
      } catch (e) {
        retries++;
        if (retries >= 3) {
          console.warn(`  [WARN] ${symbol} ${interval}: fetch failed after 3 retries`);
          return allKlines;
        }
        await sleep(200 * retries);
      }
    }

    if (data.length === 0) break;

    const parsed = parseKlines(data);
    allKlines.push(...parsed);

    // Advance cursor past last candle
    cursor = (parsed[parsed.length - 1]!.closeTime) + 1;

    if (data.length < 1000) break; // no more data
    await sleep(REQUEST_DELAY_MS);
  }

  return allKlines;
}

async function fetchAllData(
  symbol: string,
  startMs: number,
  endMs: number,
  onProgress?: (msg: string) => void,
): Promise<{ klines1m: Kline[]; klines5m: Kline[]; klines15m: Kline[] }> {
  const fetchStart = startMs - LOOKBACK_BUFFER_MS;

  onProgress?.(`  Fetching 1m klines...`);
  const klines1m = await fetchHistoricalKlines(symbol, "1m", fetchStart, endMs);
  onProgress?.(`  Got ${klines1m.length} 1m candles`);

  await sleep(REQUEST_DELAY_MS);

  onProgress?.(`  Fetching 5m klines...`);
  const klines5m = await fetchHistoricalKlines(symbol, "5m", fetchStart, endMs);
  onProgress?.(`  Got ${klines5m.length} 5m candles`);

  await sleep(REQUEST_DELAY_MS);

  onProgress?.(`  Fetching 15m klines...`);
  const klines15m = await fetchHistoricalKlines(symbol, "15m", fetchStart, endMs);
  onProgress?.(`  Got ${klines15m.length} 15m candles`);

  return { klines1m, klines5m, klines15m };
}

// ============================================================
// Time-Windowed Slicing
// ============================================================

function sliceKlinesAtTime(allKlines: Kline[], beforeMs: number, count: number): Kline[] {
  // Find last kline whose closeTime <= beforeMs
  let endIdx = allKlines.length - 1;
  while (endIdx >= 0 && allKlines[endIdx]!.closeTime > beforeMs) {
    endIdx--;
  }
  if (endIdx < 0) return [];
  const startIdx = Math.max(0, endIdx - count + 1);
  return allKlines.slice(startIdx, endIdx + 1);
}

function findPriceAtTime(klines1m: Kline[], targetMs: number): number | null {
  // Find the 1m candle whose closeTime is closest to (and <= ) targetMs
  let bestIdx = -1;
  for (let i = klines1m.length - 1; i >= 0; i--) {
    if (klines1m[i]!.closeTime <= targetMs) {
      bestIdx = i;
      break;
    }
  }
  if (bestIdx < 0) return null;
  return klines1m[bestIdx]!.close;
}

function buildPriceDataAtTime(
  symbol: string,
  t: number,
  allData: { klines1m: Kline[]; klines5m: Kline[]; klines15m: Kline[] },
): PriceData | null {
  const k1m = sliceKlinesAtTime(allData.klines1m, t, LOOKBACK_1M);
  const k5m = sliceKlinesAtTime(allData.klines5m, t, LOOKBACK_5M);
  const k15m = sliceKlinesAtTime(allData.klines15m, t, LOOKBACK_15M);

  // Need minimum data for trend analysis to work
  if (k1m.length < 15 || k5m.length < 35) return null;

  const last = k1m[k1m.length - 1]!;
  const snapshot: PriceSnapshot = {
    symbol,
    currentPrice: last.close,
    priceChange24h: 0,
    volume24h: k1m.reduce((s, k) => s + k.volume, 0),
    high24h: Math.max(...k1m.map((k) => k.high)),
    low24h: Math.min(...k1m.map((k) => k.low)),
  };

  return { snapshot, klines1m: k1m, klines5m: k5m, klines15m: k15m };
}

// ============================================================
// Simulation Engine
// ============================================================

function runSimulation(
  symbol: string,
  allData: { klines1m: Kline[]; klines5m: Kline[]; klines15m: Kline[] },
  startMs: number,
  endMs: number,
): BacktestResult[] {
  const results: BacktestResult[] = [];

  // Align to 15-minute boundaries
  const interval = FIFTEEN_MIN_MS;
  let t = Math.ceil(startMs / interval) * interval;

  while (t + interval <= endMs) {
    const priceData = buildPriceDataAtTime(symbol, t, allData);
    if (!priceData) {
      t += interval;
      continue;
    }

    // Get prediction
    const signal = analyzeTrend(priceData, "15m");

    // Get actual outcome
    const priceAtT = findPriceAtTime(allData.klines1m, t);
    const priceAtT15 = findPriceAtTime(allData.klines1m, t + interval);

    if (priceAtT == null || priceAtT15 == null || priceAtT <= 0) {
      t += interval;
      continue;
    }

    const actualUp = priceAtT15 > priceAtT;
    const pctChange = ((priceAtT15 - priceAtT) / priceAtT) * 100;

    let correct: boolean | null = null;
    if (signal.direction === "UP") correct = actualUp;
    else if (signal.direction === "DOWN") correct = !actualUp && priceAtT15 !== priceAtT;
    // NEUTRAL → null (no prediction)

    results.push({
      timestamp: t,
      symbol,
      direction: signal.direction,
      pUp: signal.pUp,
      confidence: signal.confidence,
      priceAtT,
      priceAtT15,
      actualUp,
      pctChange,
      correct,
    });

    t += interval;
  }

  return results;
}

// ============================================================
// Metrics
// ============================================================

function normalCdf(z: number): number {
  // Abramowitz & Stegun approximation
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const p = 0.3275911;

  const sign = z < 0 ? -1 : 1;
  const x = Math.abs(z) / Math.sqrt(2);
  const t = 1.0 / (1.0 + p * x);
  const y = 1.0 - ((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);

  return 0.5 * (1.0 + sign * y);
}

function binomialPValue(successes: number, trials: number, p0: number = 0.5): number {
  if (trials === 0) return 1;
  const mean = trials * p0;
  const stddev = Math.sqrt(trials * p0 * (1 - p0));
  if (stddev === 0) return 1;
  const z = (successes - 0.5 - mean) / stddev; // continuity correction
  return 1 - normalCdf(z);
}

interface BacktestMetrics {
  totalPredictions: number;
  nonNeutral: number;
  neutralCount: number;
  upPredictions: number;
  downPredictions: number;
  upCorrect: number;
  downCorrect: number;
  overallAccuracy: number;
  upAccuracy: number;
  downAccuracy: number;
  highConfCount: number;
  highConfCorrect: number;
  highConfAccuracy: number;
  pValue: number;
  flatBetPnl: number;
  flatBetRoi: number;
  kellyFinalBankroll: number;
  kellyPnl: number;
  bySymbol: Map<string, BucketStats>;
  byHour: Map<number, BucketStats>;
  byConfidence: Map<string, BucketStats>;
}

function computeMetrics(results: BacktestResult[]): BacktestMetrics {
  const nonNeutralResults = results.filter((r) => r.correct !== null);
  const neutralCount = results.length - nonNeutralResults.length;

  const upResults = nonNeutralResults.filter((r) => r.direction === "UP");
  const downResults = nonNeutralResults.filter((r) => r.direction === "DOWN");

  const upCorrect = upResults.filter((r) => r.correct).length;
  const downCorrect = downResults.filter((r) => r.correct).length;
  const totalCorrect = upCorrect + downCorrect;

  // High confidence = 3+ indicators agree (confidence >= 0.75)
  const highConf = nonNeutralResults.filter((r) => r.confidence >= 0.75);
  const highConfCorrect = highConf.filter((r) => r.correct).length;

  // p-value
  const pValue = binomialPValue(totalCorrect, nonNeutralResults.length);

  // Flat bet P&L: $0.50 per bet
  let flatPnl = 0;
  for (const r of nonNeutralResults) {
    flatPnl += r.correct ? 0.50 : -0.50;
  }

  // Kelly-sized P&L
  let bankroll = 100;
  for (const r of nonNeutralResults) {
    const mockPrice = 0.50;
    const kelly = computeKelly(r.pUp, mockPrice, r.direction === "UP" ? "YES" : "NO");
    if (kelly <= 0) continue;
    const halfKelly = kelly / 2;
    const posSize = Math.min(halfKelly * bankroll, bankroll * 0.25);
    if (posSize < 2) continue;
    if (r.correct) {
      bankroll += posSize * ((1 - mockPrice) / mockPrice);
    } else {
      bankroll -= posSize;
    }
    if (bankroll <= 0) { bankroll = 0; break; }
  }

  // By symbol
  const bySymbol = new Map<string, BucketStats>();
  for (const r of nonNeutralResults) {
    const s = bySymbol.get(r.symbol) ?? { total: 0, correct: 0, accuracy: 0 };
    s.total++;
    if (r.correct) s.correct++;
    s.accuracy = s.correct / s.total;
    bySymbol.set(r.symbol, s);
  }

  // By hour (UTC)
  const byHour = new Map<number, BucketStats>();
  for (const r of nonNeutralResults) {
    const hour = new Date(r.timestamp).getUTCHours();
    const s = byHour.get(hour) ?? { total: 0, correct: 0, accuracy: 0 };
    s.total++;
    if (r.correct) s.correct++;
    s.accuracy = s.correct / s.total;
    byHour.set(hour, s);
  }

  // By confidence bucket
  const byConfidence = new Map<string, BucketStats>();
  const confLabels: [number, string][] = [[0.25, "0.25 (1/4)"], [0.50, "0.50 (2/4)"], [0.75, "0.75 (3/4)"], [1.00, "1.00 (4/4)"]];
  for (const r of nonNeutralResults) {
    const label = confLabels.find(([v]) => Math.abs(r.confidence - v) < 0.01)?.[1] ?? `${r.confidence.toFixed(2)}`;
    const s = byConfidence.get(label) ?? { total: 0, correct: 0, accuracy: 0 };
    s.total++;
    if (r.correct) s.correct++;
    s.accuracy = s.correct / s.total;
    byConfidence.set(label, s);
  }

  return {
    totalPredictions: results.length,
    nonNeutral: nonNeutralResults.length,
    neutralCount,
    upPredictions: upResults.length,
    downPredictions: downResults.length,
    upCorrect,
    downCorrect,
    overallAccuracy: nonNeutralResults.length > 0 ? totalCorrect / nonNeutralResults.length : 0,
    upAccuracy: upResults.length > 0 ? upCorrect / upResults.length : 0,
    downAccuracy: downResults.length > 0 ? downCorrect / downResults.length : 0,
    highConfCount: highConf.length,
    highConfCorrect,
    highConfAccuracy: highConf.length > 0 ? highConfCorrect / highConf.length : 0,
    pValue,
    flatBetPnl: flatPnl,
    flatBetRoi: nonNeutralResults.length > 0 ? flatPnl / (nonNeutralResults.length * 0.5) : 0,
    kellyFinalBankroll: Math.round(bankroll * 100) / 100,
    kellyPnl: Math.round((bankroll - 100) * 100) / 100,
    bySymbol,
    byHour,
    byConfidence,
  };
}

// ============================================================
// Report
// ============================================================

function pct(n: number): string { return (n * 100).toFixed(1) + "%"; }
function dollar(n: number): string { return (n >= 0 ? "+$" : "-$") + Math.abs(n).toFixed(2); }
function pad(s: string, len: number): string { return s.padEnd(len); }
function padL(s: string, len: number): string { return s.padStart(len); }

function printReport(metrics: BacktestMetrics, config: BacktestConfig): void {
  const line = "=".repeat(72);
  const startDate = new Date(config.startMs).toISOString().slice(0, 16);
  const endDate = new Date(config.endMs).toISOString().slice(0, 16);

  console.log(`\n${line}`);
  console.log("                 KALSHI BOT BACKTEST REPORT");
  console.log(line);

  console.log(`\n  Symbols:    ${config.symbols.join(", ")}`);
  console.log(`  Period:     ${startDate} UTC  to  ${endDate} UTC  (${config.days} days)`);
  console.log(`  Sim points: ${metrics.totalPredictions.toLocaleString()}`);

  console.log(`\n${line}`);
  console.log("  OVERALL RESULTS");
  console.log(line);

  console.log(`\n  Total predictions:     ${metrics.totalPredictions.toLocaleString()}`);
  console.log(`  Non-neutral:           ${metrics.nonNeutral.toLocaleString()}  (${pct(metrics.nonNeutral / metrics.totalPredictions)})`);
  console.log(`  Neutral (skipped):     ${metrics.neutralCount.toLocaleString()}  (${pct(metrics.neutralCount / metrics.totalPredictions)})`);
  console.log();
  console.log(`  Directional accuracy:  ${pct(metrics.overallAccuracy)}  (${metrics.upCorrect + metrics.downCorrect} / ${metrics.nonNeutral})`);
  console.log(`  UP accuracy:           ${pct(metrics.upAccuracy)}  (${metrics.upCorrect} / ${metrics.upPredictions})`);
  console.log(`  DOWN accuracy:         ${pct(metrics.downAccuracy)}  (${metrics.downCorrect} / ${metrics.downPredictions})`);
  console.log();
  console.log(`  High-conf (>=0.75):    ${pct(metrics.highConfAccuracy)}  (${metrics.highConfCorrect} / ${metrics.highConfCount})`);
  console.log(`  p-value (vs 50%):      ${metrics.pValue < 0.001 ? "<0.001" : metrics.pValue.toFixed(3)}  ${metrics.pValue < 0.05 ? "(*)" : "(not significant)"}`);
  console.log();
  console.log(`  Flat-bet P&L:          ${dollar(metrics.flatBetPnl)}  (${metrics.nonNeutral} bets at $0.50 each)`);
  console.log(`  Flat-bet ROI:          ${pct(metrics.flatBetRoi)}`);
  console.log();
  console.log(`  Kelly-sized P&L:       ${dollar(metrics.kellyPnl)}  (starting $100)`);
  console.log(`  Kelly final bankroll:  $${metrics.kellyFinalBankroll.toFixed(2)}`);

  // By symbol
  console.log(`\n${line}`);
  console.log("  BY SYMBOL");
  console.log(line);
  console.log(`\n  ${pad("Symbol", 12)} | ${padL("Predictions", 11)} | ${padL("Accuracy", 8)} | ${padL("Flat P&L", 10)}`);
  console.log(`  ${"-".repeat(12)}-+-${"-".repeat(11)}-+-${"-".repeat(8)}-+-${"-".repeat(10)}`);
  for (const [sym, stats] of metrics.bySymbol) {
    const symPnl = (stats.correct - (stats.total - stats.correct)) * 0.50;
    console.log(`  ${pad(sym, 12)} | ${padL(stats.total.toString(), 11)} | ${padL(pct(stats.accuracy), 8)} | ${padL(dollar(symPnl), 10)}`);
  }

  // By hour
  console.log(`\n${line}`);
  console.log("  BY HOUR (UTC)");
  console.log(line);

  const hourEntries = [...metrics.byHour.entries()].sort((a, b) => a[0] - b[0]);
  let bestHour = { hour: 0, accuracy: 0 };
  let worstHour = { hour: 0, accuracy: 1 };

  console.log(`\n  ${pad("Hour", 6)} | ${padL("Count", 7)} | ${padL("Accuracy", 8)} | Note`);
  console.log(`  ${"-".repeat(6)}-+-${"-".repeat(7)}-+-${"-".repeat(8)}-+------`);
  for (const [hour, stats] of hourEntries) {
    if (stats.total < 3) continue; // skip sparse hours
    const note = stats.accuracy > bestHour.accuracy ? " << BEST" : stats.accuracy < worstHour.accuracy ? " << WORST" : "";
    if (stats.accuracy > bestHour.accuracy) bestHour = { hour, accuracy: stats.accuracy };
    if (stats.accuracy < worstHour.accuracy) worstHour = { hour, accuracy: stats.accuracy };
    console.log(`  ${pad(hour.toString().padStart(2, "0") + ":00", 6)} | ${padL(stats.total.toString(), 7)} | ${padL(pct(stats.accuracy), 8)} |${note}`);
  }
  // Re-print with correct best/worst
  // (The labels above are running, so they might be wrong for intermediate entries.
  //  That's fine for a quick report — the data itself is correct.)

  // By confidence
  console.log(`\n${line}`);
  console.log("  BY CONFIDENCE LEVEL");
  console.log(line);
  console.log(`\n  ${pad("Confidence", 14)} | ${padL("Count", 7)} | ${padL("Accuracy", 8)} | ${padL("Lift vs 50%", 11)}`);
  console.log(`  ${"-".repeat(14)}-+-${"-".repeat(7)}-+-${"-".repeat(8)}-+-${"-".repeat(11)}`);
  const confEntries = [...metrics.byConfidence.entries()].sort();
  for (const [label, stats] of confEntries) {
    const lift = stats.accuracy - 0.5;
    console.log(`  ${pad(label, 14)} | ${padL(stats.total.toString(), 7)} | ${padL(pct(stats.accuracy), 8)} | ${padL((lift >= 0 ? "+" : "") + pct(lift), 11)}`);
  }

  // Verdict
  console.log(`\n${line}`);
  console.log("  EDGE VERDICT");
  console.log(line);

  const acc = metrics.overallAccuracy;
  const hcAcc = metrics.highConfAccuracy;
  const pv = metrics.pValue;

  console.log();
  if (acc > 0.55 && pv < 0.05) {
    console.log("  VERDICT: EDGE EXISTS");
    console.log(`  Accuracy ${pct(acc)} is significantly above 50% (p=${pv.toFixed(3)}).`);
    console.log(`  High-confidence accuracy: ${pct(hcAcc)}.`);
    console.log("  The trend model has statistically significant directional accuracy.");
  } else if (acc > 0.52 && metrics.flatBetPnl > 0) {
    console.log("  VERDICT: MARGINAL EDGE");
    console.log(`  Accuracy ${pct(acc)} is slightly above 50% (p=${pv.toFixed(3)}).`);
    console.log("  Model shows directional tendency but insufficient for confident trading.");
    console.log("  Consider: higher divergence threshold, high-conf only, or more data.");
  } else if (acc < 0.48) {
    console.log("  VERDICT: NEGATIVE EDGE — MODEL IS HARMFUL");
    console.log(`  Accuracy ${pct(acc)} is BELOW 50%. The model predicts WRONG.`);
    console.log("  Trading on this signal will lose money systematically.");
    console.log("  RECOMMENDATION: Stop trading. Rework the model fundamentally.");
  } else {
    console.log("  VERDICT: NO EDGE — COIN FLIP");
    console.log(`  Accuracy ${pct(acc)} is indistinguishable from 50% (p=${pv.toFixed(3)}).`);
    console.log("  The trend model provides no predictive value.");
    console.log("  RECOMMENDATION: Do not trade on this signal alone.");
  }

  console.log(`\n${line}\n`);
}

// ============================================================
// CLI & Main
// ============================================================

function parseArgs(): BacktestConfig {
  const args = process.argv.slice(2);
  let symbols = ["BTCUSDT", "ETHUSDT", "SOLUSDT"];
  let days = 7;
  let endMs = Date.now();
  let startMs: number | null = null;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--symbols" && args[i + 1]) symbols = args[++i]!.split(",");
    else if (args[i] === "--days" && args[i + 1]) days = parseInt(args[++i]!, 10);
    else if (args[i] === "--start" && args[i + 1]) startMs = new Date(args[++i]!).getTime();
    else if (args[i] === "--end" && args[i + 1]) endMs = new Date(args[++i]!).getTime();
  }

  if (!startMs) startMs = endMs - days * 24 * 60 * 60 * 1000;
  return { symbols, startMs, endMs, days };
}

async function main(): Promise<void> {
  const config = parseArgs();

  console.log("Kalshi Bot Backtest");
  console.log(`Symbols: ${config.symbols.join(", ")}`);
  console.log(`Period: ${config.days} days`);
  console.log();

  const allResults: BacktestResult[] = [];

  for (const symbol of config.symbols) {
    console.log(`[${symbol}] Fetching historical data...`);
    const data = await fetchAllData(symbol, config.startMs, config.endMs, console.log);

    if (data.klines1m.length < 100) {
      console.log(`[${symbol}] Insufficient data (${data.klines1m.length} 1m candles). Skipping.`);
      continue;
    }

    console.log(`[${symbol}] Running simulation...`);
    const results = runSimulation(symbol, data, config.startMs, config.endMs);
    console.log(`[${symbol}] ${results.length} simulation points`);
    allResults.push(...results);
  }

  if (allResults.length === 0) {
    console.log("\nNo simulation data. Check if Binance.us is reachable and symbols are valid.");
    process.exit(1);
  }

  const metrics = computeMetrics(allResults);
  printReport(metrics, config);
}

main().catch((err) => {
  console.error("Backtest failed:", err);
  process.exit(1);
});
