# Edge Model Subagent Spec

## Purpose
Estimates the true probability of each candidate market outcome, computes expected value per dollar risked, and filters to only trades that exceed the current edge floor.

## Inputs
- List of `CandidateMarket` objects (from scanner)
- `edge_floor`: minimum EV per dollar (from pacer)
- Current open positions (to check for correlation — Rule 5)

## Outputs
- List of `TradeSignal` objects for markets that pass the edge threshold:
  - `market_id`
  - `market_title`
  - `direction`: `YES` or `NO`
  - `p_estimate`: bot's estimated true probability
  - `market_price`: current Kalshi price
  - `ev_per_dollar`: computed expected value
  - `edge_source`: which signal type (see below)
  - `edge_rationale`: 2-sentence explanation
- Rejected candidates with rejection reasons

## Edge Source Evaluation (in priority order)

### 1. External Odds Arbitrage
- Fetch the same or equivalent event from Polymarket and Metaculus
- Compare implied probabilities
- If spread ≥ 8 percentage points → signal detected
- `p_estimate` = average of external sources (weighted by liquidity if available)

### 2. Stale Liquidity
- Check `last_trade_time` on candidate
- If >2 hours since last trade AND a relevant news event has occurred:
  - Estimate updated probability based on news
  - If implied probability shift ≥ 8% → signal detected

### 3. Econ Data Release
- Check if candidate relates to an upcoming or just-released economic indicator
- Cross-reference with FRED API and consensus estimates
- If bot's data-derived prior differs from market by ≥ 8% → signal detected
- Prior MUST reference a specific data source

### 4. News Speed
- If a resolvable event has effectively occurred but market hasn't repriced
- This signal decays fastest — only valid for minutes after the event
- Requires near-real-time news awareness

### 5. Sentiment Divergence
- Weakest signal — only trade alone if EV ≥ +0.12
- Compare social/news sentiment direction to market implied probability

## EV Computation

```
For YES trade at price p_market:
  win_payout = 1 - p_market  (profit per contract if YES resolves)
  loss = p_market             (cost per contract if NO resolves)
  ev_per_dollar = (p_estimate * win_payout - (1 - p_estimate) * loss) / loss

For NO trade at price p_market:
  Equivalent to YES trade at price (1 - p_market) with p_estimate = (1 - p_estimate_yes)
```

## Correlation Check (Rule 5)
Before approving any signal:
1. Fetch current open positions from trades.db
2. For each open position, check if the candidate shares a primary causal driver
3. If correlated: reject the candidate with reason `CORRELATED_POSITION`

## Consecutive Loss Tracking (Rule 8)
- Query trades.db for the last 3 executed trades with `resolution = 'LOSS'`
- If 3 consecutive losses found → return empty signal list, log `MODEL_REVIEW`

## What is NOT Edge (hard rejections)
- No probability estimate attached → reject
- No external benchmark checked → reject
- Rationale can't be stated in 2 sentences with a number → reject
- "Feels" cheap/wrong without data → reject
