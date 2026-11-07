import { describe, expect, it } from "vitest";
import {
  DEFAULT_RULES,
  clampRules,
  qualifiesForScrobble,
  requiredListenSec,
  thresholdDelayMs,
  isDurationEligible,
} from "../src/rules";

describe("Pano-like defaults", () => {
  it("defaults are 30s / 50% / 240s", () => {
    expect(DEFAULT_RULES).toEqual({
      minDurationSec: 30,
      delayPercent: 50,
      delayMaxSec: 240,
    });
  });

  it("takes earlier of percent and max minutes", () => {
    // 200s track @50% = 100s < 240 → 100
    expect(requiredListenSec(200, DEFAULT_RULES)).toBe(100);
    // 600s track @50% = 300 > 240 → 240
    expect(requiredListenSec(600, DEFAULT_RULES)).toBe(240);
  });
});

describe("qualifiesForScrobble", () => {
  const rules = DEFAULT_RULES;

  it("rejects known short tracks (<=30s)", () => {
    expect(isDurationEligible(30, rules)).toBe(false);
    expect(qualifiesForScrobble(30, 30, rules)).toBe(false);
    expect(qualifiesForScrobble(25, 25, rules)).toBe(false);
  });

  it("finish-equivalent: full duration on long track qualifies", () => {
    expect(qualifiesForScrobble(200, 200, rules)).toBe(true);
  });

  it("skip after 40% does not qualify at 50% rule", () => {
    expect(qualifiesForScrobble(200, 80, rules)).toBe(false);
  });

  it("skip after 50% qualifies", () => {
    expect(qualifiesForScrobble(200, 100, rules)).toBe(true);
  });

  it("long track caps at 4 minutes", () => {
    expect(qualifiesForScrobble(800, 239, rules)).toBe(false);
    expect(qualifiesForScrobble(800, 240, rules)).toBe(true);
  });

  it("unknown duration uses minDurationSec threshold", () => {
    expect(requiredListenSec(0, rules)).toBe(30);
    expect(qualifiesForScrobble(0, 29, rules)).toBe(false);
    expect(qualifiesForScrobble(0, 30, rules)).toBe(true);
  });

  it("pause/mid-stop with low playedSec does not invent progress", () => {
    // simulating pause then abandon: only 10s observed
    expect(qualifiesForScrobble(200, 10, rules)).toBe(false);
  });

  it("repeat finish with same played still one logical qualify (caller dedupes)", () => {
    expect(qualifiesForScrobble(180, 180, rules)).toBe(true);
    expect(qualifiesForScrobble(180, 180, rules)).toBe(true);
  });
});

describe("thresholdDelayMs / early path math", () => {
  it("matches required listen", () => {
    expect(thresholdDelayMs(200, DEFAULT_RULES)).toBe(100_000);
    expect(thresholdDelayMs(600, DEFAULT_RULES)).toBe(240_000);
  });
});

describe("clampRules", () => {
  it("fills defaults and clamps", () => {
    expect(clampRules({})).toEqual(DEFAULT_RULES);
    expect(clampRules({ delayPercent: 999 }).delayPercent).toBe(100);
    expect(clampRules({ minDurationSec: -1 }).minDurationSec).toBe(0);
  });
});

/**
 * Lightweight session dedupe model mirroring engine invariants
 * (no Songloft runtime): skip/finish/early share one scrobbled flag.
 */
describe("session dedupe model", () => {
  type Sess = { scrobbled: boolean; earlyArmed: boolean };

  function onEarly(s: Sess, ok: boolean): string[] {
    const log: string[] = [];
    if (s.scrobbled || !s.earlyArmed || !ok) return log;
    s.scrobbled = true;
    s.earlyArmed = false;
    log.push("early");
    return log;
  }
  function onFinishOrSkip(s: Sess, ok: boolean, kind: "finish" | "skip"): string[] {
    const log: string[] = [];
    s.earlyArmed = false;
    if (s.scrobbled) return log;
    if (!ok) return log;
    s.scrobbled = true;
    log.push(kind);
    return log;
  }

  it("early then finish does not double", () => {
    const s: Sess = { scrobbled: false, earlyArmed: true };
    expect(onEarly(s, true)).toEqual(["early"]);
    expect(onFinishOrSkip(s, true, "finish")).toEqual([]);
  });

  it("finish then repeat finish does not double", () => {
    const s: Sess = { scrobbled: false, earlyArmed: false };
    expect(onFinishOrSkip(s, true, "finish")).toEqual(["finish"]);
    expect(onFinishOrSkip(s, true, "finish")).toEqual([]);
  });

  it("skip before threshold then no scrobble; later early cancelled", () => {
    const s: Sess = { scrobbled: false, earlyArmed: true };
    expect(onFinishOrSkip(s, false, "skip")).toEqual([]);
    expect(s.earlyArmed).toBe(false);
    expect(onEarly(s, true)).toEqual([]);
  });
});
