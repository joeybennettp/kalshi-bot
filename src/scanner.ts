/**
 * Scanner subagent — polls Kalshi API for candidate markets.
 *
 * Scans all series from the market registry, plus a broad scan
 * of events closing within MAX_RESOLUTION_HOURS.
 */

import { kalshiGet } from "./kalshi_api.js";
import { MARKET_REGISTRY, type MarketCategory, type SeriesConfig } from "./market_registry.js";

const MAX_RESOLUTION_HOURS = 48;

/** Lower thresholds for fast-cycling 15-min markets */
const MIN_OI_15M = 25;
const MIN_VOL_15M = 10;
/** Standard thresholds for everything else */
const MIN_OI_DEFAULT = 100;
const MIN_VOL_DEFAULT = 50;

export interface CandidateMarket {
  marketId: string;       // market ticker (e.g. KXBTC15M-26MAR162045-45)
  eventTicker: string;    // event ticker (e.g. KXBTC15M-26MAR162045)
  seriesTicker: string;   // series ticker (e.g. KXBTC15M)
  marketTitle: string;
  category: string;
  marketCategory: MarketCategory;
  binanceSymbol?: string;
  closeTime: string;
  yesPrice: number;       // yes ask in dollars (0-1)
  noPrice: number;        // no ask in dollars (0-1)
  yesBid: number;         // yes bid in dollars (0-1)
  noBid: number;          // no bid in dollars (0-1)
  volume: number;         // dollar volume
  openInterest: number;   // dollar open interest
  lastPrice: number;      // last trade price
  /** Whether this is a directional (up/down/above/below) market */
  directional: boolean;
}

function parseDollar(v: unknown): number {
  if (typeof v === "number") return v;
  if (typeof v === "string") return parseFloat(v) || 0;
  return 0;
}

function parseMarket(
  m: Record<string, unknown>,
  kalshiCategory: string,
  config: SeriesConfig,
): CandidateMarket | null {
  const status = m["status"] as string;
  if (status !== "active" && status !== "open") return null;

  const marketType = m["market_type"] as string | undefined;
  if (marketType != null && marketType !== "binary") return null;

  const yesAsk = parseDollar(m["yes_ask_dollars"]);
  const yesBid = parseDollar(m["yes_bid_dollars"]);
  const noAsk = parseDollar(m["no_ask_dollars"]);
  const noBid = parseDollar(m["no_bid_dollars"]);
  const oi = parseDollar(m["open_interest_fp"]);
  const vol = parseDollar(m["volume_fp"]);
  const lastPrice = parseDollar(m["last_price_dollars"]);

  // Skip markets with zero ask (no liquidity)
  if (yesAsk <= 0 && noAsk <= 0) return null;

  // Category-specific thresholds
  const minOi = config.category === "crypto_15m" ? MIN_OI_15M : MIN_OI_DEFAULT;
  const minVol = config.category === "crypto_15m" ? MIN_VOL_15M : MIN_VOL_DEFAULT;
  if (oi < minOi && vol < minVol) return null;

  const ticker = (m["ticker"] as string) ?? "";
  const eventTicker = (m["event_ticker"] as string) ?? "";

  return {
    marketId: ticker,
    eventTicker,
    seriesTicker: config.seriesTicker,
    marketTitle: (m["title"] as string) ?? "",
    category: kalshiCategory,
    marketCategory: config.category,
    binanceSymbol: config.binanceSymbol,
    closeTime: (m["close_time"] as string) ?? "",
    yesPrice: yesAsk,
    noPrice: noAsk,
    yesBid,
    noBid,
    volume: vol,
    openInterest: oi,
    lastPrice,
    directional: config.directional ?? false,
  };
}

/**
 * Scan all registered series for active markets.
 */
