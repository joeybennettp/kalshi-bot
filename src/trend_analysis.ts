/**
 * Multi-timeframe technical analysis for crypto price prediction.
 *
 * Indicators:
 *   - EMA crossover (5/13 period) — trend direction
 *   - RSI (14 period) — overbought/oversold
 *   - MACD (12/26/9) — momentum confirmation
 *   - VWAP — price vs volume-weighted average
 *   - Volume trend — confirms or weakens signals
 *
 * Outputs a probability estimate p(up) capped at [0.30, 0.70].
 */

import type { Kline, PriceData } from "./price_feeds.js";

export interface TrendSignal {
  direction: "UP" | "DOWN" | "NEUTRAL";
  pUp: number;              // probability of price going up
  confidence: number;       // 0.0 to 1.0 — how many indicators agree
  rationale: string;
  indicators: {
    emaCross: "BULLISH" | "BEARISH" | "NEUTRAL";
    rsi: number;
    macdHistogram: number;
    priceVsVwap: "ABOVE" | "BELOW";
    volumeTrend: "INCREASING" | "DECREASING" | "FLAT";
  };
}

// ──────────────────────── EMA ────────────────────────

/**
 * Compute Exponential Moving Average from an array of closing prices.
 */
export function computeEma(closes: number[], period: number): number[] {
  if (closes.length === 0) return [];
  const k = 2 / (period + 1);
  const ema: number[] = [closes[0]!];

  for (let i = 1; i < closes.length; i++) {
    ema.push(closes[i]! * k + ema[i - 1]! * (1 - k));
  }
  return ema;
}

/**
 * Determine EMA crossover direction from short and long EMAs.
 */
export function getEmaCrossSignal(
  closes: number[],
  shortPeriod: number = 5,
  longPeriod: number = 13,
): "BULLISH" | "BEARISH" | "NEUTRAL" {
  if (closes.length < longPeriod + 2) return "NEUTRAL";

  const emaShort = computeEma(closes, shortPeriod);
  const emaLong = computeEma(closes, longPeriod);

  const last = emaShort.length - 1;
  const prev = last - 1;

  const shortAboveNow = emaShort[last]! > emaLong[last]!;
  const shortAbovePrev = emaShort[prev]! > emaLong[prev]!;

  // Fresh crossover is strongest signal
  if (shortAboveNow && !shortAbovePrev) return "BULLISH";
  if (!shortAboveNow && shortAbovePrev) return "BEARISH";

  // Continuing trend
  if (shortAboveNow) return "BULLISH";
  return "BEARISH";
}

// ──────────────────────── RSI ────────────────────────

/**
 * Compute RSI (Relative Strength Index).
 * Returns the most recent RSI value (0-100).
 */
