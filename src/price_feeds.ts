/**
 * Real-time crypto price feeds using Binance REST API.
 * No API key required. Much faster than CoinGecko (~50ms vs minutes of lag).
 */

const BINANCE_API = "https://api.binance.us/api/v3";

export interface Kline {
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  closeTime: number;
}

export interface PriceSnapshot {
  symbol: string;
  currentPrice: number;
  priceChange24h: number;   // percentage
  volume24h: number;
  high24h: number;
  low24h: number;
}

export interface PriceData {
  snapshot: PriceSnapshot;
  klines1m: Kline[];    // 1-minute candles (for 15m markets)
  klines5m: Kline[];    // 5-minute candles (for RSI/MACD)
  klines15m: Kline[];   // 15-minute candles (for hourly markets)
}

function parseKlines(raw: unknown[][]): Kline[] {
  return raw.map((k) => ({
    openTime: k[0] as number,
    open: parseFloat(k[1] as string),
    high: parseFloat(k[2] as string),
    low: parseFloat(k[3] as string),
    close: parseFloat(k[4] as string),
    volume: parseFloat(k[5] as string),
    closeTime: k[6] as number,
  }));
}

/**
 * Fetch current price + 24h stats for a symbol.
 */
export async function fetchBinancePrice(symbol: string): Promise<PriceSnapshot | null> {
  try {
    const resp = await fetch(`${BINANCE_API}/ticker/24hr?symbol=${symbol}`, {
      signal: AbortSignal.timeout(5_000),
    });
    if (!resp.ok) return null;

    const data = (await resp.json()) as Record<string, string>;
    return {
      symbol,
      currentPrice: parseFloat(data["lastPrice"] ?? "0"),
      priceChange24h: parseFloat(data["priceChangePercent"] ?? "0"),
      volume24h: parseFloat(data["volume"] ?? "0"),
      high24h: parseFloat(data["highPrice"] ?? "0"),
      low24h: parseFloat(data["lowPrice"] ?? "0"),
    };
  } catch {
    return null;
  }
}

/**
 * Fetch kline (candlestick) data for a symbol.
 */
export async function fetchBinanceKlines(
  symbol: string,
  interval: "1m" | "5m" | "15m" | "1h",
  limit: number = 50,
): Promise<Kline[]> {
  try {
    const resp = await fetch(
      `${BINANCE_API}/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`,
      { signal: AbortSignal.timeout(5_000) },
    );
    if (!resp.ok) return [];

    const raw = (await resp.json()) as unknown[][];
    return parseKlines(raw);
  } catch {
    return [];
  }
}

/**
 * Fetch all price data needed for trend analysis on a single symbol.
 * Makes 4 parallel requests to Binance.
 */
export async function fetchFullPriceData(symbol: string): Promise<PriceData | null> {
  const [snapshot, klines1m, klines5m, klines15m] = await Promise.all([
    fetchBinancePrice(symbol),
    fetchBinanceKlines(symbol, "1m", 60),    // last 60 minutes
    fetchBinanceKlines(symbol, "5m", 50),    // last ~4 hours
    fetchBinanceKlines(symbol, "15m", 30),   // last ~7.5 hours
  ]);

  if (!snapshot) return null;

  return { snapshot, klines1m, klines5m, klines15m };
}

/**
 * Fetch price data for all given symbols in parallel.
 */
export async function fetchAllPriceData(
  symbols: string[],
): Promise<Map<string, PriceData>> {
  const results = new Map<string, PriceData>();
  const promises = symbols.map(async (symbol) => {
    const data = await fetchFullPriceData(symbol);
    if (data) results.set(symbol, data);
  });
  await Promise.all(promises);
  return results;
}