async function scanRegisteredSeries(): Promise<CandidateMarket[]> {
  const candidates: CandidateMarket[] = [];

  for (const config of MARKET_REGISTRY) {
    try {
      const data = await kalshiGet("/events", {
        status: "open",
        limit: "10",
        with_nested_markets: "true",
        series_ticker: config.seriesTicker,
      });

      const events = (data["events"] ?? []) as Record<string, unknown>[];

      const now = Date.now();
      const maxClose = now + MAX_RESOLUTION_HOURS * 60 * 60 * 1000;

      for (const e of events) {
        const kalshiCategory = (e["category"] as string) ?? "unknown";
        const markets = (e["markets"] ?? []) as Record<string, unknown>[];

        for (const m of markets) {
          // Enforce 48-hour resolution window
          const closeStr = (m["close_time"] as string) ?? "";
          if (closeStr) {
            const closeTime = new Date(closeStr).getTime();
            if (!isNaN(closeTime) && (closeTime > maxClose || closeTime < now)) continue;
          }

          const c = parseMarket(m, kalshiCategory, config);
          if (c) candidates.push(c);
        }
      }
    } catch (e) {
      if (e instanceof Error && e.message.includes("auth")) throw e;
      // Skip this series on network error
    }
  }

  return candidates;
}

/**
 * Broad scan of events closing within MAX_RESOLUTION_HOURS.
 * Catches markets not in the registry.
 */
async function scanBroadEvents(): Promise<CandidateMarket[]> {
  const candidates: CandidateMarket[] = [];
  const now = Date.now();
  const maxClose = now + MAX_RESOLUTION_HOURS * 60 * 60 * 1000;
  const defaultConfig: SeriesConfig = { seriesTicker: "", category: "crypto_15m" };

  let cursor: string | undefined;

  for (let page = 0; page < 3; page++) {
    const params: Record<string, string> = {
      status: "open",
      limit: "100",
      with_nested_markets: "true",
    };
    if (cursor) params["cursor"] = cursor;

    let data: Record<string, unknown>;
    try {
      data = await kalshiGet("/events", params);
    } catch (e) {
      if (e instanceof Error && e.message.includes("auth")) throw e;
      break;
    }

    const events = (data["events"] ?? []) as Record<string, unknown>[];
    cursor = data["cursor"] as string | undefined;

    for (const e of events) {
      const kalshiCategory = (e["category"] as string) ?? "unknown";
      const seriesTicker = (e["series_ticker"] as string) ?? "";
      const markets = (e["markets"] ?? []) as Record<string, unknown>[];

      for (const m of markets) {
        const closeStr = (m["close_time"] as string) ?? "";
        if (!closeStr) continue;
        const closeTime = new Date(closeStr).getTime();
        if (isNaN(closeTime) || closeTime > maxClose || closeTime < now) continue;

        const config = MARKET_REGISTRY.find((c) => c.seriesTicker === seriesTicker) ?? {
          ...defaultConfig,
          seriesTicker,
          category: kalshiCategory === "Sports" ? "sports" as MarketCategory : "crypto_15m" as MarketCategory,
        };
        const c = parseMarket(m, kalshiCategory, config);
        if (c) candidates.push(c);
      }
    }

    if (!cursor) break;
  }

  return candidates;
}

export async function scanMarkets(): Promise<CandidateMarket[]> {
  const seen = new Set<string>();
  const results: CandidateMarket[] = [];

  // Priority: registered series first
  const registered = await scanRegisteredSeries();
  for (const c of registered) {
    if (!seen.has(c.marketId)) {
      seen.add(c.marketId);
      results.push(c);
    }
  }

  // Then broader scan
  const broad = await scanBroadEvents();
  for (const c of broad) {
    if (!seen.has(c.marketId)) {
      seen.add(c.marketId);
      results.push(c);
    }
  }

  return results;
}

export async function getOrderbook(
  marketId: string,
): Promise<Record<string, unknown>> {
  return kalshiGet(`/markets/${marketId}/orderbook`);
}
