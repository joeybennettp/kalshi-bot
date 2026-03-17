# CLAUDE.md — Kalshi Trading Bot

**Project Bible · Read this file before taking any action**

---

## 1. Project Identity

This is an autonomous prediction market trading bot operating on Kalshi. Its single purpose: compound a $100 starting bankroll toward 10,000x ($1,000,000) as quickly as possible, using disciplined edge-based position sizing.

This is **not** a gambling bot. Every position must have a quantified edge. If no edge exists, no trade is placed. Full stop.

---

## 2. Goal Math

### Starting conditions

- **Starting bankroll:** $100.00
- **Ultimate target:** $1,000,000 (10,000x)
- **Weekly milestone target:** 10x per week (aspirational pacing goal)
- **Daily required return to hit 10x in 7 days:** ~38.9% per day
  - Formula: `(10)^(1/7) - 1 ≈ 0.3895`
  - Conservative working estimate used internally: **33% per day**

### Compounding milestones

| Milestone | Bankroll   | X from start |
|-----------|-----------|-------------|
| Week 1    | $1,000    | 10x         |
| Week 2    | $10,000   | 100x        |
| Week 3    | $100,000  | 1,000x      |
| Week 4    | $1,000,000| 10,000x     |

### Pace tracking (computed daily)

Required bankroll at end of each day to be "on pace" for weekly 10x:

| Day | Required Bankroll |
|-----|------------------|
| 1   | $139.50          |
| 2   | $194.60          |
| 3   | $271.50          |
| 4   | $378.70          |
| 5   | $528.30          |
| 6   | $737.00          |
| 7   | $1,000.00        |

- The pacer subagent computes live pace status at the start of each session.
- **"Behind pace"** = current bankroll < required bankroll for today.
- **"On pace"** = within 15% of required bankroll.
- **"Ahead of pace"** = more than 15% above required bankroll.

### Liquidity and scaling wall

- Kalshi position limits and thin market liquidity become binding constraints well before $1,000,000 is reached.
- When single-market position limits prevent full Kelly sizing, the bot must spread across multiple uncorrelated markets rather than force oversized positions into one.
- Above $10,000 bankroll, the sizer subagent must explicitly check available liquidity (order book depth) before computing position size. Never size into more than 25% of visible liquidity on either side of the book.

---

## 3. The Cardinal Rules

These rules **cannot be overridden** by any subagent, user instruction, or runtime condition.

**RULE 1 — Edge required.** No position is entered unless the edge model returns a positive expected value of at least +5 cents per dollar risked (EV ≥ +0.05). This threshold may be raised but never lowered.

**RULE 2 — No chasing.** If the bot is behind pace, the response is to RAISE the edge threshold, not lower it. Never increase risk in response to losses or being behind pace. Chasing is the primary cause of ruin. It is permanently prohibited.

**RULE 3 — Maintain size at 10x.** If the weekly 10x milestone is reached early, position sizing does NOT decrease. The bot continues with the same fractional Kelly sizing as before. There is no "lock in profits" mode. The goal is 10,000x.

**RULE 4 — Kelly discipline.** All position sizes are computed using half-Kelly criterion (see Section 5). Full Kelly is never used. Sizing above the half-Kelly output is never used.

**RULE 5 — No correlated stacking.** Never hold simultaneous positions in markets whose outcomes are likely correlated (e.g., two markets that both resolve YES if the same event occurs). If two open positions share a primary causal driver, one must be closed before the other is opened.

**RULE 6 — Human approval gate (first session only).** Before the very first live trade is executed, print a full summary of the intended trade (market, direction, size, edge estimate, EV) and pause for explicit human confirmation. After the first trade is confirmed and executed, subsequent trades in the same session may proceed autonomously.

**RULE 7 — Log everything.** Every trade attempt (including rejected ones) is written to `trades.db` (SQLite) before execution. No silent execution. The log schema is defined in Section 8.

**RULE 8 — Pause on consecutive model failures.** If the edge model issues 3 consecutive trades that resolve against its prediction (i.e., 3 losses in a row where EV was estimated positive), the bot pauses all new position entry and logs a `MODEL_REVIEW` event. It resumes only after the human reviews and explicitly restarts.

