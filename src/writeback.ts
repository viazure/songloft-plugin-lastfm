/**
 * 内置「收藏」变更 → Last.fm love/unlove 写回。
 * 串行队列 + 指数退避；自写事件用预期登记抑制，避免回响。
 */

import type { PlaylistSongsChangeEvent, SongloftEvents } from "@songloft/plugin-sdk";
import { isInvalidSessionError } from "./store";

export type { PlaylistSongsChangeEvent };

export const HOST_EVENT_SUPPORT_HINT =
  "当前 Songloft 版本还不支持即时写回，请升级 Songloft。升级前打开此开关也不会同步收藏。";

export const HOST_EVENT_STATUS_LINE = "未生效：请升级 Songloft";

export function isPlaylistSongsChangeSupported(events: unknown): boolean {
  if (!events || typeof events !== "object") return false;
  const fn = (events as Partial<SongloftEvents>).onPlaylistSongsChange;
  return typeof fn === "function";
}

/** 订阅失败（旧宿主 / 宿主内部错误）返回 false，不抛给插件生命周期。 */
export async function subscribePlaylistSongsChange(
  events: unknown,
  handler: (event: PlaylistSongsChangeEvent) => void | Promise<void>
): Promise<boolean> {
  if (!isPlaylistSongsChangeSupported(events)) return false;
  try {
    await (events as SongloftEvents).onPlaylistSongsChange(handler);
    return true;
  } catch {
    return false;
  }
}

export async function unsubscribePlaylistSongsChange(events: unknown): Promise<boolean> {
  if (!events || typeof events !== "object") return false;
  const fn = (events as Partial<SongloftEvents>).offPlaylistSongsChange;
  if (typeof fn !== "function") return false;
  try {
    await fn.call(events);
    return true;
  } catch {
    return false;
  }
}

export type LoveAction = "love" | "unlove";

export interface WritebackJob {
  songId: number;
  artist: string;
  title: string;
  action: LoveAction;
}

export type LockResult<T> = { skipped: true } | { skipped: false; result: T };

export type WritebackQueueDeferReason = "busy" | "retry" | "paused" | null;

export interface WritebackQueueDeps {
  love(artist: string, title: string): Promise<void>;
  unlove(artist: string, title: string): Promise<void>;
  /** 与收藏写入共用一把忙锁（默认 lovedScheduler.runExclusive）。 */
  withLock<T>(fn: () => Promise<T>): Promise<LockResult<T>>;
  onInvalidSession?: () => Promise<void> | void;
  /** 单条写回成功后调用，用于增量更新起点。 */
  onApplied?: (job: WritebackJob) => Promise<void> | void;
  onDeferred?: (job: WritebackJob, reason: Exclude<WritebackQueueDeferReason, null>) => void;
  onFailed?: (job: WritebackJob, reason: string) => void;
  log?: (level: "info" | "warn" | "error", message: string) => void;
  sleep?: (ms: number) => Promise<void>;
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** 忙锁被占用时的等待节奏。 */
  lockWaitMs?: number;
  lockMaxWaitMs?: number;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** 限流 / 服务暂不可用 / 网络抖动可重试；会话或凭证失效不可重试。 */
export function isRetryableWritebackError(err: unknown): boolean {
  const s = String(err ?? "");
  if (isInvalidSessionError(s)) return false;
  return !/Invalid API key|error\s*10\b|Authentication Failed|error\s*4\b/i.test(s);
}

/**
 * 串行 love/unlove 队列。失败按指数退避重试；次数耗尽后停在队首，
 * 等下次入队或 resume() 继续，不丢用户操作。锁只在单次调用期间持有。
 */
export class LovedWritebackQueue {
  private jobs: WritebackJob[] = [];
  private running = false;
  private paused = false;
  private inflight: Promise<void> | null = null;
  private lastDeferReason: WritebackQueueDeferReason = null;
  private lastError = "";
  private deps: WritebackQueueDeps;

  constructor(deps: WritebackQueueDeps) {
    this.deps = deps;
  }

  size(): number {
    return this.jobs.length;
  }

  isBusy(): boolean {
    return this.running;
  }

  isPaused(): boolean {
    return this.paused;
  }

  lastDefer(): WritebackQueueDeferReason {
    return this.lastDeferReason;
  }

  lastFailure(): string {
    return this.lastError;
  }

  /** 同一首歌只保留最后一次操作（连点两次不应排队两次相反写入）。 */
  enqueue(job: WritebackJob): void {
    if (!job || !Number.isFinite(job.songId)) return;
    if (!job.artist || !job.title) return;
    this.jobs = this.jobs.filter((j) => j.songId !== job.songId);
    this.jobs.push({
      songId: job.songId,
      artist: String(job.artist),
      title: String(job.title),
      action: job.action === "unlove" ? "unlove" : "love",
    });
    void this.kick();
  }

