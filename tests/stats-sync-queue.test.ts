import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  isFullStatsSyncQueued,
  isStatsSyncBusy,
  __setFullStatsSyncQueuedForTests,
} from "../src/stats-sync-run";
import { lovedScheduler } from "../src/loved-schedule";
import { runLovedPlaylistSync } from "../src/loved-sync-run";

describe("full stats sync queue gate", () => {
  afterEach(() => {
    __setFullStatsSyncQueuedForTests(false);
  });

  it("isFullStatsSyncQueued / isStatsSyncBusy reflect queue flag", () => {
    expect(isFullStatsSyncQueued()).toBe(false);
    __setFullStatsSyncQueuedForTests(true);
    expect(isFullStatsSyncQueued()).toBe(true);
    expect(isStatsSyncBusy()).toBe(true);
    __setFullStatsSyncQueuedForTests(false);
    expect(isFullStatsSyncQueued()).toBe(false);
    expect(lovedScheduler.isBusy()).toBe(false);
    expect(isStatsSyncBusy()).toBe(false);
  });

  it("queued blocks steal window: busy without exclusive lock", () => {
    __setFullStatsSyncQueuedForTests(true);
    expect(lovedScheduler.isBusy()).toBe(false);
    expect(isStatsSyncBusy()).toBe(true);
    expect(isFullStatsSyncQueued()).toBe(true);
  });
});

describe("loved sync respects full stats queue", () => {
  beforeEach(() => {
    (globalThis as any).songloft = {
      storage: {
        get: vi.fn(async () => null),
        set: vi.fn(async () => undefined),
      },
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    };
  });

  afterEach(() => {
    __setFullStatsSyncQueuedForTests(false);
    vi.restoreAllMocks();
    delete (globalThis as any).songloft;
  });

  it("returns skipped_busy when full stats sync is queued", async () => {
    __setFullStatsSyncQueuedForTests(true);
    const r = await runLovedPlaylistSync("manual");
    expect(r).toMatchObject({
      ok: false,
      skipped: true,
      reason: "skipped_busy",
      source: "manual",
    });
    // Must not have acquired exclusive lock
    expect(lovedScheduler.isBusy()).toBe(false);
  });
});
