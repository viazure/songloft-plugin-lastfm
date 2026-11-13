import { describe, expect, it } from "vitest";
import {
  HOST_EVENT_SUPPORT_HINT,
  isPlaylistSongsChangeSupported,
  isRetryableWritebackError,
  LovedWritebackQueue,
  subscribePlaylistSongsChange,
  type WritebackJob,
} from "../src/writeback";
import { EchoSuppressor } from "../src/echo";

function job(songId: number, action: "love" | "unlove" = "love"): WritebackJob {
  return { songId, artist: "A" + songId, title: "T" + songId, action };
}

describe("EchoSuppressor", () => {
  it("absorbs each registered event once", () => {
    let now = 1_000;
    const s = new EchoSuppressor(() => now, 1_000);
    s.expectDiff(1, [5], [6]);
    expect(s.consume(1, 5, "add")).toBe(true);
    expect(s.consume(1, 5, "add")).toBe(false);
    expect(s.consume(1, 6, "remove")).toBe(true);
    expect(s.consume(1, 7, "add")).toBe(false);
  });

  it("keeps unconsumed roundKeys past TTL until the next beginRound", () => {
    let now = 1_000;
    const s = new EchoSuppressor(() => now, 500);
    s.expect(1, 9, "add");
    s.endRound(); // drain 后不再清 roundKeys
    now = 2_000;
    expect(s.consume(1, 9, "add")).toBe(true);
    s.expect(1, 10, "remove");
    now = 3_000;
    s.beginRound(); // 下一轮同步开始才淘汰
    expect(s.consume(1, 10, "remove")).toBe(false);
  });
});

describe("isPlaylistSongsChangeSupported", () => {
  it("is false on hosts without the API (no throw)", () => {
    expect(isPlaylistSongsChangeSupported(undefined)).toBe(false);
    expect(isPlaylistSongsChangeSupported(null)).toBe(false);
    expect(isPlaylistSongsChangeSupported({})).toBe(false);
    expect(isPlaylistSongsChangeSupported({ onPlaylistSongsChange: null })).toBe(false);
    expect(isPlaylistSongsChangeSupported({ onPlaylistSongsChange: "nope" })).toBe(false);
  });

  it("is true when the host exposes the function", () => {
    expect(isPlaylistSongsChangeSupported({ onPlaylistSongsChange: async () => {} })).toBe(true);
  });

  it("subscribe returns false instead of throwing on old hosts / host errors", async () => {
    expect(await subscribePlaylistSongsChange({}, () => {})).toBe(false);
    expect(
      await subscribePlaylistSongsChange(
        {
          onPlaylistSongsChange: async () => {
            throw new Error("host boom");
          },
        },
        () => {}
      )
    ).toBe(false);
    const ok = await subscribePlaylistSongsChange(
      { onPlaylistSongsChange: async () => {} },
      () => {}
    );
    expect(ok).toBe(true);
    expect(HOST_EVENT_SUPPORT_HINT).toContain("请升级 Songloft");
  });
});

describe("EchoSuppressor round markers", () => {
  it("consumes round keys even after TTL would have expired", () => {
    let now = 1_000;
    const s = new EchoSuppressor(() => now, 100);
    s.expect(9, 1, "add");
    now = 5_000;
    // round key still absorbs once, independent of TTL
    expect(s.consume(9, 1, "add")).toBe(true);
    expect(s.consume(9, 1, "add")).toBe(false);
  });

  it("beginRound clears leftover keys so they do not suppress forever", () => {
    let now = 1_000;
    const s = new EchoSuppressor(() => now, 30_000);
    s.expect(1, 2, "remove");
    expect(s.roundSize()).toBe(1);
    s.beginRound();
    expect(s.roundSize()).toBe(0);
    expect(s.consume(1, 2, "remove")).toBe(false);
  });
});

describe("isRetryableWritebackError", () => {
  it("retries rate limit / service offline, not session or key errors", () => {
    expect(isRetryableWritebackError("Last.FM error 29: Rate limit exceeded")).toBe(true);
    expect(isRetryableWritebackError("Last.FM error 16: service unavailable")).toBe(true);
    expect(isRetryableWritebackError("fetch failed")).toBe(true);
    expect(isRetryableWritebackError("Last.FM error 9: Invalid session key")).toBe(false);
    expect(isRetryableWritebackError("Last.FM error 10: Invalid API key")).toBe(false);
  });
});

