import { kalshiGet } from "./src/kalshi_api.js";

async function main() {
  try {
    const balance = await kalshiGet("/portfolio/balance");
    console.log("BALANCE:", JSON.stringify(balance));
  } catch (e: any) {
    console.error("Balance error:", e.message);
  }

  try {
    const orders = await kalshiGet("/portfolio/orders", { limit: "20" });
    const items = (orders as any).orders ?? [];
    console.log(`\nORDERS (${items.length}):`);
    for (const o of items) {
      console.log(`  ${o.ticker} | ${o.side} | ${o.status} | count:${o.count} | filled:${o.filled_count}`);
    }
  } catch (e: any) {
    console.error("Orders error:", e.message);
  }

  try {
    const positions = await kalshiGet("/portfolio/positions", { limit: "50" });
    const items = (positions as any).market_positions ?? [];
    console.log(`\nPOSITIONS (${items.length}):`);
    for (const p of items) {
      console.log(`  ${p.ticker} | ${p.market_id} | qty:${p.position} | side:${p.side}`);
    }
  } catch (e: any) {
    console.error("Positions error:", e.message);
  }
}

main();
