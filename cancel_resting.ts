import { kalshiGet, kalshiDelete } from "./src/kalshi_api.js";

async function main() {
  const data = await kalshiGet("/portfolio/orders", { status: "resting" });
  const orders = (data as any).orders ?? [];
  console.log(`Found ${orders.length} resting order(s)`);

  for (const o of orders) {
    console.log(`Cancelling: ${o.ticker} (${o.order_id})`);
    try {
      await kalshiDelete(`/portfolio/orders/${o.order_id}`);
      console.log("  Done");
    } catch (e: any) {
      console.log(`  Error: ${e.message}`);
    }
  }

  const balance = await kalshiGet("/portfolio/balance");
  console.log(`Balance after: ${JSON.stringify(balance)}`);
}
main();