describe("LovedWritebackQueue", () => {
  function harness(opts?: {
    fail?: (call: number) => Error | null;
    lockBusyTimes?: number;
  }) {
    const calls: Array<{ kind: string; artist: string; title: string }> = [];
    const sleeps: number[] = [];
    const applied: WritebackJob[] = [];
    let concurrent = 0;
    let peakConcurrent = 0;
    let call = 0;
    const lockBusyTimes = opts?.lockBusyTimes ?? 0;
    let lockBusyLeft = lockBusyTimes;
    const queue = new LovedWritebackQueue({
      love: async (artist, title) => {
        concurrent += 1;
        peakConcurrent = Math.max(peakConcurrent, concurrent);
        call += 1;
        const fail = opts?.fail?.(call) ?? null;
        await new Promise((r) => setTimeout(r, 1));
        calls.push({ kind: "love", artist, title });
        concurrent -= 1;
        if (fail) throw fail;
      },
      unlove: async (artist, title) => {
        concurrent += 1;
        peakConcurrent = Math.max(peakConcurrent, concurrent);
        call += 1;
        const fail = opts?.fail?.(call) ?? null;
        await new Promise((r) => setTimeout(r, 1));
        calls.push({ kind: "unlove", artist, title });
        concurrent -= 1;
        if (fail) throw fail;
      },
      withLock: async (fn) => {
        if (lockBusyLeft > 0) {
          lockBusyLeft -= 1;
          return { skipped: true as const };
        }
        return { skipped: false as const, result: await fn() };
      },
      onApplied: async (j) => {
        applied.push(j);
      },
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      maxAttempts: 3,
      baseDelayMs: 10,
      maxDelayMs: 40,
      lockWaitMs: 1,
    });
    return {
      queue,
      calls,
      sleeps,
      applied,
      peak: () => peakConcurrent,
    };
  }

  it("processes two enqueued events serially", async () => {
    const h = harness();
    h.queue.enqueue(job(1));
    h.queue.enqueue(job(2));
    await h.queue.kick();
    expect(h.calls.map((c) => c.artist)).toEqual(["A1", "A2"]);
    expect(h.peak()).toBe(1);
    expect(h.queue.size()).toBe(0);
    expect(h.applied.map((j) => j.songId)).toEqual([1, 2]);
  });

  it("collapses repeated operations on the same song to the last one", async () => {
    const pending: Array<() => void> = [];
    const calls: string[] = [];
    const queue = new LovedWritebackQueue({
      love: async () => {
        calls.push("love");
        await new Promise<void>((r) => pending.push(r));
      },
      unlove: async () => {
        calls.push("unlove");
      },
      withLock: async (fn) => ({ skipped: false as const, result: await fn() }),
    });
    queue.enqueue(job(1, "love"));
    // 第一条还在途时再点一次反方向：只保留最后一次
    queue.enqueue(job(1, "unlove"));
    await new Promise((r) => setTimeout(r, 0));
    pending.splice(0).forEach((r) => r());
    await queue.kick();
    await new Promise((r) => setTimeout(r, 0));
    expect(queue.size()).toBe(0);
    // 第一条已经在发出的请求无法撤回，但后续只会有一次 unlove
    expect(calls.filter((c) => c === "unlove")).toHaveLength(1);
  });

  it("retries rate-limit / service errors with backoff, then succeeds", async () => {
    const h = harness({
      fail: (n) =>
        n === 1
          ? new Error("Last.FM error 29: Rate limit exceeded")
          : n === 2
            ? new Error("Last.FM error 16: service unavailable")
            : null,
    });
    h.queue.enqueue(job(7));
    await h.queue.kick();
    expect(h.calls.length).toBe(3);
    expect(h.sleeps).toEqual([10, 20]);
    expect(h.queue.size()).toBe(0);
  });

  it("keeps the job queued when attempts run out", async () => {
    const h = harness({ fail: () => new Error("Last.FM error 29: Rate limit exceeded") });
    h.queue.enqueue(job(3));
    await h.queue.kick();
    expect(h.calls.length).toBe(3);
    expect(h.queue.size()).toBe(1);
    expect(h.applied).toEqual([]);
  });

  it("stops retrying and pauses on an invalid session", async () => {
    const h = harness({ fail: () => new Error("Last.FM error 9: Invalid session key") });
    let invalidated = 0;
    const queue = new LovedWritebackQueue({
      love: async () => {
        throw new Error("Last.FM error 9: Invalid session key");
      },
      unlove: async () => {},
      withLock: async (fn) => ({ skipped: false as const, result: await fn() }),
      onInvalidSession: () => {
        invalidated += 1;
      },
      sleep: async () => {},
      maxAttempts: 5,
    });
    queue.enqueue(job(4));
    await queue.kick();
    expect(invalidated).toBe(1);
    expect(queue.isPaused()).toBe(true);
    expect(queue.size()).toBe(1);
    // 暂停后不再自动重试
    await queue.kick();
    expect(queue.size()).toBe(1);
    void h;
  });

  it("waits for the shared busy lock instead of failing immediately", async () => {
    const h = harness({ lockBusyTimes: 2 });
    h.queue.enqueue(job(8));
    await h.queue.kick();
    expect(h.calls).toEqual([{ kind: "love", artist: "A8", title: "T8" }]);
    expect(h.queue.size()).toBe(0);
  });
});
