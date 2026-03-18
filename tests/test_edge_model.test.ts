import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import { computeEv, getCategoryFromMarketId, countCategoryDirection, evaluateCandidates } from "../src/edge_model.js";
import { initDb, logTrade, type TradeRecord } from "../src/logger.js";
import type { CandidateMarket } from "../src/scanner.js";

let tmpDb: string;

beforeEach(() => {
  tmpDb = path.join(os.tmpdir(), `test_edge_${Date.now()}_${Math.random().toString(36).slice(2)}.db`);
  initDb(tmpDb);
});

afterEach(() => {
  try { fs.unlinkSync(tmpDb); } catch { /* ignore */ }
});

function makeCandidate(overrides?: Partial<CandidateMarket>): CandidateMarket {
  return {
    marketId: "TEST-MKT-1",
    eventTicker: "TEST-EVENT-1",
    seriesTicker: "KXTEST",
    marketTitle: "Will event X happen?",
    category: "politics",
    marketCategory: "financial_hourly",
    closeTime: "2026-03-17T00:00:00Z",
    yesPrice: 0.55,
    noPrice: 0.45,
    yesBid: 0.53,
    noBid: 0.43,
    volume: 5000,
    openInterest: 1000,
    lastPrice: 0.54,
    directional: false,
    ...overrides,
  };
}

describe("computeEv", () => {
  it("positive EV for YES trade with edge", () => {
    const ev = computeEv(0.7, 0.55, "YES");
    expect(ev).toBeGreaterThan(0.05);
  });

  it("~0 EV when p_est = market price", () => {
    const ev = computeEv(0.55, 0.55, "YES");
    expect(ev).toBeCloseTo(0, 1);
  });

  it("negative EV when p_est below market price", () => {
    const ev = computeEv(0.4, 0.55, "YES");
    expect(ev).toBeLessThan(0);
  });

  it("positive EV for NO trade", () => {
    const ev = computeEv(0.3, 0.55, "NO");
    expect(ev).toBeGreaterThan(0);
  });

  it("high EV for extreme confidence", () => {
    const ev = computeEv(0.95, 0.5, "YES");
    expect(ev).toBeGreaterThan(0.5);
  });

  it("returns 0 for price = 0", () => {
    expect(computeEv(0.5, 0, "YES")).toBe(0);
  });

  it("returns 0 for price = 1", () => {
    expect(computeEv(0.5, 1, "YES")).toBe(0);
  });

  // Historical examples from CLAUDE.md
  it("Fed hold rates: Kalshi 55%, true 68%", () => {
    const ev = computeEv(0.68, 0.55, "YES");
    expect(ev).toBeCloseTo(0.236, 1);
  });

  it("CPI above 3%: Kalshi 40%, true 52%", () => {
    const ev = computeEv(0.52, 0.4, "YES");
    expect(ev).toBeGreaterThan(0.05);
  });

  it("Sports: Kalshi 65%, external 73%", () => {
    const ev = computeEv(0.73, 0.65, "YES");
    expect(ev).toBeGreaterThan(0.05);
  });

  it("No edge: Kalshi 60%, true 61%", () => {
    const ev = computeEv(0.61, 0.6, "YES");
    expect(ev).toBeLessThan(0.05);
  });

  it("Strong NO: Kalshi YES 70%, true 55%", () => {
    const ev = computeEv(0.55, 0.7, "NO");
    expect(ev).toBeGreaterThan(0.05);
  });
});

