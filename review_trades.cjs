const Database = require("better-sqlite3");
const db = new Database("trades.db");
const all = db.prepare("SELECT * FROM trades ORDER BY id").all();
let totalPnl = 0, executed = 0, wins = 0, losses = 0, pending = 0, failed = 0;
for (const t of all) {
  const status = t.status === "EXECUTED" ? (t.resolution || "PENDING") : t.status;
  let pnlStr = "-";
  if (t.pnl != null) {
    pnlStr = (t.pnl >= 0 ? "+" : "") + t.pnl.toFixed(2);
  }
  console.log(
    `#${t.id} | ${t.market_id} | ${t.direction} | ${status} | $${t.position_size.toFixed(2)} | fill=${t.fill_price || "-"} | pnl=${pnlStr}`
  );
  if (t.status === "EXECUTED") {
    executed++;
    if (t.resolution === "WIN") { wins++; totalPnl += t.pnl; }
    else if (t.resolution === "LOSS") { losses++; totalPnl += t.pnl; }
    else if (t.resolution === "PENDING" || !t.resolution) pending++;
  }
  if (t.status === "FAILED") failed++;
}
console.log("");
console.log(`EXECUTED: ${executed} | W:${wins} L:${losses} Pending:${pending}`);
console.log(`FAILED: ${failed}`);
console.log(`Realized P&L: $${totalPnl.toFixed(2)}`);
const wr = wins + losses > 0 ? ((wins / (wins + losses)) * 100).toFixed(0) : "n/a";
console.log(`Win rate: ${wr}%`);
db.close();
