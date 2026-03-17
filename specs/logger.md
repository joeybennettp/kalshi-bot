# Logger Subagent Spec

## Purpose
Manages all writes to `trades.db` (SQLite), ensuring every trade attempt and system event is recorded. No trade executes without a corresponding log entry.

## Inputs
- Trade data (from any stage of the pipeline)
- Event data (session starts, pace checks, halts, milestones)

## Database Schema

See CLAUDE.md Section 8 for full schema. The logger is responsible for:
1. Creating the database and tables on first run
2. Writing trade records at every status transition
3. Writing event records for system-level occurrences

## Trade Lifecycle Logging

Each trade moves through these statuses:

```
PENDING → EXECUTED → PENDING_RESOLUTION → WIN/LOSS/VOID
PENDING → REJECTED (with reject_reason)
PENDING → FAILED (with error details)
```

### On trade entry (pre-execution):
Write full record with `status = 'PENDING'`, all edge fields populated.

### On execution:
Update to `status = 'EXECUTED'`, set `fill_price`, `bankroll_after`.

### On rejection:
Update to `status = 'REJECTED'`, set `reject_reason`.

### On failure:
Update to `status = 'FAILED'`, set `reject_reason` with error details.

### On resolution:
Update `resolution` to `WIN`, `LOSS`, or `VOID`. Compute and set `pnl`, `bankroll_after`.

## Event Types

| Event Type | When Logged | Payload |
|-----------|------------|---------|
| `SESSION_START` | Bot starts | session_id, bankroll, env |
| `SESSION_END` | Bot stops cleanly | session_id, final_bankroll, trades_count |
| `PACE_CHECK` | Pacer runs | pace_status, pace_ratio, edge_floor, bankroll |
| `MILESTONE_10X` | 10x weekly target hit | bankroll, week_number |
| `MODEL_REVIEW` | 3 consecutive losses | last_3_trade_ids, bankroll |
| `HALT` | Safety condition triggered | reason, bankroll, error_context |
| `WEEK_START` | New trading week begins | week_number, opening_bankroll |

## Integrity Rules

1. **Write-before-execute:** Trade record must be written to DB before the order is placed. If DB write fails, the trade MUST NOT execute.
2. **No orphaned trades:** Every `EXECUTED` trade must eventually get a `resolution` update.
3. **Atomic updates:** Use SQLite transactions for multi-field updates.
4. **No credential logging:** Never write API keys, secrets, or auth tokens to the database.

## Database Initialization

On first run, create tables if they don't exist:
```sql
CREATE TABLE IF NOT EXISTS trades (...);
CREATE TABLE IF NOT EXISTS events (...);
```

## Query Helpers

The logger exposes read methods for other subagents:

- `get_bankroll_after_last_trade()` → latest `bankroll_after` from trades
- `get_consecutive_losses()` → count of consecutive `LOSS` resolutions from most recent trades
- `get_open_positions()` → all trades with `resolution = 'PENDING'`
- `get_session_trades(session_id)` → all trades in current session
- `get_week_opening_bankroll()` → bankroll at most recent `WEEK_START` event
