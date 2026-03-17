import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { checkResolutions } from "../src/resolution_checker.js";
import { initDb, logTrade, getDb } from "../src/logger.js";
import path from "path";
import fs from "fs";

const TEST_DB = path.resolve(__dirname, "test_resolutions.db");

function cleanup() {
  try { fs.unlinkSync(TEST_DB); } catch {}
}

function insertTrade(overrides: Record<string, unknown> = {}) {
  const defaults = {
    session_id: "test-session",
    market_id: "TEST-MARKET-YES",
    market_title: "Will test pass?",
    direction: "YES",
    edge_source: "test",
    edge_rationale: "test rationale",
    p_estimate: 0.65,
    market_price: 0.50,
    ev_per_dollar: 0.10,
    kelly_fraction: 0.15,
    position_size: 10.0,
    bankroll_before: 100.0,
    status: "EXECUTED",
    fill_price: 0.50,
    resolution: null,
  };
  return logTrade({ ...defaults, ...overrides } as any, TEST_DB);
}

describe("checkResolutions", () => {
  beforeEach(() => {
    cleanup();
    initDb(TEST_DB);
  });

  afterEach(cleanup);

  it("resolves a winning YES trade", async () => {
    insertTrade({ market_id: "WIN-YES", direction: "YES", fill_price: 0.30, position_size: 9.0 });

    const mockApi = async (path: string) => ({
      market: { status: "settled", result: "yes" },
    });

    const result = await checkResolutions(100, TEST_DB, { _apiOverride: mockApi });
    expect(result.resolved).toBe(1);
    expect(result.wins).toBe(1);
    expect(result.losses).toBe(0);
    // 30 contracts * (1 - 0.30) = $21.00
    expect(result.totalPnl).toBeCloseTo(21.0, 1);

    // Check DB was updated
    const db = getDb(TEST_DB);
    const row = db.prepare("SELECT * FROM trades WHERE market_id = 'WIN-YES'").get() as any;
    db.close();
    expect(row.resolution).toBe("WIN");
    expect(row.pnl).toBeCloseTo(21.0, 1);
  });

  it("resolves a losing YES trade", async () => {
    insertTrade({ market_id: "LOSE-YES", direction: "YES", fill_price: 0.40, position_size: 8.0 });

    const mockApi = async () => ({
      market: { status: "settled", result: "no" },
    });

    const result = await checkResolutions(100, TEST_DB, { _apiOverride: mockApi });
    expect(result.resolved).toBe(1);
    expect(result.wins).toBe(0);
    expect(result.losses).toBe(1);
    expect(result.totalPnl).toBeCloseTo(-8.0, 1);
  });

  it("resolves a winning NO trade", async () => {
    insertTrade({ market_id: "WIN-NO", direction: "NO", fill_price: 0.25, position_size: 5.0 });

    const mockApi = async () => ({
      market: { status: "settled", result: "no" },
    });

    const result = await checkResolutions(100, TEST_DB, { _apiOverride: mockApi });
    expect(result.resolved).toBe(1);
    expect(result.wins).toBe(1);
    // 20 contracts * (1 - 0.25) = $15.00
    expect(result.totalPnl).toBeCloseTo(15.0, 1);
  });

  it("skips markets that are still open", async () => {
    insertTrade({ market_id: "OPEN-MKT" });

    const mockApi = async () => ({
      market: { status: "open", result: "" },
    });

    const result = await checkResolutions(100, TEST_DB, { _apiOverride: mockApi });
    expect(result.resolved).toBe(0);
  });

  it("skips trades already resolved", async () => {
    insertTrade({ market_id: "ALREADY-DONE", resolution: "WIN", pnl: 5.0 });

    const mockApi = async () => ({
      market: { status: "settled", result: "yes" },
    });

    // getOpenPositions filters out resolved trades, so this should be 0
    const result = await checkResolutions(100, TEST_DB, { _apiOverride: mockApi });
    expect(result.resolved).toBe(0);
  });

  it("handles API errors gracefully", async () => {
    insertTrade({ market_id: "ERROR-MKT" });

    const mockApi = async () => { throw new Error("API timeout"); };

    const result = await checkResolutions(100, TEST_DB, { _apiOverride: mockApi });
    expect(result.resolved).toBe(0);
  });

  it("resolves multiple trades in one call", async () => {
    insertTrade({ market_id: "MULTI-1", direction: "YES", fill_price: 0.20, position_size: 4.0 });
    insertTrade({ market_id: "MULTI-2", direction: "NO", fill_price: 0.30, position_size: 6.0 });

    const mockApi = async (path: string) => {
      if (path.includes("MULTI-1")) {
        return { market: { status: "settled", result: "yes" } };
      }
      return { market: { status: "settled", result: "yes" } }; // NO trade loses
    };

    const result = await checkResolutions(100, TEST_DB, { _apiOverride: mockApi });
    expect(result.resolved).toBe(2);
    expect(result.wins).toBe(1);
    expect(result.losses).toBe(1);
  });
});
