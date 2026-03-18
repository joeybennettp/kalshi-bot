import { describe, it, expect } from "vitest";
import {
  computeEma,
  getEmaCrossSignal,
  computeRsi,
  computeMacdHistogram,
  getPriceVsVwap,
  getVolumeTrend,
  computeTrendProbability,
  analyzeTrend,
} from "../src/trend_analysis.js";
import type { Kline, PriceData } from "../src/price_feeds.js";

function makeKline(close: number, volume: number = 100, high?: number, low?: number): Kline {
  return {
    openTime: Date.now(),
    open: close,
    high: high ?? close * 1.001,
    low: low ?? close * 0.999,
    close,
    volume,
    closeTime: Date.now(),
  };
}

describe("computeEma", () => {
  it("returns single value for single input", () => {
    expect(computeEma([100], 5)).toEqual([100]);
  });

  it("converges toward price", () => {
    const closes = [100, 100, 100, 100, 100];
    const ema = computeEma(closes, 3);
    expect(ema[4]).toBeCloseTo(100);
  });

  it("follows price trend upward", () => {
    const closes = [100, 102, 104, 106, 108, 110];
    const ema = computeEma(closes, 3);
    // EMA should be rising
    expect(ema[5]!).toBeGreaterThan(ema[3]!);
  });

  it("returns empty for empty input", () => {
    expect(computeEma([], 5)).toEqual([]);
  });
});

describe("getEmaCrossSignal", () => {
  it("returns BULLISH for rising prices", () => {
    const closes = Array.from({ length: 20 }, (_, i) => 100 + i * 2);
    expect(getEmaCrossSignal(closes)).toBe("BULLISH");
  });

  it("returns BEARISH for falling prices", () => {
    const closes = Array.from({ length: 20 }, (_, i) => 200 - i * 2);
    expect(getEmaCrossSignal(closes)).toBe("BEARISH");
  });

  it("returns NEUTRAL for insufficient data", () => {
    expect(getEmaCrossSignal([100, 101])).toBe("NEUTRAL");
  });
});

describe("computeRsi", () => {
  it("returns ~50 for alternating up/down", () => {
    const closes: number[] = [];
    for (let i = 0; i < 30; i++) {
      closes.push(100 + (i % 2 === 0 ? 1 : -1));
    }
    const rsi = computeRsi(closes);
    expect(rsi).toBeGreaterThan(30);
    expect(rsi).toBeLessThan(70);
  });

  it("returns high RSI for all-up data", () => {
    const closes = Array.from({ length: 30 }, (_, i) => 100 + i);
    expect(computeRsi(closes)).toBeGreaterThan(80);
  });

  it("returns low RSI for all-down data", () => {
    const closes = Array.from({ length: 30 }, (_, i) => 200 - i);
    expect(computeRsi(closes)).toBeLessThan(20);
  });

  it("returns 50 for insufficient data", () => {
    expect(computeRsi([100, 101])).toBe(50);
  });
});

describe("computeMacdHistogram", () => {
  it("positive histogram for uptrend", () => {
    const closes = Array.from({ length: 50 }, (_, i) => 100 + i);
    expect(computeMacdHistogram(closes)).toBeGreaterThan(0);
  });

  it("negative histogram for downtrend", () => {
    const closes = Array.from({ length: 50 }, (_, i) => 200 - i);
    expect(computeMacdHistogram(closes)).toBeLessThan(0);
  });

  it("returns 0 for insufficient data", () => {
    expect(computeMacdHistogram([100, 101])).toBe(0);
  });
});

describe("getPriceVsVwap", () => {
  it("returns ABOVE when price is above VWAP", () => {
    // Klines where latest close is above the volume-weighted average
    const klines = [
      makeKline(100, 1000),
      makeKline(100, 1000),
      makeKline(110, 100), // small volume at high price
    ];
    // VWAP ≈ (100*1000 + 100*1000 + 110*100) / 2100 ≈ 100.5
    // Last close = 110, so ABOVE
    expect(getPriceVsVwap(klines)).toBe("ABOVE");
  });

  it("returns BELOW when price is below VWAP", () => {
    const klines = [
      makeKline(110, 1000),
      makeKline(110, 1000),
      makeKline(100, 100),
    ];
    expect(getPriceVsVwap(klines)).toBe("BELOW");
  });

  it("handles empty klines", () => {
    expect(getPriceVsVwap([])).toBe("ABOVE");
  });
});