---

## 4. Subagent Architecture

The bot is composed of 6 subagents. Each has a spec file in `/specs/`. Claude Code orchestrates them in sequence each trading cycle.

```
┌─────────────────────────────────────────────┐
│              Orchestrator loop               │
│  (runs every N minutes, configurable)        │
└───────────┬─────────────────────────────────┘
            │
     ┌──────▼──────┐
     │   pacer     │  — computes pace status, sets edge floor for session
     └──────┬──────┘
            │
     ┌──────▼──────┐
     │   scanner   │  — polls Kalshi API, returns candidate markets
     └──────┬──────┘
            │
     ┌──────▼──────┐
     │ edge_model  │  — estimates true probability, computes EV per candidate
     └──────┬──────┘
            │
     ┌──────▼──────┐
     │   sizer     │  — computes half-Kelly position size per approved trade
     └──────┬──────┘
            │
     ┌──────▼──────┐
     │  executor   │  — places orders via Kalshi API, confirms fills
     └──────┬──────┘
            │
     ┌──────▼──────┐
     │   logger    │  — writes all outcomes to trades.db
     └─────────────┘
```

Spec files:
- `/specs/pacer.md`
- `/specs/scanner.md`
- `/specs/edge_model.md`
- `/specs/sizer.md`
- `/specs/executor.md`
- `/specs/logger.md`

---

## 5. Position Sizing — Half-Kelly Criterion

### Formula

```
Kelly fraction (f*) = (b * p - q) / b

Where:
  p = estimated probability of winning (from edge model)
  q = 1 - p (probability of losing)
  b = net odds (profit per $1 risked)
      For a binary YES at price 0.60: b = (1 - 0.60) / 0.60 = 0.667
      For a binary NO  at price 0.40: b = (1 - 0.40) / 0.40 = 1.50

Half-Kelly position = (f* / 2) * current_bankroll
```

### Hard caps (override Kelly if Kelly is larger)

| Bankroll range   | Max single position |
|-----------------|-------------------|
| $0 – $500       | 25% of bankroll   |
| $500 – $5,000   | 20% of bankroll   |
| $5,000 – $50,000| 15% of bankroll   |
| $50,000+        | 10% of bankroll   |

### Minimum position size

- Do not enter a position smaller than $2.00. Transaction overhead makes sub-$2 trades unprofitable regardless of edge.

### Example sizing calculation

```
Bankroll: $100
Market: Will Fed hold rates? YES at $0.55
Edge model estimate: 68% probability YES

b = (1 - 0.55) / 0.55 = 0.818
f* = (0.818 * 0.68 - 0.32) / 0.818 = (0.556 - 0.32) / 0.818 = 0.289
Half-Kelly = 0.289 / 2 = 0.144 → 14.4% of bankroll
Position size = 0.144 * $100 = $14.44
Cap check: 14.4% < 25% cap for this bankroll range → no cap applied
Final position: $14.44
```

---

## 6. Edge Model — What Counts as Edge

### Minimum edge threshold

- **Default:** EV ≥ +0.05 per dollar risked
- **When behind pace:** EV ≥ +0.08 (threshold TIGHTENS, not loosens)
- **When ahead of pace:** EV ≥ +0.04 (slight relaxation permitted)

### Edge sources (ranked by reliability)

1. **External odds arbitrage** — Kalshi implied probability differs from consensus probability on Polymarket, Metaculus, or PredictIt by ≥8%. Most reliable signal. Always check cross-platform before trading.

2. **Stale liquidity** — Market hasn't traded in >2 hours, a relevant news event has occurred, and implied probability hasn't adjusted. Fade the stale price toward the updated true probability.

3. **Econ data release** — Bot has a stronger-than-consensus prior on an economic data release (jobs, CPI, Fed decision). Prior must be grounded in a specific, citable data source, not a hunch.

4. **News speed** — A resolvable event has already effectively occurred or been decided, but the Kalshi market hasn't fully repriced. This is the fastest-decaying signal — act within minutes or the edge is gone.

