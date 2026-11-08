/** Shared Last.fm → stats PlayRecord sync runner (manual + scheduled). */

import { getScrobbler, refreshScrobbler } from "./engine";
import { lovedScheduler } from "./loved-schedule";
import {
  formatStatsSyncSummary,
  normalizeHardCap,
  syncRecentToStats,
  type StatsSyncResult,
  NEAR_WINDOW_STRATEGY,
  STATS_SYNC_FULL_HARD_CAP,
  resolvePersistWatermark,
} from "./stats-sync";
import { statsScheduler } from "./stats-schedule";
import {
  appendLog,
  appendScrobbleRecord,
  friendlyLastFmError,
  isInvalidSessionError,
  loadSettings,
  loadStatsSyncState,
  markSessionInvalid,
  saveStatsSyncState,
  type StatsSyncStored,
} from "./store";

export type StatsSyncSource = "manual" | "scheduled";

/** incremental = settings hardCap + watermark; full = 尽量同步 (high cap, ignore watermark once). */
export type StatsSyncMode = "incremental" | "full";

export interface StatsSyncRunOptions {
  mode?: StatsSyncMode;
}

export interface StatsSyncRunOk {
  ok: true;
  skipped?: false;
  last: StatsSyncStored;
  summary: string;
  source: StatsSyncSource;
}

export interface StatsSyncRunFail {
  ok: false;
  skipped?: false;
  error: string;
  last: StatsSyncStored;
  summary: string;
  source: StatsSyncSource;
  httpStatus: number;
}

export interface StatsSyncRunSkipped {
  ok: false;
  skipped: true;
  reason: "skipped_busy";
  source: StatsSyncSource;
}

export type StatsSyncRunResult = StatsSyncRunOk | StatsSyncRunFail | StatsSyncRunSkipped;



function toStored(result: StatsSyncResult, hardCap: number): StatsSyncStored {
  const base: StatsSyncStored = {
    ts: result.ts,
    ok: result.ok,
    fetched: result.fetched,
    matched: result.matched,
    imported: result.imported,
    skippedNear: result.skippedNear,
    skippedExact: result.skippedExact,
    unmatched: result.unmatched,
    watermarkUts: result.watermarkUts,
    nearWindowStrategy: result.nearWindowStrategy || NEAR_WINDOW_STRATEGY,
    hardCap,
  };
  if (result.truncated) base.truncated = true;
  if (!result.ok && result.reason) base.reason = result.reason;
  else if (result.ok && result.unmatchedSamples?.length) {
    base.unmatchedSamples = result.unmatchedSamples;
  }
  return base;
}