describe("getVolumeTrend", () => {
  it("INCREASING when recent volume > earlier", () => {
    const klines = [
      makeKline(100, 50), makeKline(100, 50), makeKline(100, 50),
      makeKline(100, 200), makeKline(100, 200), makeKline(100, 200),
    ];
    expect(getVolumeTrend(klines)).toBe("INCREASING");
  });

  it("DECREASING when recent volume < earlier", () => {
    const klines = [
      makeKline(100, 200), makeKline(100, 200), makeKline(100, 200),
      makeKline(100, 50), makeKline(100, 50), makeKline(100, 50),
    ];
    expect(getVolumeTrend(klines)).toBe("DECREASING");
  });

  it("FLAT for insufficient data", () => {
    expect(getVolumeTrend([makeKline(100)])).toBe("FLAT");
  });
});

describe("computeTrendProbability", () => {
  it("returns ~0.50 for all neutral indicators", () => {
    const p = computeTrendProbability({
      emaCross: "NEUTRAL",
      rsi: 50,
      macdHistogram: 0,
      priceVsVwap: "ABOVE",
      volumeTrend: "FLAT",
    });
    // Only VWAP adds +0.03, so expect ~0.53
    expect(p).toBeGreaterThan(0.48);
    expect(p).toBeLessThan(0.58);
  });

  it("caps at 0.70 for all bullish", () => {
    const p = computeTrendProbability({
      emaCross: "BULLISH",
      rsi: 55,
      macdHistogram: 1.0,
      priceVsVwap: "ABOVE",
      volumeTrend: "INCREASING",
    });
    expect(p).toBeLessThanOrEqual(0.70);
  });

  it("caps at 0.30 for all bearish", () => {
    const p = computeTrendProbability({
      emaCross: "BEARISH",
      rsi: 45,
      macdHistogram: -1.0,
      priceVsVwap: "BELOW",
      volumeTrend: "INCREASING",
    });
    expect(p).toBeGreaterThanOrEqual(0.30);
  });

  it("RSI overbought reduces bullish score", () => {
    const bullish = computeTrendProbability({
      emaCross: "BULLISH",
      rsi: 55,
      macdHistogram: 1.0,
      priceVsVwap: "ABOVE",
      volumeTrend: "FLAT",
    });
    const overbought = computeTrendProbability({
      emaCross: "BULLISH",
      rsi: 80,
      macdHistogram: 1.0,
      priceVsVwap: "ABOVE",
      volumeTrend: "FLAT",
    });
    expect(overbought).toBeLessThan(bullish);
  });
});

describe("analyzeTrend", () => {
  it("produces mean-reversion DOWN signal for uptrending 15m data", () => {
    // On 15m timeframe, trend indicators are flipped for mean-reversion.
    // Uptrending data → model predicts reversion → DOWN.
    const klines1m = Array.from({ length: 60 }, (_, i) => makeKline(100 + i * 0.5));
    const klines5m = Array.from({ length: 50 }, (_, i) => makeKline(100 + i * 2));
    const klines15m = Array.from({ length: 30 }, (_, i) => makeKline(100 + i * 5));

    const priceData: PriceData = {
      snapshot: {
        symbol: "BTCUSDT",
        currentPrice: 130,
        priceChange24h: 2.5,
        volume24h: 1000000,
        high24h: 135,
        low24h: 95,
      },
      klines1m,
      klines5m,
      klines15m,
    };

    const signal = analyzeTrend(priceData, "15m");
    expect(signal.direction).toBe("DOWN");
    expect(signal.pUp).toBeLessThan(0.5);
    expect(signal.confidence).toBeGreaterThan(0);
    expect(signal.rationale).toBeTruthy();
  });

  it("produces mean-reversion UP signal for downtrending 15m data", () => {
    // Downtrending data → model predicts bounce → UP.
    const klines1m = Array.from({ length: 60 }, (_, i) => makeKline(200 - i * 0.5));
    const klines5m = Array.from({ length: 50 }, (_, i) => makeKline(200 - i * 2));
    const klines15m = Array.from({ length: 30 }, (_, i) => makeKline(200 - i * 5));

    const priceData: PriceData = {
      snapshot: {
        symbol: "BTCUSDT",
        currentPrice: 170,
        priceChange24h: -5.0,
        volume24h: 1000000,
        high24h: 205,
        low24h: 165,
      },
      klines1m,
      klines5m,
      klines15m,
    };

    const signal = analyzeTrend(priceData, "15m");
    expect(signal.direction).toBe("UP");
    expect(signal.pUp).toBeGreaterThan(0.5);
  });
});
