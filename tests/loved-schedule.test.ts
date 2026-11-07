import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  LovedScheduler,
  computeNextDueAt,
  delayUntilDue,
  hoursToMs,
  normalizeIntervalHours,
  DEFAULT_LOVED_SCHEDULE,
} from "../src/loved-schedule";

describe("loved-schedule pure helpers", () => {
  it("defaults interval to 24 when invalid", () => {
    expect(normalizeIntervalHours(undefined)).toBe(24);
    expect(normalizeIntervalHours(7)).toBe(24);
    expect(normalizeIntervalHours("12")).toBe(12);
    expect(normalizeIntervalHours(6)).toBe(6);
    expect(normalizeIntervalHours(24)).toBe(24);
  });

  it("computes next due from interval", () => {
    expect(computeNextDueAt(1_000, 24)).toBe(1_000 + hoursToMs(24));
    expect(delayUntilDue(5_000, 4_000)).toBe(1_000);
    expect(delayUntilDue(3_000, 4_000)).toBe(0);
  });

  it("DEFAULT is disabled", () => {
    expect(DEFAULT_LOVED_SCHEDULE.enabled).toBe(false);
    expect(DEFAULT_LOVED_SCHEDULE.intervalHours).toBe(24);
  });
});

describe("LovedScheduler", () => {
  let now = 1_000_000;
  const timers: Array<{ id: number; at: number; fn: () => void }> = [];
  let nextId = 1;
  let scheduler: LovedScheduler;
  const persisted: unknown[] = [];

  beforeEach(() => {
    now = 1_000_000;
    timers.length = 0;
    nextId = 1;
    persisted.length = 0;
    scheduler = new LovedScheduler({
      now: () => now,
      setTimeout: (fn, ms) => {
        const id = nextId++;
        timers.push({ id, at: now + ms, fn: fn as () => void });
        return id as unknown as ReturnType<typeof setTimeout>;
      },
      clearTimeout: (id) => {
        const idx = timers.findIndex((t) => t.id === (id as unknown as number));
        if (idx >= 0) timers.splice(idx, 1);
      },
    });
    scheduler.setPersist(async (st) => {
      persisted.push({ ...st });
    });
  });

  afterEach(() => {
    scheduler.dispose();
  });

  async function advanceTo(ts: number) {
    now = ts;
    // fire all due timers (stable sort by at)
    for (;;) {
      timers.sort((a, b) => a.at - b.at);
      const due = timers.filter((t) => t.at <= now);
      if (!due.length) break;
      for (const t of due) {
        const idx = timers.indexOf(t);
        if (idx >= 0) timers.splice(idx, 1);
        await t.fn();
      }
    }
  }

  it("stays off by default and does not arm a timer", async () => {
    const st = await scheduler.applyState({}, { persist: true });
    expect(st.enabled).toBe(false);
    expect(scheduler.hasTimer()).toBe(false);
    expect(timers.length).toBe(0);
  });

  it("enabling arms nextDue after a full interval (no immediate sync)", async () => {
    const ticks: number[] = [];
    scheduler.setOnTick(async () => {
      ticks.push(now);
      await scheduler.noteSuccess(now);
    });
    const st = await scheduler.applyState({ enabled: true, intervalHours: 6 }, { persist: true });
    expect(st.enabled).toBe(true);
    expect(st.nextDueAt).toBe(now + hoursToMs(6));
    expect(scheduler.hasTimer()).toBe(true);
    expect(ticks.length).toBe(0);

    // Not yet due
    await advanceTo(now + hoursToMs(6) - 1);
    expect(ticks.length).toBe(0);

    await advanceTo(now + 1);
    expect(ticks.length).toBe(1);
  });

  it("disabling clears timer and stops further ticks", async () => {
    const ticks: number[] = [];
    scheduler.setOnTick(async () => {
      ticks.push(now);
      await scheduler.noteSuccess(now);
    });
    await scheduler.applyState({ enabled: true, intervalHours: 6 });
    await scheduler.applyState({ enabled: false });
    expect(scheduler.hasTimer()).toBe(false);
    await advanceTo(now + hoursToMs(24));
    expect(ticks.length).toBe(0);
  });

  it("persists lastSuccessAt and pushes nextDue after success", async () => {
    await scheduler.applyState({ enabled: true, intervalHours: 12 });
    const st = await scheduler.noteSuccess(now);
    expect(st.lastSuccessAt).toBe(now);
    expect(st.nextDueAt).toBe(now + hoursToMs(12));
    expect(persisted.length).toBeGreaterThan(0);
    const last = persisted[persisted.length - 1] as { lastSuccessAt: number; nextDueAt: number };
    expect(last.lastSuccessAt).toBe(now);
    expect(last.nextDueAt).toBe(now + hoursToMs(12));
  });

  it("manual success reschedules so a just-finished sync is not immediately due", async () => {
    const ticks: number[] = [];
    scheduler.setOnTick(async () => {
      ticks.push(now);
      await scheduler.noteSuccess(now);
    });
    await scheduler.applyState({ enabled: true, intervalHours: 6 });
    // Pretend due is imminent
    await scheduler.applyState({ nextDueAt: now + 10 });
    // Manual success first
    await scheduler.noteSuccess(now);
    expect(scheduler.getState().nextDueAt).toBe(now + hoursToMs(6));
    await advanceTo(now + 100);
    expect(ticks.length).toBe(0);
  });

  it("skipped_busy when exclusive lock held", async () => {
    let release!: () => void;
    const blocker = new Promise<void>((r) => {
      release = r;
    });
    const first = scheduler.runExclusive(async () => {
      await blocker;
      return "a";
    });
    const second = await scheduler.runExclusive(async () => "b");
    expect(second).toEqual({ skipped: true, reason: "skipped_busy" });
    expect(scheduler.getSkippedBusy()).toBe(1);
    release();
    await expect(first).resolves.toEqual({ skipped: false, result: "a" });
  });

  it("failed scheduled attempt keeps enabled and retries after interval", async () => {
    await scheduler.applyState({ enabled: true, intervalHours: 6 });
    const st = await scheduler.noteAttemptFinished(false, now);
    expect(st.enabled).toBe(true);
    expect(st.nextDueAt).toBe(now + hoursToMs(6));
    expect(st.lastSuccessAt).toBeNull();
  });

  it("restores past due on reload (fires when advanced to now)", async () => {
    const ticks: number[] = [];
    scheduler.setOnTick(async () => {
      ticks.push(now);
      await scheduler.noteAttemptFinished(true, now);
    });
    // Simulate reload with a due already in the past — recover, do not wait another full interval.
    await scheduler.applyState({
      enabled: true,
      intervalHours: 24,
      lastSuccessAt: now - hoursToMs(48),
      nextDueAt: now - 1_000,
    });
    await advanceTo(now);
    expect(ticks.length).toBe(1);
  });

  it("does not call fetch / keep-alive while arming", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    await scheduler.applyState({ enabled: true, intervalHours: 24 });
    expect(scheduler.hasTimer()).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});