describe("getCategoryFromMarketId", () => {
  it("identifies crypto_15m from market id", () => {
    expect(getCategoryFromMarketId("KXBTC15M-26MAR162045-45-UP")).toBe("crypto_15m");
  });

  it("identifies crypto_15m for ETH", () => {
    expect(getCategoryFromMarketId("KXETH15M-26MAR162045-45-UP")).toBe("crypto_15m");
  });

  it("identifies crypto_hourly", () => {
    expect(getCategoryFromMarketId("KXBTCD-26MAR162045-B100000")).toBe("crypto_hourly");
  });

  it("identifies sports", () => {
    expect(getCategoryFromMarketId("KXNBA-26MAR-LAKERS")).toBe("sports");
  });

  it("identifies financial_hourly", () => {
    expect(getCategoryFromMarketId("KXINXU-26MAR162045-B5000")).toBe("financial_hourly");
  });

  it("returns null for unknown market", () => {
    expect(getCategoryFromMarketId("UNKNOWN-MKT-123")).toBeNull();
  });
});

describe("countCategoryDirection", () => {
  it("counts matching open positions", () => {
    const positions = [
      { market_id: "KXBTC15M-001", direction: "YES" },
      { market_id: "KXETH15M-002", direction: "YES" },
      { market_id: "KXETH15M-003", direction: "NO" },
    ] as TradeRecord[];

    // 2 crypto_15m YES positions
    expect(countCategoryDirection("crypto_15m", "YES", positions, [])).toBe(2);
    // 1 crypto_15m NO position
    expect(countCategoryDirection("crypto_15m", "NO", positions, [])).toBe(1);
  });

  it("counts approved signals too", () => {
    const positions = [
      { market_id: "KXBTC15M-001", direction: "YES" },
    ] as TradeRecord[];

    const signals = [
      { marketId: "KXETH15M-002", direction: "YES" as const, marketTitle: "", pEstimate: 0, marketPrice: 0, evPerDollar: 0, edgeSource: "", edgeRationale: "" },
    ];

    // 1 from positions + 1 from signals = 2
    expect(countCategoryDirection("crypto_15m", "YES", positions, signals)).toBe(2);
  });

  it("does not count different categories", () => {
    const positions = [
      { market_id: "KXNBA-001", direction: "YES" },
      { market_id: "KXBTC15M-002", direction: "YES" },
    ] as TradeRecord[];

    // Only 1 crypto_15m, not the sports one
    expect(countCategoryDirection("crypto_15m", "YES", positions, [])).toBe(1);
  });

  it("does not count different directions", () => {
    const positions = [
      { market_id: "KXBTC15M-001", direction: "NO" },
      { market_id: "KXETH15M-002", direction: "NO" },
    ] as TradeRecord[];

    expect(countCategoryDirection("crypto_15m", "YES", positions, [])).toBe(0);
  });

  it("returns 0 with no positions", () => {
    expect(countCategoryDirection("crypto_15m", "YES", [], [])).toBe(0);
  });
});

describe("evaluateCandidates", () => {
  it("evaluates normally even with 3 consecutive losses (Rule 8 handled by main.ts)", async () => {
    for (let i = 0; i < 3; i++) {
      logTrade({
        session_id: "test",
        market_id: `LOSS-${i}`,
        market_title: `Loss ${i}`,
        direction: "YES",
        edge_source: "test",
        edge_rationale: "test",
        p_estimate: 0.7,
        market_price: 0.55,
        ev_per_dollar: 0.1,
        kelly_fraction: 0.2,
        position_size: 10,
        bankroll_before: 100,
        status: "EXECUTED",
        resolution: "LOSS",
      }, tmpDb);
    }

    // Edge model no longer blocks — main.ts cooldown handles Rule 8
    const { signals, rejected } = await evaluateCandidates([makeCandidate()], 0.05, { dbPath: tmpDb });
    const total = signals.length + rejected.length;
    expect(total).toBe(1);
    for (const r of rejected) {
      expect(r.reason).not.toContain("MODEL_REVIEW");
    }
  });

  it("proceeds normally with no losses", async () => {
    const { rejected } = await evaluateCandidates([makeCandidate()], 0.05, { dbPath: tmpDb });
    for (const r of rejected) {
      expect(r.reason).not.toContain("MODEL_REVIEW");
    }
  });
});
