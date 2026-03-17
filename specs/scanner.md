# Scanner Subagent Spec

## Purpose
Polls the Kalshi API for active markets and returns a filtered list of candidate markets that meet the bot's selection criteria.

## Inputs
- Kalshi API credentials (from environment)
- Market selection criteria (from CLAUDE.md Section 7)

## Outputs
- List of `CandidateMarket` objects, each containing:
  - `market_id`: Kalshi market ticker
  - `market_title`: human-readable title
  - `category`: market category (politics, economics, sports, etc.)
  - `close_time`: when the market closes (ISO 8601)
  - `yes_price`: current best YES ask price
  - `no_price`: current best NO ask price
  - `volume`: total volume traded
  - `open_interest`: total open interest in dollars
  - `last_trade_time`: timestamp of most recent trade

## Filtering Logic

### Include if ALL of these are true:
1. Market is binary (YES/NO only)
2. Resolution within 48 hours of current time
3. Open interest ≥ $500
4. Market has clear, unambiguous resolution criteria
5. Market is currently open for trading

### Exclude if ANY of these are true:
1. Market has ambiguous or subjective resolution criteria
2. Market resolves more than 48 hours out
3. Open interest < $500
4. Resolution authority is unclear
5. Market is in a category the bot doesn't cover

### Priority scoring
Score candidates for the edge model to evaluate first:
1. **High priority:** Fed decisions, econ data releases, political binary outcomes
2. **Medium priority:** Sports with strong external odds availability
3. **Low priority:** Everything else that passes filters

## API Calls
- `GET /markets` — list active markets with filters
- `GET /markets/{ticker}` — get detailed market info
- `GET /markets/{ticker}/orderbook` — get order book depth

## Rate Limiting
- Minimum 500ms between API calls
- On 429 response: exponential backoff starting at 1s, max 30s
- Cache market list for 60 seconds to avoid redundant calls within same cycle

## Error Handling
- API auth failure → trigger HALT (Cardinal Rule: safety condition)
- Network timeout → retry once after 5s, then skip this cycle
- Empty market list → log event, return empty list (no trades this cycle)
