/**
 * Pacer subagent — computes pace status and sets edge floor for the session.
 */

import { getWeekOpeningBankroll, logEvent } from "./logger.js";

// Daily multipliers for 10x in 7 days: (10)^(d/7)
const DAILY_MULTIPLIERS: Record<number, number> = {
  1: 1.3895,
  2: 1.9307,
  3: 2.6827,
  4: 3.7276,
  5: 5.1795,
  6: 7.1969,
  7: 10.0,
};

const DEFAULT_STARTING_BANKROLL = 100.0;

export interface PaceResult {
  paceStatus: "BEHIND" | "ON_PACE" | "AHEAD";
  edgeFloor: number;
  paceRatio: number;
  currentBankroll: number;
  requiredBankroll: number;
  tradingDay: number;
  milestoneReached: boolean;
}

export function computePace(
  currentBankroll: number,
  tradingDay: number,
  weekOpeningBankroll?: number | null,
  dbPath?: string,
): PaceResult {
  if (tradingDay < 1 || tradingDay > 7) {
    throw new Error(`tradingDay must be 1-7, got ${tradingDay}`);
  }

  let opening = weekOpeningBankroll;
  if (opening == null) {
    opening = getWeekOpeningBankroll(dbPath);
  }
  if (opening == null) {
    opening = DEFAULT_STARTING_BANKROLL;
  }

  const multiplier = DAILY_MULTIPLIERS[tradingDay]!;
  const requiredBankroll = opening * multiplier;
  const paceRatio =
    requiredBankroll > 0 ? currentBankroll / requiredBankroll : 0;

  // Determine pace status and edge floor
  let paceStatus: PaceResult["paceStatus"];
  let edgeFloor: number;

  if (paceRatio < 0.85) {
    paceStatus = "BEHIND";
    edgeFloor = 0.05; // Same as on-pace — calibration + exposure cap handle risk
  } else if (paceRatio > 1.15) {
    paceStatus = "AHEAD";
    edgeFloor = 0.04;
  } else {
    paceStatus = "ON_PACE";
    edgeFloor = 0.05;
  }

  // Check 10x milestone
  const milestoneReached = currentBankroll >= opening * 10;

  // Log pace check
  logEvent(
    "PACE_CHECK",
    {
      pace_status: paceStatus,
      pace_ratio: Math.round(paceRatio * 10000) / 10000,
      edge_floor: edgeFloor,
      current_bankroll: currentBankroll,
      required_bankroll: Math.round(requiredBankroll * 100) / 100,
      trading_day: tradingDay,
    },
    dbPath,
  );

  if (milestoneReached) {
    logEvent(
      "MILESTONE_10X",
      {
        bankroll: currentBankroll,
        week_opening: opening,
      },
      dbPath,
    );
  }

  return {
    paceStatus,
    edgeFloor,
    paceRatio: Math.round(paceRatio * 10000) / 10000,
    currentBankroll,
    requiredBankroll: Math.round(requiredBankroll * 100) / 100,
    tradingDay,
    milestoneReached,
  };
}
