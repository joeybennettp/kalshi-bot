/**
 * Logger subagent — manages all writes to trades.db (SQLite).
 * No trade executes without a corresponding log entry.
 */

import Database from "better-sqlite3";
import path from "path";

const DEFAULT_DB_PATH = path.resolve(__dirname, "..", "trades.db");

const TRADES_SCHEMA = `
CREATE TABLE IF NOT EXISTS trades (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp       TEXT NOT NULL,
    session_id      TEXT NOT NULL,
    market_id       TEXT NOT NULL,
    market_title    TEXT NOT NULL,
    direction       TEXT NOT NULL,
    edge_source     TEXT NOT NULL,
    edge_rationale  TEXT NOT NULL,
    p_estimate      REAL NOT NULL,
    market_price    REAL NOT NULL,
    ev_per_dollar   REAL NOT NULL,
    kelly_fraction  REAL NOT NULL,
    position_size   REAL NOT NULL,
    bankroll_before REAL NOT NULL,
    status          TEXT NOT NULL,
    reject_reason   TEXT,
    fill_price      REAL,
    resolution      TEXT,
    pnl             REAL,
    bankroll_after  REAL
);`;

const EVENTS_SCHEMA = `
CREATE TABLE IF NOT EXISTS events (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp  TEXT NOT NULL,
    event_type TEXT NOT NULL,
    payload    TEXT
);`;

export interface TradeRecord {
  id?: number;
  timestamp?: string;
  session_id: string;
  market_id: string;
  market_title: string;
  direction: string;
  edge_source: string;
  edge_rationale: string;
  p_estimate: number;
  market_price: number;
  ev_per_dollar: number;
  kelly_fraction: number;
  position_size: number;
  bankroll_before: number;
  status: string;
  reject_reason?: string | null;
  fill_price?: number | null;
  resolution?: string | null;
  pnl?: number | null;
  bankroll_after?: number | null;
}

function nowISO(): string {
  return new Date().toISOString();
}

export function getDb(dbPath?: string): Database.Database {
  const p = dbPath ?? DEFAULT_DB_PATH;
  const db = new Database(p);
  db.pragma("journal_mode = WAL");
  return db;
}

export function initDb(dbPath?: string): void {
  const db = getDb(dbPath);
  db.exec(TRADES_SCHEMA);
  db.exec(EVENTS_SCHEMA);
  db.close();
}

export function logTrade(trade: TradeRecord, dbPath?: string): number {
  const db = getDb(dbPath);
  try {
    const stmt = db.prepare(`
      INSERT INTO trades
        (timestamp, session_id, market_id, market_title, direction,
         edge_source, edge_rationale, p_estimate, market_price,
         ev_per_dollar, kelly_fraction, position_size, bankroll_before,
         status, reject_reason, fill_price, resolution, pnl, bankroll_after)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `);
    const result = stmt.run(
      trade.timestamp ?? nowISO(),
      trade.session_id,
      trade.market_id,
      trade.market_title,
      trade.direction,
      trade.edge_source,
      trade.edge_rationale,
      trade.p_estimate,
      trade.market_price,
      trade.ev_per_dollar,
      trade.kelly_fraction,
      trade.position_size,
      trade.bankroll_before,
      trade.status,
      trade.reject_reason ?? null,
      trade.fill_price ?? null,
      trade.resolution ?? null,
      trade.pnl ?? null,
      trade.bankroll_after ?? null,
    );
    return Number(result.lastInsertRowid);
  } finally {
    db.close();
  }
}

export function updateTrade(
  tradeId: number,
  updates: Record<string, unknown>,
  dbPath?: string,
): void {
  const keys = Object.keys(updates);
  if (keys.length === 0) return;

  const db = getDb(dbPath);
  try {
    const setClauses = keys.map((k) => `${k} = ?`).join(", ");
    const values = keys.map((k) => updates[k]);
    db.prepare(`UPDATE trades SET ${setClauses} WHERE id = ?`).run(
      ...values,
      tradeId,
    );
  } finally {
    db.close();
  }
}

