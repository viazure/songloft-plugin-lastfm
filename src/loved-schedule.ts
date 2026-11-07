/**
 * Loved → playlist scheduled sync (plugin-local timer).
 * Independent of host keep-alive / miot cron / onlyMiot.
 */

export const INTERVAL_OPTIONS = [6, 12, 24] as const;
export type IntervalHours = (typeof INTERVAL_OPTIONS)[number];

export interface LovedScheduleState {
  enabled: boolean;
  /** Hours between syncs; one of 6 / 12 / 24. Default 24. */
  intervalHours: IntervalHours;
  /** Epoch ms of last successful sync (manual or scheduled). */
  lastSuccessAt: number | null;
  /** Epoch ms when the next scheduled attempt should fire. */
  nextDueAt: number | null;
}

export const DEFAULT_LOVED_SCHEDULE: LovedScheduleState = {
  enabled: false,
  intervalHours: 24,
  lastSuccessAt: null,
  nextDueAt: null,
};

export function normalizeIntervalHours(v: unknown): IntervalHours {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  if (n === 6 || n === 12 || n === 24) return n;
  return 24;
}

export function hoursToMs(hours: number): number {
  return hours * 3600 * 1000;
}

/** nextDue = from + interval (used after enable / success / failed attempt). */
export function computeNextDueAt(fromMs: number, intervalHours: number): number {
  return fromMs + hoursToMs(intervalHours);
}

export function delayUntilDue(nextDueAt: number, nowMs: number): number {
  return Math.max(0, nextDueAt - nowMs);
}

export type ScheduleTimers = {
  now: () => number;
  setTimeout: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimeout: (id: ReturnType<typeof setTimeout>) => void;
};

const defaultTimers: ScheduleTimers = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (id) => clearTimeout(id),
};

export type ScheduledSyncFn = () => Promise<void>;

/**
 * In-memory scheduler. Persist state via store; call applyPersisted on init
 * and after settings changes. Does not touch keep-alive.
 */
export class LovedScheduler {
  private timers: ScheduleTimers;
  private timerId: ReturnType<typeof setTimeout> | null = null;
  private busy = false;
  private skippedBusy = 0;
  private state: LovedScheduleState = { ...DEFAULT_LOVED_SCHEDULE };
  private onTick: ScheduledSyncFn | null = null;
  private persist: ((s: LovedScheduleState) => Promise<void>) | null = null;

  constructor(timers: Partial<ScheduleTimers> = {}) {
    this.timers = { ...defaultTimers, ...timers };
  }

  getState(): LovedScheduleState {
    return { ...this.state };
  }

  getSkippedBusy(): number {
    return this.skippedBusy;
  }

  isBusy(): boolean {
    return this.busy;
  }

  /** Reset observation counter (tests). */
  resetSkippedBusy(): void {
    this.skippedBusy = 0;
  }

  setPersist(fn: (s: LovedScheduleState) => Promise<void>): void {
    this.persist = fn;
  }

  setOnTick(fn: ScheduledSyncFn): void {
    this.onTick = fn;
  }

  /** Stop timer without clearing enabled flag. */
  stopTimer(): void {
    if (this.timerId != null) {
      this.timers.clearTimeout(this.timerId);
      this.timerId = null;
    }
  }

  /** Full teardown (onDeinit). */
  dispose(): void {
    this.stopTimer();
    this.onTick = null;
  }