  /** 会话恢复后允许继续处理积压。 */
  resume(): void {
    this.paused = false;
    this.lastDeferReason = null;
    void this.kick();
  }

  /** 测试/收尾用：等当前出队循环结束。 */
  async waitForIdle(): Promise<void> {
    while (this.inflight) await this.inflight;
  }

  /** 暂停出队（会话失效时也走这条路径）。已在途的调用不受影响。 */
  pause(): void {
    this.paused = true;
    this.lastDeferReason = "paused";
  }

  clear(): void {
    this.jobs = [];
  }

  private sleep(ms: number): Promise<void> {
    return (this.deps.sleep || defaultSleep)(ms);
  }

  private log(level: "info" | "warn" | "error", message: string): void {
    this.deps.log?.(level, message);
  }

  async kick(): Promise<void> {
    if (this.running) return this.inflight ?? undefined;
    this.running = true;
    const run = (async () => {
      try {
        while (this.jobs.length && !this.paused) {
          const job = this.jobs[0];
          const outcome = await this.process(job);
          if (outcome !== "done") break;
          this.jobs = this.jobs.filter((j) => j !== job);
          this.lastDeferReason = null;
          this.lastError = "";
        }
      } finally {
        this.running = false;
        this.inflight = null;
      }
    })();
    this.inflight = run;
    return run;
  }

  private async process(job: WritebackJob): Promise<"done" | "deferred"> {
    const maxAttempts = Math.max(1, this.deps.maxAttempts ?? 4);
    const baseDelay = Math.max(1, this.deps.baseDelayMs ?? 500);
    const maxDelay = Math.max(baseDelay, this.deps.maxDelayMs ?? 8_000);
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const gate = await this.acquireAndWrite(job);
      if (gate === "done") {
        this.log("info", `${job.action}: ${job.artist} - ${job.title}（收藏写回）`);
        return "done";
      }
      if (gate === "deferred" || gate === "paused") {
        this.lastDeferReason = gate === "paused" ? "paused" : "busy";
        this.deps.onDeferred?.(job, this.lastDeferReason);
        return "deferred";
      }
      if (!gate.retryable || attempt === maxAttempts - 1) {
        this.lastDeferReason = "retry";
        this.lastError = gate.reason;
        this.log(
          "warn",
          `写回失败，留在队列稍后重试：${job.artist} - ${job.title}（${gate.reason}）`
        );
        this.deps.onDeferred?.(job, "retry");
        this.deps.onFailed?.(job, gate.reason);
        return "deferred";
      }
      const delay = Math.min(maxDelay, baseDelay * Math.pow(2, attempt));
      this.lastDeferReason = "retry";
      this.log(
        "warn",
        `写回失败（第 ${attempt + 1} 次），${delay}ms 后重试：${job.artist} - ${job.title}`
      );
      this.deps.onDeferred?.(job, "retry");
      await this.sleep(delay);
    }
    return "deferred";
  }

  private async acquireAndWrite(
    job: WritebackJob
  ): Promise<"done" | "deferred" | "paused" | { retryable: boolean; reason: string }> {
    const waitMs = this.deps.lockWaitMs ?? 500;
    const maxWaitMs = this.deps.lockMaxWaitMs ?? 30_000;
    let waited = 0;
    for (;;) {
      const gate = await this.deps.withLock(async () => {
        try {
          if (job.action === "love") await this.deps.love(job.artist, job.title);
          else await this.deps.unlove(job.artist, job.title);
          return { kind: "ok" as const };
        } catch (e) {
          return { kind: "err" as const, error: e };
        }
      });
      if (gate.skipped) {
        if (waited >= maxWaitMs) return "deferred";
        await this.sleep(waitMs);
        waited += waitMs;
        continue;
      }
      const outcome = gate.result;
      if (outcome.kind === "ok") {
        try {
          await this.deps.onApplied?.(job);
        } catch (e) {
          this.log("warn", `写回起点更新失败：${String(e)}`);
        }
        return "done";
      }
      if (isInvalidSessionError(outcome.error)) {
        this.paused = true;
        this.lastDeferReason = "paused";
        try {
          await this.deps.onInvalidSession?.();
        } catch {
          /* 标记失败不阻塞队列状态 */
        }
        this.log("error", `写回暂停：连接已失效，请重新连接账号（${job.artist} - ${job.title}）`);
        return "paused";
      }
      return {
        retryable: isRetryableWritebackError(outcome.error),
        reason: String(outcome.error ?? "未知错误"),
      };
    }
  }
}
