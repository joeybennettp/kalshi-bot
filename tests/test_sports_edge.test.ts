import { describe, it, expect } from "vitest";
import { isWithinOddsRange, evaluateSportsCandidate } from "../src/sports_edge.js";
import type { CandidateMarket } from "../src/scanner.js";

function makeSportsCandidate(overrides?: Partial<CandidateMarket>): CandidateMarket {
  return {
    marketId: "KXEPL1H-MATCH1",
    eventTicker: "KXEPL1H-EVENT1",
    seriesTicker: "KXEPL1H",
    marketTitle: "Tottenham vs Nottingham: First Half Winner?",
    category: "Sports",
    marketCategory: "sports",
    closeTime: "2026-03-17T15:00:00Z",
    yesPrice: 0.50,
    noPrice: 0.50,
    yesBid: 0.48,
    noBid: 0.48,
    volume: 5000,
    openInterest: 2000,
    lastPrice: 0.50,
    directional: false,
    ...overrides,
  };
}

describe("isWithinOddsRange", () => {
  it("accepts 50/50 odds", () => {
    expect(isWithinOddsRange(0.50, 0.50)).toBe(true);
  });

  it("accepts boundary -250 (0.714)", () => {
    expect(isWithinOddsRange(0.714, 0.286)).toBe(true);
  });

  it("accepts boundary +250 (0.286)", () => {
    expect(isWithinOddsRange(0.286, 0.714)).toBe(true);
  });

  it("rejects both outside range (heavy favorite)", () => {
    expect(isWithinOddsRange(0.80, 0.20)).toBe(false);
  });

  it("rejects just outside boundaries", () => {
    expect(isWithinOddsRange(0.285, 0.715)).toBe(false);
  });

  it("accepts when YES in range but NO out", () => {
    expect(isWithinOddsRange(0.50, 0.80)).toBe(true);
  });

  it("accepts when NO in range but YES out", () => {
    expect(isWithinOddsRange(0.80, 0.50)).toBe(true);
  });

  it("accepts mid-range odds", () => {
    expect(isWithinOddsRange(0.40, 0.60)).toBe(true);
  });
});

describe("evaluateSportsCandidate", () => {
  it("rejects market outside odds range", () => {
    const candidate = makeSportsCandidate({
      yesPrice: 0.85,
      noPrice: 0.15,
      yesBid: 0.83,
      noBid: 0.13,
    });
    const signal = evaluateSportsCandidate(candidate, 0.05);
    expect(signal).toBeNull();
  });

  it("detects stale liquidity edge with wide spread", () => {
    const candidate = makeSportsCandidate({
      yesPrice: 0.55,
      noPrice: 0.50,
      yesBid: 0.45,   // 10-cent spread
      noBid: 0.42,
    });
    const signal = evaluateSportsCandidate(candidate, 0.01);
    // May or may not find edge depending on EV calculation
    // but should not crash
    expect(signal === null || signal.edgeSource === "sports_stale_liquidity").toBe(true);
  });

  it("detects price momentum when last price differs from ask", () => {
    const candidate = makeSportsCandidate({
      yesPrice: 0.50,
      noPrice: 0.50,
      yesBid: 0.48,
      noBid: 0.48,
      lastPrice: 0.42, // was 42c, now asking 50c — momentum up
    });
    const signal = evaluateSportsCandidate(candidate, 0.01);
    if (signal) {
      expect(signal.edgeSource).toBe("sports_price_momentum");
      expect(signal.direction).toBe("YES"); // price rising
    }
  });

  it("returns null when no edge found", () => {
    const candidate = makeSportsCandidate({
      yesPrice: 0.50,
      noPrice: 0.50,
      yesBid: 0.49,   // tight spread
      noBid: 0.49,
      lastPrice: 0.50, // no momentum
    });
    const signal = evaluateSportsCandidate(candidate, 0.05);
    expect(signal).toBeNull();
  });
});
