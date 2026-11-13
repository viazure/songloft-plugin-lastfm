/** Shared Loved → Songloft 红心（收藏） sync runner (manual + scheduled). */

import { getScrobbler, refreshScrobbler } from "./engine";
import { LastFmScrobbler } from "./scrobbler";
import {
  formatLovedSyncSummary,
  syncLovedToPlaylist,
  FAVORITES_PLAYLIST_NAME,
  LOVED_HARD_CAP,
  resolveLovedPlaylistName,
  type LovedPlaylistSyncResult,
} from "./loved-playlist";
import { lovedScheduler } from "./loved-schedule";
import { isFullStatsSyncQueued } from "./stats-sync-run";
import { getWritebackService, syncWritebackSubscription } from "./writeback-service";
import {
  appendLog,
  appendScrobbleRecord,
  friendlyLastFmError,
  isInvalidSessionError,
  loadLovedPlaylistSync,
  loadSettings,
  markSessionInvalid,
  normalizeLovedSyncTarget,
  saveLovedPlaylistSync,
  type LovedPlaylistSyncStored,
} from "./store";

export type LovedSyncSource = "manual" | "scheduled";

/** 写回开启且目的地是内置「收藏」时才做三路合并；其余情形保持覆盖语义。 */
export function shouldUseWritebackMerge(opts: {
  target: "favorites" | "playlist";
  writebackEnabled: boolean;
}): boolean {
  return opts.target === "favorites" && opts.writebackEnabled === true;
}

/** 写回开启 + 目的地=收藏：按起点三路合并，不做覆盖式对齐。 */
async function syncLovedWithWriteback(
  client: LastFmScrobbler,
  username: string
): Promise<LovedPlaylistSyncResult> {
  const merge = await getWritebackService().reconcileFavorites({
    scrobbler: client,
    username,
    hardCap: LOVED_HARD_CAP,
  });
  const ts = Date.now();
  if (!merge.ok) {
    return {
      ok: false,
      ts,
      loved: merge.loved,
      matched: merge.matched,
      unmatched: merge.unmatched,
      truncated: merge.truncated,
      unmatchedSamples: merge.unmatchedSamples,
      reason: merge.reason || "合并同步失败",
    };
  }
  const note = merge.initializedSnapshot
    ? "已记下当前喜欢作为起点（本次不补齐历史差异）"
    : `收藏 +${merge.added}/-${merge.removed} · 红心 +${merge.lovedCount}/-${merge.unlovedCount}` +
      (merge.conflicts ? ` · 冲突 ${merge.conflicts}（听本地）` : "") +
      (merge.removalsSuppressed ? " · 列表不完整已跳过删除" : "");
  // 起点刚落地（例如记起点曾失败后点「立即同步」）时补订阅。
  if (merge.initializedSnapshot) {
    try {
      await syncWritebackSubscription();
    } catch {
      /* 订阅失败不回滚已记下的起点 */
    }
  }
  return {
    ok: true,
    ts,
    loved: merge.loved,
    matched: merge.matched,
    unmatched: merge.unmatched,
    truncated: merge.truncated,
    playlistId: merge.playlistId ?? 0,
    playlistIdChanged: false,
    created: false,
    unmatchedSamples: merge.unmatchedSamples,
    playlistName: FAVORITES_PLAYLIST_NAME,
    targetChanged: false,
    reason: [note, merge.reason].filter(Boolean).join(" · "),
    removalsSuppressed: merge.removalsSuppressed,
  };
}

export interface LovedSyncRunOk {
  ok: true;
  skipped?: false;
  last: LovedPlaylistSyncStored;
  summary: string;
  playlistId: number;
  created: boolean;
  playlistIdChanged: boolean;
  truncated: boolean;
  unmatchedSamples: Array<{ artist: string; title: string }>;
  source: LovedSyncSource;
}

export interface LovedSyncRunFail {
  ok: false;
  skipped?: false;
  error: string;
  last: LovedPlaylistSyncStored;
  summary: string;
  source: LovedSyncSource;
  httpStatus: number;
}

export interface LovedSyncRunSkipped {
  ok: false;
  skipped: true;
  reason: "skipped_busy";
  source: LovedSyncSource;
}

export type LovedSyncRunResult = LovedSyncRunOk | LovedSyncRunFail | LovedSyncRunSkipped;

