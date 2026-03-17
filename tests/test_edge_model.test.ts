import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import { computeEv, checkCorrelation, evaluateCandidates } from "../src/edge_model.js";
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

describe("checkCorrelation", () => {
  it("allows same market_id re-entry", () => {
    const positions = [{ market_id: "FED-HOLD", market_title: "Will Fed hold rates?" }] as TradeRecord[];
    expect(checkCorrelation("FED-HOLD", "Will Fed hold rates?", positions)).toBe(false);
  });

  it("detects similar titles", () => {
    const positions = [{
      market_id: "FED-HOLD",
      market_title: "Will the Federal Reserve hold interest rates?",
    }] as TradeRecord[];
    expect(
      checkCorrelation("FED-RATE-2026", "Will Federal Reserve raise interest rates?", positions),
    ).toBe(true);
  });

  it("allows different markets", () => {
    const positions = [{ market_id: "FED-HOLD", market_title: "Will Fed hold rates?" }] as TradeRecord[];
    expect(checkCorrelation("CPI-ABOVE-3", "Will CPI come in above 3%?", positions)).toBe(false);
  });

  it("allows when no open positions", () => {
    expect(checkCorrelation("ANY-MKT", "Any market title", [])).toBe(false);
  });
});

describe("evaluateCandidates", () => {
  it("rejects all on 3 consecutive losses (Rule 8)", async () => {
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

    const { signals, rejected } = await evaluateCandidates([makeCandidate()], 0.05, { dbPath: tmpDb });
    expect(signals).toHaveLength(0);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.reason).toContain("MODEL_REVIEW");
  });

  it("proceeds normally with no losses", async () => {
    const { rejected } = await evaluateCandidates([makeCandidate()], 0.05, { dbPath: tmpDb });
    for (const r of rejected) {
      expect(r.reason).not.toContain("MODEL_REVIEW");
    }
  });
});
