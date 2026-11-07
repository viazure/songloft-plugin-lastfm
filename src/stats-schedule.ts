/**
 * Stats sync schedule (plugin-local timer).
 * Timing is independent; exclusive write lock is shared with Loved via lovedScheduler.runExclusive.
 * Default: disabled, interval fixed 24h.
 */

import {
  LovedScheduler,
  normalizeIntervalHours,
  type LovedScheduleState,
  type IntervalHours,
} from "./loved-schedule";

export type StatsScheduleState = LovedScheduleState;
export type { IntervalHours };

export const DEFAULT_STATS_SCHEDULE: StatsScheduleState = {
  enabled: false,
  intervalHours: 24,
  lastSuccessAt: null,
  nextDueAt: null,
};

/** Stats schedule only exposes 24h for now (Architect: fixed 24h OK). */
export function normalizeStatsIntervalHours(_v?: unknown): IntervalHours {
  return 24;
}

export { normalizeIntervalHours };

/** Separate timer instance; do NOT use its runExclusive for cross-feature locking. */
export const statsScheduler = new LovedScheduler();
