/**
 * Last.fm recent scrobbles → stats PlayRecord feeder.
 * Near-window strategy: GET stats /api/history/raw and skip same songId with |Δt|≤120s.
 * Does NOT write on local scrobble success (avoids double-count with stats finish).
 */

import { listAllLibrarySongs } from "./loved-playlist";
import { buildLibraryIndexes, resolveSongId } from "./match";
import type { LastFmScrobbler } from "./scrobbler";
import {
  fetchRawHistoryWindow,
  importPlayRecords,
  probeStatsAvailable,
  type StatsFetchFn,
  type StatsPlayRecord,
} from "./stats-client";

export const STATS_SYNC_DEFAULT_HARD_CAP = 500;
/** Absolute clamp for settings / normalizeHardCap (also covers 尽量同步). */
export const STATS_SYNC_MAX_HARD_CAP = 5000;
/** One-shot「尽量同步」hard cap: page recent until this or watermark/exhaust. */
export const STATS_SYNC_FULL_HARD_CAP = 5000;
export const NEAR_WINDOW_MS = 120_000;
/** Observation label for near-window strategy (shown in summaries). */
export const NEAR_WINDOW_STRATEGY = "history/raw|Δt|≤120s";

export function normalizeHardCap(v: unknown): number {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  if (!Number.isFinite(n)) return STATS_SYNC_DEFAULT_HARD_CAP;
  return Math.min(STATS_SYNC_MAX_HARD_CAP, Math.max(1, Math.floor(n)));
}

/** Never let a full-mode (watermark-in=0) fail/empty run wipe a higher persisted watermark. */
export function resolvePersistWatermark(
  prevWatermarkUts: number | null | undefined,
  resultWatermarkUts: number | null | undefined
): number {
  const prev =
    typeof prevWatermarkUts === "number" && Number.isFinite(prevWatermarkUts)
      ? Math.max(0, Math.floor(prevWatermarkUts))
      : 0;
  const next =
    typeof resultWatermarkUts === "number" && Number.isFinite(resultWatermarkUts)
      ? Math.max(0, Math.floor(resultWatermarkUts))
      : 0;
  return Math.max(prev, next);
}

export interface RecentTrackRef {
  artist: string;
  title: string;
  mbid?: string;
  uts: number;
}

export interface MatchedCandidate {
  songId: number;
  title: string;
  artist: string;
  timestamp: number;
  uts: number;
  source: "lastfm";
}

/** Pure: match recent tracks → candidates; count unmatched. No fake songIds. */
export function matchRecentToCandidates(
  tracks: RecentTrackRef[],
  library: Array<{ id: number; artist: string; title: string; mbid?: string }>
): {
  candidates: MatchedCandidate[];
  matched: number;
  unmatched: number;
  unmatchedSamples: Array<{ artist: string; title: string }>;
} {
  const indexes = buildLibraryIndexes(library);
  const candidates: MatchedCandidate[] = [];
  const unmatchedSamples: Array<{ artist: string; title: string }> = [];
  let unmatched = 0;
  for (const t of tracks) {
    const id = resolveSongId(t, indexes);
    if (id == null || !Number.isFinite(id) || id <= 0) {
      unmatched += 1;
      if (unmatchedSamples.length < 10) {
        unmatchedSamples.push({ artist: t.artist, title: t.title });
      }
      continue;
    }
    candidates.push({
      songId: id,
      title: t.title,
      artist: t.artist,
      timestamp: t.uts * 1000,
      uts: t.uts,
      source: "lastfm",
    });
  }
  return {
    candidates,
    matched: candidates.length,
    unmatched,
    unmatchedSamples,
  };
}

/** Pure: drop candidates that collide with existing stats within |Δt|≤nearWindowMs. */
export function filterNearWindow(
  candidates: MatchedCandidate[],
  existing: Array<{ songId: number; timestamp: number }>,
  nearWindowMs: number = NEAR_WINDOW_MS
): { kept: MatchedCandidate[]; skippedNear: number } {
  const bySong = new Map<number, number[]>();
  for (const r of existing) {
    if (!r || typeof r.songId !== "number" || typeof r.timestamp !== "number") continue;
    const list = bySong.get(r.songId) || [];
    list.push(r.timestamp);
    bySong.set(r.songId, list);
  }
  const kept: MatchedCandidate[] = [];
  let skippedNear = 0;
  for (const c of candidates) {
    const stamps = bySong.get(c.songId) || [];
    const hit = stamps.some((ts) => Math.abs(ts - c.timestamp) <= nearWindowMs);
    if (hit) {
      skippedNear += 1;
      continue;
    }
    kept.push(c);
  }
  return { kept, skippedNear };
}

export interface StatsSyncOk {
  ok: true;
  ts: number;
  fetched: number;
  matched: number;
  imported: number;
  skippedNear: number;
  skippedExact: number;
  unmatched: number;
  truncated: boolean;
  watermarkUts: number;
  nearWindowStrategy: string;
  unmatchedSamples?: Array<{ artist: string; title: string }>;
}

