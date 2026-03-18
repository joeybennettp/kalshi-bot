import { describe, it, expect, beforeEach } from "vitest";
import { calculatePnL, checkProfitLock, cleanupPeaks } from "../src/position_monitor.js";

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

describe("checkProfitLock", () => {
  beforeEach(() => {
    // Clear peak prices and profit lock state between tests
    cleanupPeaks(new Set());
  });

  it("does not trigger when position has not reached 2x entry", () => {
    // Entry at $0.20, current at $0.35 (75% gain, below 2x trigger)
    const result = checkProfitLock("TEST-1", 0.20, 0.35);
    expect(result).toBeNull();
  });

  it("does not trigger when position is losing", () => {
    // Entry at $0.50, current at $0.30 (losing — never reached 2x)
    const result = checkProfitLock("TEST-2", 0.50, 0.30);
    expect(result).toBeNull();
  });

  it("activates profit lock when price reaches 2x entry", () => {
    // Entry at $0.20, price hits $0.40 (2x) → lock activates
    checkProfitLock("TEST-3", 0.20, 0.40);
    // Price drops to $0.30 (1.5x entry = floor) → should sell
    const result = checkProfitLock("TEST-3", 0.20, 0.30);
    expect(result).not.toBeNull();
    expect(result).toContain("PROFIT_LOCK");
  });

  it("holds when price is above floor after lock activates", () => {
    // Entry at $0.20, price hits $0.40 (2x) → lock activates
    checkProfitLock("TEST-4", 0.20, 0.40);
    // Price at $0.35 (above floor of $0.30) → hold
    const result = checkProfitLock("TEST-4", 0.20, 0.35);
    expect(result).toBeNull();
  });

  it("triggers exactly at floor price", () => {
    // Entry at $0.20, floor = $0.30
    checkProfitLock("TEST-5", 0.20, 0.42); // above 2x → activates
    const result = checkProfitLock("TEST-5", 0.20, 0.30); // exactly at floor
    expect(result).not.toBeNull();
  });

  it("remembers activation across multiple calls", () => {
    // Entry at $0.20
    checkProfitLock("TEST-6", 0.20, 0.40); // hits 2x → activates
    checkProfitLock("TEST-6", 0.20, 0.50); // goes higher
    checkProfitLock("TEST-6", 0.20, 0.45); // small dip, above floor
    expect(checkProfitLock("TEST-6", 0.20, 0.35)).toBeNull(); // still above floor
    // Now drops to floor
    const result = checkProfitLock("TEST-6", 0.20, 0.30);
    expect(result).not.toBeNull();
  });

  it("never triggers if 2x was never reached", () => {
    // Entry at $0.20, price goes up to $0.38 (1.9x, just under 2x)
    checkProfitLock("TEST-7", 0.20, 0.38);
    // Then drops to $0.10 — still no trigger (lock never activated)
    const result = checkProfitLock("TEST-7", 0.20, 0.10);
    expect(result).toBeNull();
  });

  it("works with higher entry prices", () => {
    // Entry at $0.40, 2x = $0.80, floor = $0.60
    checkProfitLock("TEST-8", 0.40, 0.82); // above 2x → activates
    expect(checkProfitLock("TEST-8", 0.40, 0.65)).toBeNull(); // above floor
    const result = checkProfitLock("TEST-8", 0.40, 0.59); // below floor
    expect(result).not.toBeNull();
  });
});

describe("cleanupPeaks", () => {
  beforeEach(() => {
    cleanupPeaks(new Set());
  });

  it("removes state for expired tickers", () => {
    // Activate profit lock for two tickers
    checkProfitLock("ACTIVE-1", 0.20, 0.45); // above 2x
    checkProfitLock("EXPIRED-1", 0.20, 0.45); // above 2x

    // Only ACTIVE-1 is still active
    cleanupPeaks(new Set(["ACTIVE-1"]));

    // EXPIRED-1 state should be gone — 2x check starts fresh
    // Price at $0.30 with no prior peak → no activation → no trigger
    const result = checkProfitLock("EXPIRED-1", 0.20, 0.30);
    expect(result).toBeNull();
  });
});
