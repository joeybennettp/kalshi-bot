# Executor Subagent Spec

## Purpose
Places orders on Kalshi for each sized trade, confirms fills, and handles execution errors.

## Inputs
- List of `SizedTrade` objects (from sizer)
- Session ID
- Whether this is the first trade of the session (for human approval gate)
- Current bankroll

## Outputs
- List of `ExecutionResult` objects:
  - All fields from `SizedTrade`
  - `status`: `EXECUTED`, `FAILED`, `REJECTED`
  - `fill_price`: actual fill price (if executed)
  - `order_id`: Kalshi order ID (if executed)
  - `bankroll_after`: updated bankroll post-trade
  - `error`: error details (if failed)

## Execution Flow

### Step 1: Pre-execution logging (Rule 7)
Before placing any order, write a trade record to trades.db with `status = 'PENDING'`.
If the database write fails → HALT. Never execute a trade that can't be logged.

### Step 2: Human approval gate (Rule 6, first session only)
If this is the first trade of the session:
1. Print full trade summary to stdout:
   ```
   === FIRST TRADE APPROVAL REQUIRED ===
   Market:    {market_title}
   Direction: {direction}
   Size:      ${position_size}
   Price:     {market_price}
   P(est):    {p_estimate}
   EV/dollar: {ev_per_dollar}
   Edge:      {edge_source}
   Rationale: {edge_rationale}
   ======================================
   ```
2. Wait for human input (`y` to proceed, anything else to abort)
3. If aborted → update trade status to `REJECTED`, reason `HUMAN_REJECTED`

### Step 3: Place order
- API: `POST /portfolio/orders`
- Order type: limit order at `market_price` (do not use market orders)
- Side: `yes` or `no` based on direction
- Include `count` (number of contracts) computed from position_size / market_price

### Step 4: Confirm fill
- Poll order status until filled, partially filled, or expired
- Timeout: 60 seconds
- If partially filled: accept the partial fill, log actual fill amount

### Step 5: Fill price deviation check
If `abs(fill_price - market_price) / market_price > 0.10`:
- Log the trade as executed BUT trigger HALT (safety condition)
- The position remains open; the HALT prevents further trading

### Step 6: Update records
- Update trade record in trades.db with actual fill_price, status, bankroll_after
- Update bankroll tracking

## Environment Guard
- If `KALSHI_ENV != 'prod'`: use demo API base URL
- If `KALSHI_ENV == 'prod'` and no first-trade approval has been given this session: refuse to execute

## Error Handling
- Auth error → HALT immediately
- Network error → retry once after 2s, then mark trade as FAILED
- Rate limit (429) → exponential backoff, retry up to 3 times
- Any unhandled exception → HALT

## Rate Limiting
- Minimum 500ms between order placement API calls
- On 429: backoff sequence 1s → 2s → 4s → HALT
