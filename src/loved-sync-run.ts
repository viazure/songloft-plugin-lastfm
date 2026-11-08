/** Shared Loved→playlist sync runner (manual + scheduled). */

import { getScrobbler, refreshScrobbler } from "./engine";
import {
  resolveLovedPlaylistName,
  formatLovedSyncSummary,
  syncLovedToPlaylist,
  type LovedPlaylistSyncResult,
} from "./loved-playlist";
import { lovedScheduler } from "./loved-schedule";
import { isFullStatsSyncQueued } from "./stats-sync-run";
import {
  appendLog,
  appendScrobbleRecord,
  friendlyLastFmError,
  isInvalidSessionError,
  loadLovedPlaylistSync,
  loadSettings,
  markSessionInvalid,
  saveLovedPlaylistSync,
  type LovedPlaylistSyncStored,
} from "./store";

export type LovedSyncSource = "manual" | "scheduled";

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
    };
    await saveLovedPlaylistSync(fail);
    await appendScrobbleRecord({
      title: resolveLovedPlaylistName(settings.lovedPlaylistName),
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
  const playlistName = resolveLovedPlaylistName(settings.lovedPlaylistName);
  const result: LovedPlaylistSyncResult = await syncLovedToPlaylist({
    scrobbler: client,
    username: settings.username,
    songsApi: songloft.songs,
    playlistsApi: songloft.playlists,
    playlistName,
    previousPlaylistName: previous?.playlistName || null,
  });

  if (!result.ok) {
    if (isInvalidSessionError(result.reason)) {
      await markSessionInvalid();
      await refreshScrobbler();
    }
    const reason = friendlyLastFmError(result.reason);
    const stored = await saveLovedPlaylistSync({ ...result, reason });
    await appendScrobbleRecord({
      title: resolveLovedPlaylistName(settings.lovedPlaylistName),
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
  const idNote = result.playlistIdChanged ? " · playlist id changed" : "";
  const targetNote = result.targetChanged ? " · 目标歌单已变" : "";
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
    reason: summaryBits + truncNote + idNote + targetNote,
  });
  await appendScrobbleRecord({
    title: result.playlistName,
    artist: "playlist",
    ok: true,
    reason: summaryBits + truncNote + targetNote,
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