async function executeStatsSync(
  source: StatsSyncSource,
  opts?: StatsSyncRunOptions
): Promise<StatsSyncRunOk | StatsSyncRunFail> {
  await refreshScrobbler();
  const settings = await loadSettings();
  const prev = await loadStatsSyncState();
  const mode: StatsSyncMode = opts?.mode === "full" ? "full" : "incremental";
  // Scheduled ticks must stay incremental (never inherit a stale full intent).
  const effectiveMode: StatsSyncMode =
    source === "scheduled" ? "incremental" : mode;
  const hardCap =
    effectiveMode === "full"
      ? STATS_SYNC_FULL_HARD_CAP
      : normalizeHardCap(settings.statsSyncHardCap);
  // Full backfill ignores watermark once; near-window + import exact-dedupe still prevent doubles.
  const watermarkUts =
    effectiveMode === "full" ? 0 : prev?.watermarkUts || 0;
  const client = getScrobbler();

  if (!client || !(await client.isReady()) || !settings.username) {
    const reason = !settings.username
      ? "尚未连接账号（缺少用户名）"
      : "尚未连接账号：需要应用凭证 + 已连接的账号";
    const fail = toStored(
      {
        ok: false,
        ts: Date.now(),
        fetched: 0,
        matched: 0,
        imported: 0,
        skippedNear: 0,
        skippedExact: 0,
        unmatched: 0,
        watermarkUts: prev?.watermarkUts || 0,
        nearWindowStrategy: NEAR_WINDOW_STRATEGY,
        reason,
      },
      hardCap
    );
    await saveStatsSyncState(fail);
    await appendScrobbleRecord({
      title: "播放统计同步",
      artist: "lastfm→stats",
      ok: false,
      reason,
      path: "stats_sync",
      source,
    });
    return {
      ok: false,
      error: reason,
      last: fail,
      summary: formatStatsSyncSummary(fail as StatsSyncResult),
      source,
      httpStatus: 400,
    };
  }

  const result = await syncRecentToStats({
    scrobbler: client,
    username: settings.username,
    songsApi: songloft.songs,
    hardCap,
    watermarkUts,
  });

  if (!result.ok) {
    if (isInvalidSessionError(result.reason)) {
      await markSessionInvalid();
      await refreshScrobbler();
    }
    const reason = friendlyLastFmError(result.reason);
    const failResult = {
      ...result,
      reason,
      watermarkUts: resolvePersistWatermark(prev?.watermarkUts, result.watermarkUts),
    };
    const stored = await saveStatsSyncState(toStored(failResult, hardCap));
    await appendScrobbleRecord({
      title: "播放统计同步",
      artist: "lastfm→stats",
      ok: false,
      reason,
      path: "stats_sync",
      source,
    });
    await appendLog("error", `stats sync failed (${source}): ${reason}`);
    return {
      ok: false,
      error: reason,
      last: stored,
      summary: formatStatsSyncSummary(stored as StatsSyncResult),
      source,
      httpStatus: /未安装|未启用/.test(reason) ? 503 : 400,
    };
  }

  const okResult = {
    ...result,
    watermarkUts: resolvePersistWatermark(prev?.watermarkUts, result.watermarkUts),
  };
  const stored = await saveStatsSyncState(toStored(okResult, hardCap));
  const summary = formatStatsSyncSummary(stored as StatsSyncResult);
  await appendScrobbleRecord({
    title: "播放统计同步",
    artist: "lastfm→stats",
    ok: true,
    reason: summary,
    path: "stats_sync",
    source,
  });
  if (result.unmatchedSamples?.length) {
    const sample = result.unmatchedSamples
      .slice(0, 5)
      .map((s) => `${s.artist} - ${s.title}`)
      .join("; ");
    await appendLog("info", `stats sync unmatched sample: ${sample}`);
  }
  await appendLog(
    "info",
    `stats sync ok (${source}/${effectiveMode}): fetched=${result.fetched} matched=${result.matched} imported=${result.imported} near=${result.skippedNear} unmatched=${result.unmatched} wm=${okResult.watermarkUts} hardCap=${hardCap}`
  );
  return { ok: true, last: stored, summary, source };
}

/**
 * Run under Loved's exclusive lock so Loved↔stats never double-write concurrently.
 * mode=full →「尽量同步」: hardCap=STATS_SYNC_FULL_HARD_CAP, watermark ignored for this run.
 */
export async function runStatsSync(
  source: StatsSyncSource,
  opts?: StatsSyncRunOptions
): Promise<StatsSyncRunResult> {
  const gate = await lovedScheduler.runExclusive(() => executeStatsSync(source, opts));
  if (gate.skipped) {
    await appendLog("info", `stats sync ${gate.reason} (${source})`);
    return { ok: false, skipped: true, reason: "skipped_busy", source };
  }
  const result = gate.result;
  if (result.ok) {
    await statsScheduler.noteSuccess(result.last.ts);
  } else if (source === "scheduled") {
    await statsScheduler.noteAttemptFinished(false);
  }
  return result;
}

export function bindStatsScheduleTick(): void {
  statsScheduler.setOnTick(async () => {
    const result = await runStatsSync("scheduled");
    if (result.skipped) {
      songloft.log.info("[lastfm] stats schedule tick skipped_busy");
      return;
    }
    if (result.ok) {
      songloft.log.info(`[lastfm] stats schedule sync ok: ${result.summary}`);
    } else {
      songloft.log.warn(`[lastfm] stats schedule sync failed: ${result.error}`);
    }
  });
}
