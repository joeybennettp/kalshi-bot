import { describe, it, expect } from "vitest";
import { computeKelly, sizeTrade, getMaxPositionPercent } from "../src/sizer.js";
import type { TradeSignal } from "../src/edge_model.js";

function makeSignal(overrides?: Partial<TradeSignal>): TradeSignal {
  return {
    marketId: "FED-HOLD-2026",
    marketTitle: "Will Fed hold rates?",
    direction: "YES",
    pEstimate: 0.68,
    marketPrice: 0.55,
    evPerDollar: 0.1,
    edgeSource: "external_odds_arbitrage",
    edgeRationale: "Test signal.",
    ...overrides,
  };
}

describe("computeKelly", () => {
  it("computes positive edge for YES (CLAUDE.md example: p=0.68, price=0.55)", () => {
    const kelly = computeKelly(0.68, 0.55, "YES");
    expect(kelly).toBeCloseTo(0.289, 2);
  });

  it("returns ~0 for fairly priced market", () => {
    const kelly = computeKelly(0.5, 0.5, "YES");
    expect(kelly).toBeCloseTo(0, 2);
  });

  it("returns negative for NO trade without edge", () => {
    const kelly = computeKelly(0.68, 0.55, "NO");
    expect(kelly).toBeLessThan(0);
  });

  it("returns large fraction for extreme edge", () => {
    const kelly = computeKelly(0.95, 0.4, "YES");
    expect(kelly).toBeGreaterThan(0.5);
  });

  it("returns 0 for price = 0", () => {
    expect(computeKelly(0.5, 0, "YES")).toBe(0);
  });

  it("returns 0 for price = 1", () => {
    expect(computeKelly(0.5, 1, "YES")).toBe(0);
  });
});

describe("sizeTrade", () => {
  it("reproduces the CLAUDE.md Section 5 example", () => {
    const signal = makeSignal({ pEstimate: 0.68, marketPrice: 0.55 });
    const result = sizeTrade(signal, 100);

    expect(result).not.toBeNull();
    expect(result!.kellyFraction).toBeCloseTo(0.289, 2);
    expect(result!.halfKellyFraction).toBeCloseTo(0.144, 2);
    expect(result!.positionSize).toBeCloseTo(14.44, 0);
    expect(result!.sizeCapApplied).toBeNull(); // 14.4% < 25%
  });

  it("caps at 25% for $0-$500 bankroll", () => {
    const signal = makeSignal({ pEstimate: 0.95, marketPrice: 0.4 });
    const result = sizeTrade(signal, 100);

    expect(result).not.toBeNull();
    expect(result!.positionSize).toBeLessThanOrEqual(25); // 25% of $100
  });

  it("caps at 20% for $500-$5000 bankroll", () => {
    const signal = makeSignal({ pEstimate: 0.95, marketPrice: 0.4 });
    const result = sizeTrade(signal, 1000);

    expect(result).not.toBeNull();
    expect(result!.positionSize).toBeLessThanOrEqual(200); // 20% of $1000
  });

  it("caps at 15% for $5000-$50000 bankroll", () => {
    const signal = makeSignal({ pEstimate: 0.95, marketPrice: 0.4 });
    const result = sizeTrade(signal, 10000);

    expect(result).not.toBeNull();
    expect(result!.positionSize).toBeLessThanOrEqual(1500); // 15% of $10000
  });

  it("caps at 10% for $50000+ bankroll", () => {
    const signal = makeSignal({ pEstimate: 0.95, marketPrice: 0.4 });
    const result = sizeTrade(signal, 100000);

    expect(result).not.toBeNull();
    expect(result!.positionSize).toBeLessThanOrEqual(10000); // 10% of $100000
  });

  it("rejects positions below $2 minimum", () => {
    const signal = makeSignal({ pEstimate: 0.52, marketPrice: 0.5 });
    const result = sizeTrade(signal, 10);
    expect(result).toBeNull();
  });

  it("rejects when Kelly is negative (no edge)", () => {
    const signal = makeSignal({ pEstimate: 0.4, marketPrice: 0.55 });
    const result = sizeTrade(signal, 100);
    expect(result).toBeNull();
  });

  it("applies liquidity cap for large bankrolls", () => {
    const signal = makeSignal({ pEstimate: 0.8, marketPrice: 0.5 });
    const result = sizeTrade(signal, 20000, 1000);

    expect(result).not.toBeNull();
    expect(result!.positionSize).toBeLessThanOrEqual(250); // 25% of $1000
    expect(result!.sizeCapApplied).toBe("LIQUIDITY_CAP_25PCT");
  });

  it("rounds position size down to nearest cent", () => {
    const signal = makeSignal({ pEstimate: 0.68, marketPrice: 0.55 });
    const result = sizeTrade(signal, 100);

    expect(result).not.toBeNull();
    expect(result!.positionSize * 100).toBe(Math.floor(result!.positionSize * 100));
  });
});

describe("getMaxPositionPercent", () => {
  it("returns 25% for small bankroll", () => {
    expect(getMaxPositionPercent(100)).toBe(0.25);
  });

  it("returns 20% for medium bankroll", () => {
    expect(getMaxPositionPercent(1000)).toBe(0.2);
  });

  it("returns 15% for large bankroll", () => {
    expect(getMaxPositionPercent(10000)).toBe(0.15);
  });

  it("returns 10% for very large bankroll", () => {
    expect(getMaxPositionPercent(100000)).toBe(0.1);
  });

  it("returns 25% at $500 boundary", () => {
    expect(getMaxPositionPercent(500)).toBe(0.25);
  });

  it("returns 20% at $5000 boundary", () => {
    expect(getMaxPositionPercent(5000)).toBe(0.2);
  });

  it("returns 15% at $50000 boundary", () => {
    expect(getMaxPositionPercent(50000)).toBe(0.15);
  });
});
