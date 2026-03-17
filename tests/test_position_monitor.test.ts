import { describe, it, expect, beforeEach } from "vitest";
import { calculatePnL, checkTrailingStop, cleanupPeaks } from "../src/position_monitor.js";

describe("calculatePnL", () => {
  it("calculates positive P&L correctly", () => {
    const result = calculatePnL(0.20, 0.35, 10);
    expect(result.pnl).toBeCloseTo(1.50, 2);
    expect(result.pnlPercent).toBeCloseTo(0.75, 2);
  });

  it("calculates negative P&L correctly", () => {
    const result = calculatePnL(0.50, 0.30, 5);
    expect(result.pnl).toBeCloseTo(-1.00, 2);
    expect(result.pnlPercent).toBeCloseTo(-0.40, 2);
  });

  it("handles zero entry price safely", () => {
    const result = calculatePnL(0, 0.50, 1);
    expect(result.pnlPercent).toBe(0);
  });

  it("scales P&L by contract count", () => {
    const one = calculatePnL(0.30, 0.60, 1);
    const ten = calculatePnL(0.30, 0.60, 10);
    expect(ten.pnl).toBeCloseTo(one.pnl * 10, 2);
    expect(ten.pnlPercent).toBeCloseTo(one.pnlPercent, 2);
  });
});

describe("checkTrailingStop", () => {
  beforeEach(() => {
    // Clear peak prices between tests
    cleanupPeaks(new Set());
  });

  it("does not trigger when position is not yet profitable", () => {
    // Entry at $0.40, current at $0.42 (only $0.02 above entry, below $0.05 min)
    const result = checkTrailingStop("TEST-1", 0.40, 0.42);
    expect(result).toBeNull();
  });

  it("does not trigger when price is still near peak", () => {
    // Entry at $0.20, first check at $0.80 (sets peak)
    checkTrailingStop("TEST-2", 0.20, 0.80);
    // Price drops slightly to $0.75 (6% drop, below 30% threshold)
    const result = checkTrailingStop("TEST-2", 0.20, 0.75);
    expect(result).toBeNull();
  });

  it("triggers when price drops 30%+ from peak", () => {
    // Entry at $0.20, peak at $0.80
    checkTrailingStop("TEST-3", 0.20, 0.80);
    // Price drops to $0.55 (31% drop from $0.80)
    const result = checkTrailingStop("TEST-3", 0.20, 0.55);
    expect(result).not.toBeNull();
    expect(result).toContain("TRAILING_STOP");
  });

  it("tracks peak across multiple calls", () => {
    // Price climbs: $0.30, $0.50, $0.70, $0.90
    checkTrailingStop("TEST-4", 0.20, 0.30);
    checkTrailingStop("TEST-4", 0.20, 0.50);
    checkTrailingStop("TEST-4", 0.20, 0.70);
    checkTrailingStop("TEST-4", 0.20, 0.90);
    // Drop to $0.62 (31% from peak of $0.90) → should trigger
    const result = checkTrailingStop("TEST-4", 0.20, 0.62);
    expect(result).not.toBeNull();
  });

  it("does not trigger on gradual decline within threshold", () => {
    // Peak at $0.80
    checkTrailingStop("TEST-5", 0.20, 0.80);
    // $0.75 = 6% drop
    expect(checkTrailingStop("TEST-5", 0.20, 0.75)).toBeNull();
    // $0.70 = 12.5% drop
    expect(checkTrailingStop("TEST-5", 0.20, 0.70)).toBeNull();
    // $0.60 = 25% drop
    expect(checkTrailingStop("TEST-5", 0.20, 0.60)).toBeNull();
  });

  it("triggers exactly at 30% drop", () => {
    // Peak at $1.00 (max for binary)
    checkTrailingStop("TEST-6", 0.20, 1.00);
    // $0.70 = exactly 30% drop
    const result = checkTrailingStop("TEST-6", 0.20, 0.70);
    expect(result).not.toBeNull();
  });

  it("does not trigger when position is losing", () => {
    // Entry at $0.50, price at $0.40 (losing, not above min profit)
    const result = checkTrailingStop("TEST-7", 0.50, 0.40);
    expect(result).toBeNull();
  });

  it("activates once profit exceeds minimum threshold", () => {
    // Entry at $0.30, needs $0.35+ to activate (min $0.05 profit)
    expect(checkTrailingStop("TEST-8", 0.30, 0.34)).toBeNull(); // not yet
    checkTrailingStop("TEST-8", 0.30, 0.70); // now profitable, sets peak
    // 31% drop from $0.70 = $0.483
    const result = checkTrailingStop("TEST-8", 0.30, 0.48);
    expect(result).not.toBeNull();
  });
});

describe("cleanupPeaks", () => {
  beforeEach(() => {
    cleanupPeaks(new Set());
  });

  it("removes peaks for expired tickers", () => {
    // Set peaks for two tickers
    checkTrailingStop("ACTIVE-1", 0.20, 0.80);
    checkTrailingStop("EXPIRED-1", 0.20, 0.70);

    // Only ACTIVE-1 is still active
    cleanupPeaks(new Set(["ACTIVE-1"]));

    // EXPIRED-1 peak ($0.70) should be gone — next call starts fresh
    // $0.40 becomes new peak, no drop from it → null (hold)
    const result = checkTrailingStop("EXPIRED-1", 0.20, 0.40);
    expect(result).toBeNull();
  });
});