  /**
   * Replace state and re-arm. When enabling with no nextDueAt, schedule
   * first run after a full interval (no immediate sync on boot/enable).
   * When nextDueAt is already in the past (missed while unloaded), fire ASAP.
   */
  async applyState(
    partial: Partial<LovedScheduleState>,
    opts: { rearm?: boolean; persist?: boolean } = {}
  ): Promise<LovedScheduleState> {
    const rearm = opts.rearm !== false;
    const doPersist = opts.persist !== false;
    const now = this.timers.now();
    const next: LovedScheduleState = {
      ...this.state,
      ...partial,
      intervalHours: normalizeIntervalHours(
        partial.intervalHours !== undefined ? partial.intervalHours : this.state.intervalHours
      ),
      enabled: partial.enabled !== undefined ? !!partial.enabled : this.state.enabled,
    };
    if (partial.lastSuccessAt !== undefined) {
      next.lastSuccessAt =
        partial.lastSuccessAt == null || !Number.isFinite(partial.lastSuccessAt)
          ? null
          : partial.lastSuccessAt;
    }
    if (partial.nextDueAt !== undefined) {
      next.nextDueAt =
        partial.nextDueAt == null || !Number.isFinite(partial.nextDueAt)
          ? null
          : partial.nextDueAt;
    }

    const intervalChanged =
      partial.intervalHours !== undefined &&
      normalizeIntervalHours(partial.intervalHours) !== this.state.intervalHours;
    if (next.enabled) {
      if (next.nextDueAt == null) {
        // First enable / cold start: wait a full interval (do not sync immediately).
        next.nextDueAt = computeNextDueAt(now, next.intervalHours);
      } else if (intervalChanged && partial.nextDueAt === undefined) {
        // Interval edited: recompute due from last success (or now if none).
        const from = next.lastSuccessAt != null ? next.lastSuccessAt : now;
        next.nextDueAt = computeNextDueAt(from, next.intervalHours);
        if (next.nextDueAt <= now) {
          next.nextDueAt = computeNextDueAt(now, next.intervalHours);
        }
      }
    } else {
      // Disabled: keep lastSuccessAt for UI, clear nextDue so UI shows idle.
      next.nextDueAt = null;
    }

    this.state = next;
    if (doPersist && this.persist) {
      await this.persist(this.state);
    }
    if (rearm) {
      this.rearmTimer();
    }
    return this.getState();
  }

  /**
   * After a successful sync (manual or scheduled): refresh lastSuccessAt and
   * push nextDue so a just-finished manual sync is not immediately re-fired.
   */
  async noteSuccess(atMs?: number): Promise<LovedScheduleState> {
    const now = atMs ?? this.timers.now();
    if (!this.state.enabled) {
      return this.applyState({ lastSuccessAt: now, nextDueAt: null }, { rearm: true });
    }
    return this.applyState(
      {
        lastSuccessAt: now,
        nextDueAt: computeNextDueAt(now, this.state.intervalHours),
      },
      { rearm: true }
    );
  }

  /**
   * After a failed scheduled attempt: do not clear enabled; retry after interval.
   * Manual failures leave schedule alone (caller may still call this for scheduled).
   */
  async noteAttemptFinished(ok: boolean, atMs?: number): Promise<LovedScheduleState> {
    const now = atMs ?? this.timers.now();
    if (ok) return this.noteSuccess(now);
    if (!this.state.enabled) return this.getState();
    return this.applyState(
      { nextDueAt: computeNextDueAt(now, this.state.intervalHours) },
      { rearm: true }
    );
  }

  /**
   * Exclusive lock around playlist writes. Concurrent trigger → skipped_busy.
   */
  async runExclusive<T>(
    fn: () => Promise<T>
  ): Promise<{ skipped: true; reason: "skipped_busy" } | { skipped: false; result: T }> {
    if (this.busy) {
      this.skippedBusy += 1;
      return { skipped: true, reason: "skipped_busy" };
    }
    this.busy = true;
    try {
      const result = await fn();
      return { skipped: false, result };
    } finally {
      this.busy = false;
    }
  }

  /** Visible for tests: whether a timer is armed. */
  hasTimer(): boolean {
    return this.timerId != null;
  }

  rearmTimer(): void {
    this.stopTimer();
    if (!this.state.enabled || this.state.nextDueAt == null) return;
    const delay = delayUntilDue(this.state.nextDueAt, this.timers.now());
    this.timerId = this.timers.setTimeout(() => {
      void this.fire();
    }, delay);
  }

  private async fire(): Promise<void> {
    this.timerId = null;
    if (!this.state.enabled || !this.onTick) {
      return;
    }
    // Lock lives inside runLovedPlaylistSync (onTick) so manual+scheduled share one mutex.
    try {
      await this.onTick();
    } catch (e) {
      // Keep switch on; push due forward so a thrown tick does not stall forever.
      await this.noteAttemptFinished(false);
      return;
    }
    // onTick should have called noteSuccess / noteAttemptFinished.
    // If due is still past (forgotten), push one interval and re-arm.
    if (this.state.enabled) {
      const due = this.state.nextDueAt;
      const now = this.timers.now();
      if (due == null || due <= now) {
        await this.applyState(
          { nextDueAt: computeNextDueAt(now, this.state.intervalHours) },
          { rearm: true }
        );
      } else {
        this.rearmTimer();
      }
    }
  }
}

/** Singleton used by main/router (tests construct their own). */
export const lovedScheduler = new LovedScheduler();
