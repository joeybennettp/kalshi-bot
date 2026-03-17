import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import { executeTrade } from "../src/executor.js";
import type { SizedTrade } from "../src/sizer.js";
import { initDb, getDb } from "../src/logger.js";

let tmpDb: string;

beforeEach(() => {
  tmpDb = path.join(os.tmpdir(), `test_exec_${Date.now()}_${Math.random().toString(36).slice(2)}.db`);
  initDb(tmpDb);
});

afterEach(() => {
  try { fs.unlinkSync(tmpDb); } catch { /* ignore */ }
});

function makeSizedTrade(overrides?: Partial<SizedTrade>): SizedTrade {
  return {
    marketId: "FED-HOLD-2026",
    marketTitle: "Will Fed hold rates?",
    direction: "YES",
    pEstimate: 0.68,
    marketPrice: 0.55,
    evPerDollar: 0.1,
    edgeSource: "external_odds_arbitrage",
    edgeRationale: "Polymarket 72% vs Kalshi 55%. Trading YES.",
    kellyFraction: 0.289,
    halfKellyFraction: 0.144,
    uncappedSize: 14.44,
    positionSize: 14.44,
    sizeCapApplied: null,
    ...overrides,
  };
}

function mockApi(response: Record<string, unknown>) {
  return async () => response;
}

function mockApiError(error: Error) {
  return async () => { throw error; };
}

describe("trade logging (Rule 7)", () => {
  it("logs trade to DB before execution", async () => {
    const result = await executeTrade(makeSizedTrade(), "session-1", 100, {
      dbPath: tmpDb,
      _apiOverride: mockApi({ order: { order_id: "ord_123", avg_price: 55 } }),
    });

    const db = getDb(tmpDb);
    const row = db.prepare("SELECT * FROM trades WHERE id = ?").get(result.tradeId) as Record<string, unknown>;
    db.close();

    expect(row).toBeDefined();
    expect(row["market_id"]).toBe("FED-HOLD-2026");
    expect(row["status"]).toBe("EXECUTED");
    expect(row["session_id"]).toBe("session-1");
  });

  it("populates all required schema fields", async () => {
    const result = await executeTrade(makeSizedTrade(), "session-1", 100, {
      dbPath: tmpDb,
      _apiOverride: mockApi({ order: { order_id: "ord_123", avg_price: 55 } }),
    });

    const db = getDb(tmpDb);
    const row = db.prepare("SELECT * FROM trades WHERE id = ?").get(result.tradeId) as Record<string, unknown>;
    db.close();

    expect(row["timestamp"]).toBeTruthy();
    expect(row["session_id"]).toBeTruthy();
    expect(row["market_id"]).toBeTruthy();
    expect(row["market_title"]).toBeTruthy();
    expect(row["direction"]).toBeTruthy();
    expect(row["edge_source"]).toBeTruthy();
    expect(row["edge_rationale"]).toBeTruthy();
    expect(row["p_estimate"]).not.toBeNull();
    expect(row["market_price"]).not.toBeNull();
    expect(row["ev_per_dollar"]).not.toBeNull();
    expect(row["kelly_fraction"]).not.toBeNull();
    expect(row["position_size"]).not.toBeNull();
    expect(row["bankroll_before"]).not.toBeNull();
  });

  it("prevents execution when DB write fails", async () => {
    await expect(
      executeTrade(makeSizedTrade(), "session-1", 100, {
        dbPath: "/nonexistent/path/trades.db",
        _apiOverride: mockApi({ order: { order_id: "x", avg_price: 55 } }),
      }),
    ).rejects.toThrow("Database write failed");
  });
});

describe("API interaction", () => {
  it("returns EXECUTED on successful API call", async () => {
    const result = await executeTrade(makeSizedTrade(), "session-1", 100, {
      dbPath: tmpDb,
      _apiOverride: mockApi({ order: { order_id: "ord_456", avg_price: 55 } }),
    });

    expect(result.status).toBe("EXECUTED");
    expect(result.fillPrice).toBe(0.55);
    expect(result.orderId).toBe("ord_456");
    expect(result.bankrollAfter).toBeCloseTo(100 - 14.44, 1);
  });

  it("marks trade as FAILED on network error", async () => {
    const result = await executeTrade(makeSizedTrade(), "session-1", 100, {
      dbPath: tmpDb,
      _apiOverride: mockApiError(new Error("Network error")),
    });

    expect(result.status).toBe("FAILED");
    expect(result.error).toContain("Network error");
  });

  it("throws HALT on auth error", async () => {
    await expect(
      executeTrade(makeSizedTrade(), "session-1", 100, {
        dbPath: tmpDb,
        _apiOverride: mockApiError(new Error("Kalshi API auth error: 401 — HALT required")),
      }),
    ).rejects.toThrow("HALT");
  });
});

describe("fill deviation check", () => {
  it("triggers HALT when deviation > 10%", async () => {
    await expect(
      executeTrade(makeSizedTrade({ marketPrice: 0.55 }), "session-1", 100, {
        dbPath: tmpDb,
        _apiOverride: mockApi({ order: { order_id: "ord_789", avg_price: 70 } }),
      }),
    ).rejects.toThrow("Fill price deviation");
  });

  it("accepts small deviation", async () => {
    const result = await executeTrade(
      makeSizedTrade({ marketPrice: 0.55 }),
      "session-1",
      100,
      {
        dbPath: tmpDb,
        _apiOverride: mockApi({ order: { order_id: "ord_789", avg_price: 57 } }),
      },
    );
    expect(result.status).toBe("EXECUTED");
  });
});

describe("human approval gate (Rule 6)", () => {
  it("proceeds when approval is granted", async () => {
    const result = await executeTrade(makeSizedTrade(), "session-1", 100, {
      firstTrade: true,
      dbPath: tmpDb,
      _approvalOverride: true,
      _apiOverride: mockApi({ order: { order_id: "ord_100", avg_price: 55 } }),
    });
    expect(result.status).toBe("EXECUTED");
  });

  it("rejects when human declines", async () => {
    let apiCalled = false;
    const result = await executeTrade(makeSizedTrade(), "session-1", 100, {
      firstTrade: true,
      dbPath: tmpDb,
      _approvalOverride: false,
      _apiOverride: async () => { apiCalled = true; return {}; },
    });

    expect(result.status).toBe("REJECTED");
    expect(result.rejectReason).toBe("HUMAN_REJECTED");
    expect(apiCalled).toBe(false);
  });
});
