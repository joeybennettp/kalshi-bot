/**
 * Centralized registry of all Kalshi market series to scan.
 */

export type MarketCategory = "crypto_15m" | "crypto_hourly" | "financial_hourly" | "sports";

export interface SeriesConfig {
  seriesTicker: string;
  category: MarketCategory;
  /** Binance trading pair symbol (e.g. "BTCUSDT") for crypto price feeds */
  binanceSymbol?: string;
  /** CoinGecko coin ID for fallback price feeds */
  coinId?: string;
  /** Whether this is a directional (up/down) market suitable for trend analysis.
   *  Range markets (multiple price bins) should NOT use trend analysis. */
  directional?: boolean;
}

/** All 15-minute crypto series — new event every 15 minutes, 24/7
 *  Only BTC and ETH have backtested edge (54%+ accuracy over 14 days).
 *  SOL (50.6%), XRP (51.9%), ADA (32%), DOGE (39%), BNB (46%), BCH (untested) — all dropped. */
const CRYPTO_15M: SeriesConfig[] = [
  { seriesTicker: "KXBTC15M",  category: "crypto_15m", binanceSymbol: "BTCUSDT",  coinId: "bitcoin",      directional: true },
  { seriesTicker: "KXETH15M",  category: "crypto_15m", binanceSymbol: "ETHUSDT",  coinId: "ethereum",     directional: true },
];

/** Hourly crypto series — range and directional markets */
const CRYPTO_HOURLY: SeriesConfig[] = [
  { seriesTicker: "KXBTC",   category: "crypto_hourly", binanceSymbol: "BTCUSDT",  coinId: "bitcoin" },
  { seriesTicker: "KXBTCD",  category: "crypto_hourly", binanceSymbol: "BTCUSDT",  coinId: "bitcoin" },
  { seriesTicker: "KXETH",   category: "crypto_hourly", binanceSymbol: "ETHUSDT",  coinId: "ethereum" },
  { seriesTicker: "KXETHD",  category: "crypto_hourly", binanceSymbol: "ETHUSDT",  coinId: "ethereum" },
  { seriesTicker: "KXSOL",   category: "crypto_hourly", binanceSymbol: "SOLUSDT",  coinId: "solana" },
  { seriesTicker: "KXSOLD",  category: "crypto_hourly", binanceSymbol: "SOLUSDT",  coinId: "solana" },
  { seriesTicker: "KXDOGE",  category: "crypto_hourly", binanceSymbol: "DOGEUSDT", coinId: "dogecoin" },
  { seriesTicker: "KXXRP",   category: "crypto_hourly", binanceSymbol: "XRPUSDT",  coinId: "ripple" },
  { seriesTicker: "KXXRPD",  category: "crypto_hourly", binanceSymbol: "XRPUSDT",  coinId: "ripple" },
];

/** Hourly financial series — active during US market hours */
const FINANCIAL_HOURLY: SeriesConfig[] = [
  { seriesTicker: "KXINXU",       category: "financial_hourly" },
  { seriesTicker: "KXNASDAQ100U", category: "financial_hourly" },
  { seriesTicker: "KXWTIH",       category: "financial_hourly" },
  { seriesTicker: "KXEURUSDH",    category: "financial_hourly" },
  { seriesTicker: "KXUSDJPYH",    category: "financial_hourly" },
  { seriesTicker: "KXGBPUSDH",    category: "financial_hourly" },
];

/** Sports series — game-day events */
const SPORTS: SeriesConfig[] = [
  { seriesTicker: "KXEPL1H",         category: "sports" },
  { seriesTicker: "KXLALIGA1H",      category: "sports" },
  { seriesTicker: "KXSERIEA1H",      category: "sports" },
  { seriesTicker: "KXLIGUE11H",      category: "sports" },
  { seriesTicker: "KXBUNDESLIGA1H",  category: "sports" },
  { seriesTicker: "KXNBA",           category: "sports" },
  { seriesTicker: "KXMLB",           category: "sports" },
  { seriesTicker: "KXNHL",           category: "sports" },
  { seriesTicker: "KXF1",            category: "sports" },
];

/** Complete market registry */
export const MARKET_REGISTRY: SeriesConfig[] = [
  ...CRYPTO_15M,
  ...CRYPTO_HOURLY,
  ...FINANCIAL_HOURLY,
  ...SPORTS,
];

/** Look up config for a series ticker */
export function getSeriesConfig(seriesTicker: string): SeriesConfig | undefined {
  return MARKET_REGISTRY.find((c) => c.seriesTicker === seriesTicker);
}

/** Get all unique Binance symbols needed for crypto price feeds */
export function getUniqueBinanceSymbols(): string[] {
  const symbols = new Set<string>();
  for (const c of MARKET_REGISTRY) {
    if (c.binanceSymbol) symbols.add(c.binanceSymbol);
  }
  return [...symbols];
}