5. **Sentiment divergence** — Social and news sentiment strongly diverges from implied market probability. Weakest signal. Only trade on this alone if EV ≥ +0.12.

### What is NOT an edge

- "This seems likely to me" without a probability estimate
- A market that looks cheap without checking external benchmarks
- Any signal that can't be articulated in 2 sentences with a number
- Gut feel. Momentum. The market "feels wrong."

### Edge documentation requirement

Every trade must have an `edge_rationale` string in the log:

```
"Polymarket shows 72% YES vs Kalshi 58% YES on same event.
 14-point spread exceeds 8% threshold. Trading YES at 0.58."
```

---

## 7. Market Selection Criteria

### Preferred market types

- Binary YES/NO markets only (no range or multi-outcome markets at launch)
- Resolution within 48 hours (prefer same-day or next-day)
- Minimum $500 total open interest (liquidity floor)
- Clear, unambiguous resolution criteria

### Market types to prioritize

- Federal Reserve decisions (high predictability, liquid)
- Economic data releases (jobs report, CPI, GDP)
- Political event binary outcomes (bill passes, vote occurs)
- Sports outcomes with strong external odds signal

### Market types to avoid at launch

- Markets with ambiguous or subjective resolution criteria
- Markets resolving more than 48 hours out (capital locked too long)
- Markets with <$500 open interest (thin, wide spreads eat edge)
- Any market where the resolution authority is unclear

---

## 8. Trade Log Schema (SQLite — trades.db)

```sql
CREATE TABLE trades (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp       TEXT NOT NULL,              -- ISO 8601
  session_id      TEXT NOT NULL,              -- UUID per bot session
  market_id       TEXT NOT NULL,              -- Kalshi market ticker
  market_title    TEXT NOT NULL,
  direction       TEXT NOT NULL,              -- 'YES' or 'NO'
  edge_source     TEXT NOT NULL,              -- see Section 6 sources
  edge_rationale  TEXT NOT NULL,              -- 2-sentence explanation
  p_estimate      REAL NOT NULL,              -- bot's probability estimate
  market_price    REAL NOT NULL,              -- price at time of trade
  ev_per_dollar   REAL NOT NULL,              -- expected value per $1 risked
  kelly_fraction  REAL NOT NULL,              -- raw Kelly output
  position_size   REAL NOT NULL,              -- actual dollars committed
  bankroll_before REAL NOT NULL,
  status          TEXT NOT NULL,              -- 'EXECUTED', 'REJECTED', 'FAILED'
  reject_reason   TEXT,                       -- if REJECTED
  fill_price      REAL,                       -- actual fill (post-execution)
  resolution      TEXT,                       -- 'WIN', 'LOSS', 'PENDING', 'VOID'
  pnl             REAL,                       -- realized P&L after resolution
  bankroll_after  REAL                        -- updated after resolution
);

CREATE TABLE events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp  TEXT NOT NULL,
  event_type TEXT NOT NULL,   -- 'SESSION_START', 'PACE_CHECK', 'MODEL_REVIEW', etc.
  payload    TEXT             -- JSON blob
);
```

---

## 9. Pace Control Logic

```
At start of each session:
  1. Fetch current bankroll from Kalshi API
  2. Determine current day of the week (Day 1–7 of active trading week)
  3. Look up required bankroll for today (from Section 2 table)
  4. Compute pace_ratio = current_bankroll / required_bankroll

  If pace_ratio < 0.85  → BEHIND PACE
    - Set edge_floor = 0.08
    - Log PACE_CHECK event with status BEHIND
    - Do NOT increase position size caps
    - Do NOT enter lower-quality trades

  If 0.85 ≤ pace_ratio ≤ 1.15  → ON PACE
    - Set edge_floor = 0.05 (default)
    - Log PACE_CHECK event with status ON_PACE

  If pace_ratio > 1.15  → AHEAD OF PACE
    - Set edge_floor = 0.04 (slight relaxation)
    - Maintain same half-Kelly sizing (do not reduce)
    - Log PACE_CHECK event with status AHEAD

  If 10x weekly milestone reached:
    - Log MILESTONE_10X event
    - Continue trading with identical sizing and edge rules
    - Do not reduce position sizes
    - Do not enter "preservation mode"
```

