# Sizer Subagent Spec

## Purpose
Computes the half-Kelly position size for each approved trade signal, applying hard caps and liquidity constraints.

## Inputs
- List of `TradeSignal` objects (from edge model)
- Current bankroll
- Order book depth for each market (fetched from Kalshi API)

## Outputs
- List of `SizedTrade` objects:
  - All fields from `TradeSignal`
  - `kelly_fraction`: raw Kelly output
  - `half_kelly_fraction`: Kelly / 2
  - `uncapped_size`: half_kelly_fraction * bankroll
  - `position_size`: final size after caps and liquidity checks
  - `size_cap_applied`: which cap was binding (if any)

## Sizing Formula

### Step 1: Compute Kelly fraction
```
b = net odds = (1 - market_price) / market_price  (for YES)
    or         market_price / (1 - market_price)    (for NO)

p = p_estimate (from edge model)
q = 1 - p

f* = (b * p - q) / b
```

If `f* ≤ 0`: reject trade (no edge per Kelly — this should never happen if edge model is correct, log a warning).

### Step 2: Half-Kelly
```
half_kelly = f* / 2
uncapped_size = half_kelly * current_bankroll
```

### Step 3: Apply hard caps

| Bankroll range    | Max % of bankroll |
|-------------------|------------------|
| $0 – $500         | 25%              |
| $500 – $5,000     | 20%              |
| $5,000 – $50,000  | 15%              |
| $50,000+          | 10%              |

```
cap = max_percent * current_bankroll
position_size = min(uncapped_size, cap)
```

### Step 4: Minimum size check
If `position_size < $2.00` → reject trade with reason `BELOW_MINIMUM_SIZE`.

### Step 5: Liquidity check (bankroll > $10,000)
When bankroll exceeds $10,000:
1. Fetch order book for the market
2. Calculate visible liquidity on the relevant side (bid or ask)
3. If `position_size > 0.25 * visible_liquidity` → reduce to `0.25 * visible_liquidity`
4. Re-check minimum size after liquidity reduction

### Step 6: Round to valid contract size
Kalshi contracts are in whole cents. Round position_size down to nearest cent.

## Error Conditions
- Kelly fraction negative → log warning, reject trade
- Bankroll fetch fails → trigger HALT
- Order book unavailable for liquidity check → use hard caps only, log warning
