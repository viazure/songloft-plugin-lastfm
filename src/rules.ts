/** Pure scrobble threshold helpers (Pano-like). No Songloft/Last.FM I/O. */

export interface ScrobbleRuleConfig {
  /** Tracks shorter than this (seconds) are never scrobbled when duration is known. Default 30. */
  minDurationSec: number;
  /** Percent of track length required (0–100). Default 50. */
  delayPercent: number;
  /** Absolute cap in seconds for the percent-based delay. Default 240 (4 min). */
  delayMaxSec: number;
}

export const DEFAULT_RULES: ScrobbleRuleConfig = {
  minDurationSec: 30,
  delayPercent: 50,
  delayMaxSec: 240,
};

export function clampRules(raw: Partial<ScrobbleRuleConfig> | null | undefined): ScrobbleRuleConfig {
  const minDurationSec = clampInt(raw?.minDurationSec, 0, 3600, DEFAULT_RULES.minDurationSec);
  const delayPercent = clampInt(raw?.delayPercent, 1, 100, DEFAULT_RULES.delayPercent);
  const delayMaxSec = clampInt(raw?.delayMaxSec, 1, 3600, DEFAULT_RULES.delayMaxSec);
  return { minDurationSec, delayPercent, delayMaxSec };
}

function clampInt(v: unknown, lo: number, hi: number, fallback: number): number {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.min(hi, Math.max(lo, Math.round(n)));
}

/**
 * Required listen seconds before a scrobble is allowed.
 * Earlier of (percent of duration) and delayMaxSec.
 * Unknown duration (<=0): fall back to minDurationSec.
 */
export function requiredListenSec(durationSec: number, rules: ScrobbleRuleConfig): number {
  const r = clampRules(rules);
  if (durationSec > 0) {
    const fromPercent = (durationSec * r.delayPercent) / 100;
    return Math.min(fromPercent, r.delayMaxSec);
  }
  return r.minDurationSec;
}

/** Known-duration tracks shorter than min are ineligible. Unknown duration stays eligible. */
export function isDurationEligible(durationSec: number, rules: ScrobbleRuleConfig): boolean {
  const r = clampRules(rules);
  if (durationSec > 0 && durationSec <= r.minDurationSec) return false;
  return true;
}

/**
 * Shared gate for finish / skip / early-threshold.
 * `playedSec` must be observed listen time (or host-declared finish ~= full duration).
 * Do NOT pass wall-clock-since-play as verified playback when progress is unknown.
 */
export function qualifiesForScrobble(
  durationSec: number,
  playedSec: number,
  rules: ScrobbleRuleConfig
): boolean {
  const r = clampRules(rules);
  const played = Math.max(0, playedSec);
  if (!isDurationEligible(durationSec, r)) return false;
  return played >= requiredListenSec(durationSec, r);
}

/** Delay (ms) until threshold if continuous play from t=0. Only with real play start + continuous play. */
export function thresholdDelayMs(durationSec: number, rules: ScrobbleRuleConfig): number {
  return Math.max(0, Math.ceil(requiredListenSec(durationSec, rules) * 1000));
}