export function computeRsi(closes: number[], period: number = 14): number {
  if (closes.length < period + 1) return 50; // neutral default

  let avgGain = 0;
  let avgLoss = 0;

  // Initial average gain/loss
  for (let i = 1; i <= period; i++) {
    const change = closes[i]! - closes[i - 1]!;
    if (change > 0) avgGain += change;
    else avgLoss += Math.abs(change);
  }
  avgGain /= period;
  avgLoss /= period;

  // Smoothed RSI
  for (let i = period + 1; i < closes.length; i++) {
    const change = closes[i]! - closes[i - 1]!;
    if (change > 0) {
      avgGain = (avgGain * (period - 1) + change) / period;
      avgLoss = (avgLoss * (period - 1)) / period;
    } else {
      avgGain = (avgGain * (period - 1)) / period;
      avgLoss = (avgLoss * (period - 1) + Math.abs(change)) / period;
    }
  }

  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

// ──────────────────────── MACD ────────────────────────

/**
 * Compute MACD histogram (12/26/9 default).
 * Returns the most recent histogram value.
 */
export function computeMacdHistogram(
  closes: number[],
  fastPeriod: number = 12,
  slowPeriod: number = 26,
  signalPeriod: number = 9,
): number {
  if (closes.length < slowPeriod + signalPeriod) return 0;

  const emaFast = computeEma(closes, fastPeriod);
  const emaSlow = computeEma(closes, slowPeriod);

  // MACD line = fast EMA - slow EMA
  const macdLine: number[] = [];
  for (let i = 0; i < closes.length; i++) {
    macdLine.push(emaFast[i]! - emaSlow[i]!);
  }

  // Signal line = EMA of MACD line
  const signalLine = computeEma(macdLine, signalPeriod);

  // Histogram = MACD - Signal
  const last = macdLine.length - 1;
  return macdLine[last]! - signalLine[last]!;
}

// ──────────────────────── VWAP ────────────────────────

/**
 * Compute VWAP (Volume Weighted Average Price) and compare to current price.
 */
export function getPriceVsVwap(klines: Kline[]): "ABOVE" | "BELOW" {
  if (klines.length === 0) return "ABOVE";

  let cumulativeTPV = 0; // typical price * volume
  let cumulativeVol = 0;

  for (const k of klines) {
    const typicalPrice = (k.high + k.low + k.close) / 3;
    cumulativeTPV += typicalPrice * k.volume;
    cumulativeVol += k.volume;
  }

  if (cumulativeVol === 0) return "ABOVE";
  const vwap = cumulativeTPV / cumulativeVol;
  const currentPrice = klines[klines.length - 1]!.close;

  return currentPrice >= vwap ? "ABOVE" : "BELOW";
}

// ──────────────────────── Volume Trend ────────────────────────

/**
 * Determine if volume is increasing, decreasing, or flat.
 */
export function getVolumeTrend(klines: Kline[]): "INCREASING" | "DECREASING" | "FLAT" {
  if (klines.length < 6) return "FLAT";

  const recent = klines.slice(-3);
  const earlier = klines.slice(-6, -3);

  const recentAvg = recent.reduce((s, k) => s + k.volume, 0) / recent.length;
  const earlierAvg = earlier.reduce((s, k) => s + k.volume, 0) / earlier.length;

  if (earlierAvg === 0) return "FLAT";
  const ratio = recentAvg / earlierAvg;

  if (ratio > 1.3) return "INCREASING";
  if (ratio < 0.7) return "DECREASING";
  return "FLAT";
}

// ──────────────────────── Combine ────────────────────────

/**
 * Combine all indicators into a probability estimate.
 * Returns pUp in [0.30, 0.70].
 */
export function computeTrendProbability(indicators: TrendSignal["indicators"]): number {
  let score = 0.50; // base: coin flip

  // EMA cross: +/- 0.06
  if (indicators.emaCross === "BULLISH") score += 0.06;
  else if (indicators.emaCross === "BEARISH") score -= 0.06;

  // RSI: mean-reversion for extremes, trend-following for moderate
  if (indicators.rsi > 75) score -= 0.05;       // overbought → likely reversal
  else if (indicators.rsi < 25) score += 0.05;   // oversold → likely bounce
  else if (indicators.rsi > 60) score += 0.02;   // mild bullish
  else if (indicators.rsi < 40) score -= 0.02;   // mild bearish

  // MACD histogram: +/- 0.04
  if (indicators.macdHistogram > 0) score += 0.04;
  else if (indicators.macdHistogram < 0) score -= 0.04;

  // VWAP: +/- 0.03
  if (indicators.priceVsVwap === "ABOVE") score += 0.03;
  else score -= 0.03;

  // Volume confirmation: strengthen signal if volume supports
  if (indicators.volumeTrend === "INCREASING") {
    // Volume confirms whatever direction we're leaning
    if (score > 0.5) score += 0.02;
    else if (score < 0.5) score -= 0.02;
  }

  // Cap at [0.30, 0.70]
  return Math.max(0.30, Math.min(0.70, score));
}

// ──────────────────────── Main Entry ────────────────────────

/**
 * Analyze price data and produce a trend signal.
 *
 * @param priceData - Full price data from Binance
 * @param timeframe - "15m" for 15-minute markets (uses 1m/5m klines),
 *                    "1h" for hourly markets (uses 5m/15m klines)
 */
export function analyzeTrend(
  priceData: PriceData,
  timeframe: "15m" | "1h",
): TrendSignal {
  // Select klines based on timeframe
  const fastKlines = timeframe === "15m" ? priceData.klines1m : priceData.klines5m;
  const slowKlines = timeframe === "15m" ? priceData.klines5m : priceData.klines15m;

  const fastCloses = fastKlines.map((k) => k.close);
  const slowCloses = slowKlines.map((k) => k.close);

  // Compute indicators
  const emaCross = getEmaCrossSignal(fastCloses, 5, 13);
  const rsi = computeRsi(slowCloses, 14);
  const macdHistogram = computeMacdHistogram(slowCloses, 12, 26, 9);
  const priceVsVwap = getPriceVsVwap(fastKlines);
  const volumeTrend = getVolumeTrend(fastKlines);

  const indicators = { emaCross, rsi, macdHistogram, priceVsVwap, volumeTrend };
  const pUp = computeTrendProbability(indicators);

  // Compute confidence: how many indicators agree
  let bullishCount = 0;
  let bearishCount = 0;
  if (emaCross === "BULLISH") bullishCount++; else if (emaCross === "BEARISH") bearishCount++;
  if (rsi > 55) bullishCount++; else if (rsi < 45) bearishCount++;
  if (macdHistogram > 0) bullishCount++; else if (macdHistogram < 0) bearishCount++;
  if (priceVsVwap === "ABOVE") bullishCount++; else bearishCount++;

  const maxAgree = Math.max(bullishCount, bearishCount);
  const confidence = maxAgree / 4; // 0.25 to 1.0

  let direction: "UP" | "DOWN" | "NEUTRAL";
  if (pUp > 0.54) direction = "UP";
  else if (pUp < 0.46) direction = "DOWN";
  else direction = "NEUTRAL";

  // Build rationale
  const parts: string[] = [];
  parts.push(`EMA(5/13): ${emaCross}`);
  parts.push(`RSI(14): ${rsi.toFixed(1)}`);
  parts.push(`MACD: ${macdHistogram > 0 ? "+" : ""}${macdHistogram.toFixed(4)}`);
  parts.push(`VWAP: ${priceVsVwap}`);
  parts.push(`Vol: ${volumeTrend}`);

  const rationale =
    `Trend ${direction} (conf ${(confidence * 100).toFixed(0)}%). ` +
    `p(up)=${(pUp * 100).toFixed(1)}%. ` +
    parts.join(", ") + ".";

  return { direction, pUp, confidence, rationale, indicators };
}
