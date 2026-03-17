/**
 * Quick connection test — verifies API credentials work.
 * Run with: npx tsx src/test_connection.ts
 */

import "dotenv/config";
import { kalshiGet } from "./kalshi_api.js";

async function main() {
  console.log("Testing Kalshi API connection...");
  console.log(`Environment: ${process.env["KALSHI_ENV"] ?? "demo"}`);
  console.log(`API Key: ${process.env["KALSHI_API_KEY"]?.slice(0, 8)}...`);
  console.log();

  try {
    // Test 1: Get account balance
    console.log("1. Fetching account balance...");
    const balance = await kalshiGet("/portfolio/balance");
    console.log("   Balance:", JSON.stringify(balance, null, 2));
    console.log();

    // Test 2: Fetch a few markets
    console.log("2. Fetching active markets...");
    const markets = await kalshiGet("/markets", { status: "open", limit: "5" });
    const marketList = (markets["markets"] ?? []) as Record<string, unknown>[];
    console.log(`   Found ${marketList.length} markets (showing first 5)`);
    for (const m of marketList) {
      console.log(`   - ${m["title"]} (${m["ticker"]}) YES@${m["yes_ask"]}`);
    }
    console.log();

    console.log("Connection successful! Your API credentials are working.");
  } catch (e) {
    console.error("Connection FAILED:", e instanceof Error ? e.message : e);
    process.exit(1);
  }
}

main();