export function logEvent(
  eventType: string,
  payload?: Record<string, unknown> | null,
  dbPath?: string,
): number {
  const db = getDb(dbPath);
  try {
    const result = db
      .prepare("INSERT INTO events (timestamp, event_type, payload) VALUES (?, ?, ?)")
      .run(nowISO(), eventType, payload ? JSON.stringify(payload) : null);
    return Number(result.lastInsertRowid);
  } finally {
    db.close();
  }
}

// --- Query helpers ---

export function getBankrollAfterLastTrade(dbPath?: string): number | null {
  const db = getDb(dbPath);
  try {
    const row = db
      .prepare(
        "SELECT bankroll_after FROM trades WHERE bankroll_after IS NOT NULL ORDER BY id DESC LIMIT 1",
      )
      .get() as { bankroll_after: number } | undefined;
    return row?.bankroll_after ?? null;
  } finally {
    db.close();
  }
}

export function getConsecutiveLosses(dbPath?: string): number {
  const db = getDb(dbPath);
  try {
    const rows = db
      .prepare(
        "SELECT resolution FROM trades WHERE status = 'EXECUTED' AND resolution IS NOT NULL ORDER BY id DESC",
      )
      .all() as { resolution: string }[];

    let count = 0;
    for (const row of rows) {
      if (row.resolution === "LOSS") {
        count++;
      } else {
        break;
      }
    }
    return count;
  } finally {
    db.close();
  }
}

export function getOpenPositions(dbPath?: string): TradeRecord[] {
  const db = getDb(dbPath);
  try {
    return db
      .prepare(
        "SELECT * FROM trades WHERE status = 'EXECUTED' AND (resolution = 'PENDING' OR resolution IS NULL)",
      )
      .all() as TradeRecord[];
  } finally {
    db.close();
  }
}

/**
 * Check if we recently lost on a market with a similar title (no-chasing rule).
 * Returns true if there's a loss within the cooldown period.
 */
export function hasRecentLoss(marketTitle: string, cooldownMs: number = 900_000, dbPath?: string): boolean {
  const db = getDb(dbPath);
  try {
    const cutoff = new Date(Date.now() - cooldownMs).toISOString();
    const rows = db
      .prepare(
        "SELECT market_title FROM trades WHERE resolution = 'LOSS' AND timestamp > ? ORDER BY id DESC LIMIT 20",
      )
      .all(cutoff) as { market_title: string }[];

    // Check for similar market titles (same series/event)
    const stopWords = new Set(["the", "a", "an", "will", "be", "to", "in", "of", "at", "on", "is"]);
    const newWords = new Set(
      marketTitle.toLowerCase().split(/\s+/).filter((w) => !stopWords.has(w)),
    );

    for (const row of rows) {
      const lossWords = new Set(
        row.market_title.toLowerCase().split(/\s+/).filter((w) => !stopWords.has(w)),
      );
      let overlap = 0;
      for (const w of lossWords) {
        if (newWords.has(w)) overlap++;
      }
      if (overlap >= 3) return true;
    }
    return false;
  } finally {
    db.close();
  }
}

export function getSessionTrades(sessionId: string, dbPath?: string): TradeRecord[] {
  const db = getDb(dbPath);
  try {
    return db
      .prepare("SELECT * FROM trades WHERE session_id = ? ORDER BY id")
      .all(sessionId) as TradeRecord[];
  } finally {
    db.close();
  }
}

export function getWeekOpeningBankroll(dbPath?: string): number | null {
  const db = getDb(dbPath);
  try {
    const row = db
      .prepare(
        "SELECT payload FROM events WHERE event_type = 'WEEK_START' ORDER BY id DESC LIMIT 1",
      )
      .get() as { payload: string | null } | undefined;

    if (row?.payload) {
      const data = JSON.parse(row.payload) as Record<string, unknown>;
      return (data.opening_bankroll as number) ?? null;
    }
    return null;
  } finally {
    db.close();
  }
}
