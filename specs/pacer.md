# Pacer Subagent Spec

## Purpose
Computes the bot's pace status relative to the weekly 10x milestone target and sets the edge floor for the current session.

## Inputs
- Current bankroll (fetched from Kalshi API)
- Current date/time
- Trading week start date (stored in events table as `WEEK_START`)

## Outputs
- `pace_status`: one of `BEHIND`, `ON_PACE`, `AHEAD`
- `edge_floor`: minimum EV per dollar required to enter a trade this session
- `pace_ratio`: `current_bankroll / required_bankroll`
- `required_bankroll`: target for today based on daily milestones

## Logic

### Step 1: Determine trading day
Calculate which day (1-7) of the current trading week we're on. If no `WEEK_START` event exists, today is Day 1.

### Step 2: Look up required bankroll
Daily milestone table (starting from week's opening bankroll):

| Day | Multiplier | Example ($100 start) |
|-----|-----------|---------------------|
| 1   | 1.395x    | $139.50             |
| 2   | 1.946x    | $194.60             |
| 3   | 2.715x    | $271.50             |
| 4   | 3.787x    | $378.70             |
| 5   | 5.283x    | $528.30             |
| 6   | 7.370x    | $737.00             |
| 7   | 10.000x   | $1,000.00           |

### Step 3: Compute pace ratio
```
pace_ratio = current_bankroll / required_bankroll
```

### Step 4: Set edge floor

| Condition | Edge Floor |
|-----------|-----------|
| pace_ratio < 0.85 (BEHIND) | 0.08 |
| 0.85 ≤ pace_ratio ≤ 1.15 (ON_PACE) | 0.05 |
| pace_ratio > 1.15 (AHEAD) | 0.04 |

### Step 5: Log PACE_CHECK event
Write to events table with pace_status, pace_ratio, edge_floor, current_bankroll, required_bankroll.

### Step 6: Check for 10x milestone
If current_bankroll ≥ 10x the week's opening bankroll:
- Log `MILESTONE_10X` event
- Continue with same edge_floor and sizing rules (no preservation mode)

## Cardinal Rule Enforcement
- **Rule 2 (No chasing):** When BEHIND, edge_floor goes UP to 0.08, never down. Position size caps remain unchanged.
- **Rule 3 (Maintain size at 10x):** On milestone, no changes to sizing.