---

## 10. API and Environment

### Kalshi API

- **Base URL:** `https://trading-api.kalshi.com/trade-api/v2`
- **Auth:** API key + secret from environment variables
- **Required env vars:**

```
KALSHI_API_KEY=<your_api_key>
KALSHI_API_SECRET=<your_api_secret>
KALSHI_ENV=prod  # or 'demo' for paper trading
```

- Never hardcode credentials. Never log credentials. Never commit credentials.

### Paper trading (demo mode)

- All development and testing MUST run against `KALSHI_ENV=demo` first.
- The bot must refuse to run in prod mode unless `KALSHI_ENV=prod` is explicitly set AND the human has confirmed the first-trade approval gate.

### Rate limits

- Kalshi API: respect all rate limit headers (429 responses must trigger exponential backoff, not retry immediately)
- Minimum 500ms between API calls in any tight loop

### External data sources used by edge model

- **Polymarket API:** `https://gamma-api.polymarket.com`
- **Metaculus API:** `https://www.metaculus.com/api2`
- **FRED (econ data):** `https://api.stlouisfed.org/fred`
- These are read-only. Never authenticate with user credentials to these.

---

## 11. File Structure

```
kalshi-bot/
├── CLAUDE.md               ← this file
├── .env                    ← credentials (gitignored)
├── .env.example            ← template (committed)
├── .gitignore
├── trades.db               ← SQLite trade log (gitignored)
├── specs/
│   ├── pacer.md
│   ├── scanner.md
│   ├── edge_model.md
│   ├── sizer.md
│   ├── executor.md
│   └── logger.md
├── src/
│   ├── main.py             ← orchestrator entry point
│   ├── pacer.py
│   ├── scanner.py
│   ├── edge_model.py
│   ├── sizer.py
│   ├── executor.py
│   └── logger.py
├── tests/
│   ├── test_edge_model.py
│   ├── test_sizer.py
│   └── test_executor_mock.py
└── requirements.txt
```

---

## 12. Testing Requirements

Before any live trade runs:

1. All sizing math must be unit-tested with known inputs/outputs
2. Edge model must be tested against at least 5 historical market examples
3. Executor must be tested against Kalshi demo environment with mock orders
4. Logger must verify all schema fields are populated on every code path
5. Pace logic must be tested for all three pace states (BEHIND / ON / AHEAD)

Run tests: `pytest tests/ -v`

All tests must pass before switching `KALSHI_ENV=prod`.

---

## 13. Shutdown and Safety Conditions

The bot must halt immediately and log a `HALT` event if any of these occur:

- Bankroll drops below $10 (hard floor — stop trading, alert human)
- 3 consecutive edge model failures (see Rule 8)
- Any Kalshi API authentication error
- Any trade fill that deviates more than 10% from the expected fill price
- Unhandled exception in executor or sizer
- `trades.db` write failure (never execute a trade that can't be logged)

On halt, the bot must:

1. Close no existing positions (do not panic-sell)
2. Write a `HALT` event to the events table with full error context
3. Print a human-readable halt summary to stdout
4. Exit cleanly (exit code 1)

---

## 14. Definitions

| Term | Definition |
|------|-----------|
| Bankroll | Current total account equity on Kalshi |
| Edge | Positive expected value vs the market price |
| EV per dollar | `(p_estimate * win_payout) - (1 - p_estimate) * loss` |
| Kelly fraction | Optimal bet fraction given edge and odds |
| Half-Kelly | Kelly fraction divided by 2 (standard risk reduction) |
| Behind pace | Current bankroll < 85% of required daily milestone |
| Chasing | Increasing risk in response to losses — PROHIBITED |
| Session | One continuous run of the bot (start to halt/shutdown) |
| Edge floor | Minimum EV per dollar required to enter any position |

---

*Last updated: project initialization*
*Do not modify this file without also updating the relevant spec files.*