export interface StatsSyncFail {
  ok: false;
  ts: number;
  fetched: number;
  matched: number;
  imported: number;
  skippedNear: number;
  skippedExact: number;
  unmatched: number;
  truncated?: boolean;
  watermarkUts: number;
  nearWindowStrategy: string;
  reason: string;
}

export type StatsSyncResult = StatsSyncOk | StatsSyncFail;

export function formatStatsSyncSummary(r: StatsSyncResult | null | undefined): string {
  if (!r) return "尚未同步过";
  const when = new Date(r.ts).toLocaleString();
  const base =
    `拉取 ${r.fetched} · 命中 ${r.matched} · 导入 ${r.imported}` +
    ` · 跳过(近窗) ${r.skippedNear}` +
    (r.skippedExact ? ` · 跳过(已存在) ${r.skippedExact}` : "") +
    ` · 未匹配 ${r.unmatched}`;
  if (!r.ok) {
    return `${when} · 失败：${r.reason}（${base}）`;
  }
  const trunc = r.truncated ? " · 已截断" : "";
  return `${when} · ${base}${trunc} · 近窗=${r.nearWindowStrategy}`;
}

export interface StatsSyncDeps {
  scrobbler: LastFmScrobbler;
  username: string;
  songsApi: { list(options?: { limit?: number; offset?: number }): Promise<Array<{ id: number; artist?: string; title?: string; mbid?: string }>> };
  hardCap?: number;
  /** Exclusive watermark: only tracks with uts > this. */
  watermarkUts?: number;
  fetchFn?: StatsFetchFn;
  now?: () => number;
}

/**
 * Full sync pipeline. Caller owns exclusive lock / persistence of watermark & result.
 */
export async function syncRecentToStats(deps: StatsSyncDeps): Promise<StatsSyncResult> {
  const ts = (deps.now || Date.now)();
  const hardCap = normalizeHardCap(deps.hardCap ?? STATS_SYNC_DEFAULT_HARD_CAP);
  const watermarkUts =
    typeof deps.watermarkUts === "number" && Number.isFinite(deps.watermarkUts)
      ? Math.max(0, Math.floor(deps.watermarkUts))
      : 0;
  const fetchFn = deps.fetchFn || undefined;
  const partial = {
    fetched: 0,
    matched: 0,
    imported: 0,
    skippedNear: 0,
    skippedExact: 0,
    unmatched: 0,
    truncated: false,
    watermarkUts,
  };

  try {
    const available = await probeStatsAvailable(fetchFn);
    if (!available) {
      return {
        ok: false,
        ts,
        ...partial,
        nearWindowStrategy: NEAR_WINDOW_STRATEGY,
        reason: "播放统计插件未安装或未启用",
      };
    }

    const recent = await deps.scrobbler.getRecentTracks({
      username: deps.username,
      hardCap,
      fromUts: watermarkUts > 0 ? watermarkUts : undefined,
    });
    partial.fetched = recent.tracks.length;
    partial.truncated = recent.truncated;

    if (!recent.tracks.length) {
      return {
        ok: true,
        ts,
        ...partial,
        nearWindowStrategy: NEAR_WINDOW_STRATEGY,
      };
    }

    const library = await listAllLibrarySongs(deps.songsApi);
    const matched = matchRecentToCandidates(recent.tracks, library);
    partial.matched = matched.matched;
    partial.unmatched = matched.unmatched;

    let maxUts = watermarkUts;
    for (const t of recent.tracks) {
      if (t.uts > maxUts) maxUts = t.uts;
    }

    if (!matched.candidates.length) {
      return {
        ok: true,
        ts,
        ...partial,
        watermarkUts: maxUts,
        nearWindowStrategy: NEAR_WINDOW_STRATEGY,
        unmatchedSamples: matched.unmatchedSamples,
      };
    }

    const minTs = Math.min(...matched.candidates.map((c) => c.timestamp));
    const existing = await fetchRawHistoryWindow(
      { olderThanMs: minTs - NEAR_WINDOW_MS },
      fetchFn
    );
    const { kept, skippedNear } = filterNearWindow(matched.candidates, existing);
    partial.skippedNear = skippedNear;

    const records: StatsPlayRecord[] = kept.map((c) => ({
      songId: c.songId,
      title: c.title,
      artist: c.artist,
      source: "lastfm",
      timestamp: c.timestamp,
    }));

    let added = 0;
    if (records.length) {
      const imp = await importPlayRecords(records, fetchFn);
      added = imp.added;
    }
    partial.imported = added;
    // import dedupes exact songId|timestamp — remainder of kept were already present
    partial.skippedExact = Math.max(0, records.length - added);

    return {
      ok: true,
      ts,
      ...partial,
      watermarkUts: maxUts,
      nearWindowStrategy: NEAR_WINDOW_STRATEGY,
      unmatchedSamples: matched.unmatchedSamples,
    };
  } catch (e) {
    return {
      ok: false,
      ts,
      ...partial,
      nearWindowStrategy: NEAR_WINDOW_STRATEGY,
      reason: String(e ?? "未知错误"),
    };
  }
}