async function executeLovedPlaylistSync(source: LovedSyncSource): Promise<LovedSyncRunOk | LovedSyncRunFail> {
  await refreshScrobbler();
  const settings = await loadSettings();
  const target = normalizeLovedSyncTarget(settings.lovedSyncTarget);
  const destTitle =
    target === "playlist"
      ? resolveLovedPlaylistName(settings.lovedPlaylistName)
      : FAVORITES_PLAYLIST_NAME;
  const client = getScrobbler();
  if (!client || !(await client.isReady()) || !settings.username) {
    const reason = !settings.username
      ? "尚未连接账号（缺少用户名）"
      : "尚未连接账号：需要应用凭证 + 已连接的账号";
    const fail = {
      ts: Date.now(),
      ok: false as const,
      loved: 0,
      matched: 0,
      unmatched: 0,
      reason,
      playlistName: destTitle,
    };
    await saveLovedPlaylistSync(fail);
    await appendScrobbleRecord({
      title: destTitle,
      artist: "playlist",
      ok: false,
      reason,
      path: "loved_playlist_sync",
      source,
    });
    return {
      ok: false,
      error: reason,
      last: fail,
      summary: formatLovedSyncSummary(fail),
      source,
      httpStatus: 400,
    };
  }

  const previous = await loadLovedPlaylistSync();
  const useMerge = shouldUseWritebackMerge({ target, writebackEnabled: settings.lovedWritebackEnabled });
  const result: LovedPlaylistSyncResult = useMerge
    ? await syncLovedWithWriteback(client, settings.username)
    : await syncLovedToPlaylist({
        scrobbler: client,
        username: settings.username,
        songsApi: songloft.songs,
        playlistsApi: songloft.playlists,
        target,
        playlistName: settings.lovedPlaylistName,
        previousPlaylistName: previous?.playlistName,
      });

  if (!result.ok) {
    if (isInvalidSessionError(result.reason)) {
      await markSessionInvalid();
      await refreshScrobbler();
    }
    const reason = friendlyLastFmError(result.reason);
    const stored = await saveLovedPlaylistSync({ ...result, reason });
    await appendScrobbleRecord({
      title: destTitle,
      artist: "playlist",
      ok: false,
      reason,
      path: "loved_playlist_sync",
      source,
    });
    await appendLog("error", `loved playlist sync failed (${source}): ${reason}`);
    return {
      ok: false,
      error: reason,
      last: stored,
      summary: formatLovedSyncSummary(stored),
      source,
      httpStatus: 400,
    };
  }

  const summaryBits = `loved ${result.loved} · 对上 ${result.matched} · 没对上 ${result.unmatched}`;
  const truncNote = result.truncated ? " · truncated@1000" : "";
  const stored = await saveLovedPlaylistSync({
    ts: result.ts,
    ok: true,
    loved: result.loved,
    matched: result.matched,
    unmatched: result.unmatched,
    truncated: result.truncated,
    playlistId: result.playlistId,
    playlistIdChanged: result.playlistIdChanged,
    unmatchedSamples: result.unmatchedSamples,
    playlistName: result.playlistName,
    reason: [summaryBits + truncNote, result.reason].filter(Boolean).join(" · "),
  });
  await appendScrobbleRecord({
    title: result.playlistName,
    artist: "playlist",
    ok: true,
    reason: [summaryBits + truncNote, result.reason].filter(Boolean).join(" · "),
    path: "loved_playlist_sync",
    source,
  });
  if (result.unmatchedSamples?.length) {
    const sample = result.unmatchedSamples
      .slice(0, 5)
      .map((s) => `${s.artist} - ${s.title}`)
      .join("; ");
    await appendLog("info", `loved playlist unmatched sample: ${sample}`);
  }
  await appendLog(
    "info",
    `loved playlist sync ok (${source}): ${summaryBits}${truncNote} id=${result.playlistId}`
  );
  return {
    ok: true,
    last: stored,
    summary: formatLovedSyncSummary(stored),
    playlistId: result.playlistId,
    created: result.created,
    playlistIdChanged: result.playlistIdChanged,
    truncated: result.truncated,
    unmatchedSamples: result.unmatchedSamples,
    source,
  };
}

/**
 * Run Loved sync under the exclusive lock shared with the scheduler.
 * Manual and scheduled both go through here so they cannot double-write.
 */
export async function runLovedPlaylistSync(source: LovedSyncSource): Promise<LovedSyncRunResult> {
  // Full stats sync accepted but not yet holding exclusive lock — do not steal it.
  if (isFullStatsSyncQueued()) {
    await appendLog("info", `loved playlist sync skipped_busy (full stats queued) (${source})`);
    return { ok: false, skipped: true, reason: "skipped_busy", source };
  }
  const gate = await lovedScheduler.runExclusive(() => executeLovedPlaylistSync(source));
  if (gate.skipped) {
    await appendLog("info", `loved playlist sync ${gate.reason} (${source})`);
    return { ok: false, skipped: true, reason: "skipped_busy", source };
  }
  const result = gate.result;
  if (result.ok) {
    await lovedScheduler.noteSuccess(result.last.ts);
  } else if (source === "scheduled") {
    // Failed scheduled attempt: keep switch on, retry after interval.
    await lovedScheduler.noteAttemptFinished(false);
  }
  return result;
}

/** Wire scheduler tick → same runner (scheduled source). */
export function bindLovedScheduleTick(): void {
  lovedScheduler.setOnTick(async () => {
    const result = await runLovedPlaylistSync("scheduled");
    if (result.skipped) {
      songloft.log.info("[lastfm] loved schedule tick skipped_busy");
      return;
    }
    if (result.ok) {
      songloft.log.info(`[lastfm] loved schedule sync ok: ${result.summary}`);
    } else {
      songloft.log.warn(`[lastfm] loved schedule sync failed: ${result.error}`);
    }
  });
}
