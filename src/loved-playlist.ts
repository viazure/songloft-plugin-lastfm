/** Last.fm Loved → Songloft 红心（收藏）或自定义普通歌单。单向覆盖写入，不做反向同步。 */

import { LastFmScrobbler } from "./scrobbler";
import { matchLovedTracks, type LibrarySongRef } from "./match";

/** Default custom-playlist name when lovedPlaylistName is empty. */
export const LOVED_PLAYLIST_NAME = "Last.fm Loved";

/** Trim; empty / whitespace-only → default. Never returns empty string. */
export function resolveLovedPlaylistName(raw?: string | null): string {
  const name = typeof raw === "string" ? raw.trim() : "";
  return name || LOVED_PLAYLIST_NAME;
}

/** Host label for built-in playlists (收藏 / 电台收藏). */
export const BUILTIN_PLAYLIST_LABEL = "built_in";

/** Display name of the built-in favorites playlist. Used in messages only, not as the lookup key. */
export const FAVORITES_PLAYLIST_NAME = "收藏";

export const LOVED_HARD_CAP = 1000;
export const ADD_CHUNK = 200;

export interface LovedPlaylistSyncOk {
  ok: true;
  ts: number;
  loved: number;
  matched: number;
  unmatched: number;
  truncated: boolean;
  playlistId: number;
  playlistIdChanged: boolean;
  created: boolean;
  unmatchedSamples: Array<{ artist: string; title: string }>;
  playlistName: string;
  /** True when resolved custom playlist name differs from previousPlaylistName. Always false for favorites. */
  targetChanged: boolean;
  writeMethod?: "replaceSongs" | "clearAdd" | "recreate";
}

export interface LovedPlaylistSyncFail {
  ok: false;
  ts: number;
  loved: number;
  matched: number;
  unmatched: number;
  truncated?: boolean;
  reason: string;
  unmatchedSamples?: Array<{ artist: string; title: string }>;
}

export type LovedPlaylistSyncResult = LovedPlaylistSyncOk | LovedPlaylistSyncFail;

export function formatLovedSyncSummary(r: LovedPlaylistSyncResult | null | undefined): string {
  if (!r) return "尚未同步过";
  const when = new Date(r.ts).toLocaleString();
  if (!r.ok) {
    const partial =
      r.loved > 0
        ? `（已拉到 loved ${r.loved}·对上 ${r.matched}·没对上 ${r.unmatched}）`
        : "";
    return `${when} · 失败：${r.reason}${partial}`;
  }
  const trunc = r.truncated ? " · 已截断" : "";
  return `${when} · loved ${r.loved} · 对上 ${r.matched} · 没对上 ${r.unmatched}${trunc}`;
}

/** List all library songs via plugin SDK (paged). */
export async function listAllLibrarySongs(
  songsApi: { list(options?: { limit?: number; offset?: number }): Promise<Song[]> },
  pageSize: number = 500
): Promise<LibrarySongRef[]> {
  const out: LibrarySongRef[] = [];
  let offset = 0;
  for (;;) {
    const batch = await songsApi.list({ limit: pageSize, offset });
    if (!Array.isArray(batch) || batch.length === 0) break;
    for (const s of batch) {
      if (!s || typeof s.id !== "number") continue;
      const ref: LibrarySongRef = {
        id: s.id,
        artist: String(s.artist || ""),
        title: String(s.title || ""),
      };
      const extra = s as Song & { mbid?: string };
      if (typeof extra.mbid === "string" && extra.mbid.trim()) {
        ref.mbid = extra.mbid.trim();
      }
      out.push(ref);
    }
    if (batch.length < pageSize) break;
    offset += pageSize;
  }
  return out;
}

export type PlaylistsApi = {
  list(): Promise<Playlist[]>;
  getSongs(
    playlistId: number,
    options?: { limit?: number; offset?: number }
  ): Promise<Song[]>;
  addSongs(playlistId: number, songIds: number[]): Promise<{ added: number; skipped: number }>;
  removeSongs(playlistId: number, songIds: number[]): Promise<void>;
  /**
   * Host #558 atomic replace. Not in @songloft/plugin-sdk typings as of 2.16;
   * resolved at runtime via a safe extension call. Current host rejects built-in playlists.
   */
  replaceSongs?(playlistId: number, songIds: number[]): Promise<void>;
  create?(input: { name: string; type?: "normal" | "radio"; description?: string }): Promise<Playlist>;
  delete?(id: number): Promise<void>;
};

function playlistLabels(p: { labels?: string[] } | null | undefined): string[] {
  return p && Array.isArray(p.labels) ? p.labels.map(String) : [];
}

/** Built-in Songloft 红心: labels include built_in and type === "normal". Do not match by name. */
export function isBuiltInFavorites(p: { type?: string; labels?: string[] } | null | undefined): boolean {
  if (!p || p.type !== "normal") return false;
  return playlistLabels(p).includes(BUILTIN_PLAYLIST_LABEL);
}

export function isBuiltInRadioFavorites(p: { type?: string; labels?: string[] } | null | undefined): boolean {
  if (!p || p.type !== "radio") return false;
  return playlistLabels(p).includes(BUILTIN_PLAYLIST_LABEL);
}

export async function findBuiltInFavorites(api: PlaylistsApi): Promise<Playlist | null> {
  const list = await api.list();
  const hit = (list || []).find((p) => isBuiltInFavorites(p));
  return hit || null;
}

/**
 * Resolve playlists.replaceSongs at runtime. SDK typings may omit it; do not upgrade the SDK.
 */
export function getReplaceSongs(
  api: PlaylistsApi
): ((playlistId: number, songIds: number[]) => Promise<void>) | null {
  const fn = (api as PlaylistsApi & { replaceSongs?: unknown }).replaceSongs;
  if (typeof fn !== "function") return null;
  return (playlistId, songIds) => fn.call(api, playlistId, songIds);
}

async function clearPlaylistSongs(api: PlaylistsApi, playlistId: number): Promise<number> {
  const songs = await api.getSongs(playlistId);
  const ids = (songs || []).map((s) => s.id).filter((id) => typeof id === "number");
  if (!ids.length) return 0;
  for (let i = 0; i < ids.length; i += ADD_CHUNK) {
    await api.removeSongs(playlistId, ids.slice(i, i + ADD_CHUNK));
  }
  return ids.length;
}

async function addInChunks(api: PlaylistsApi, playlistId: number, songIds: number[]): Promise<void> {
  for (let i = 0; i < songIds.length; i += ADD_CHUNK) {
    await api.addSongs(playlistId, songIds.slice(i, i + ADD_CHUNK));
  }
}

/**
 * Overwrite the built-in 收藏 playlist with songIds.
 * Prefers playlists.replaceSongs when the host exposes it; on missing method or failure
 * (including host "cannot replace built-in playlist"), falls back to chunked removeSongs + addSongs.
 * Never deletes or recreates the playlist (built-in playlists cannot be deleted).
 */
export async function writeFavoritesPlaylist(
  api: PlaylistsApi,
  songIds: number[],
  playlistId: number
): Promise<{ playlistId: number; writeMethod: "replaceSongs" | "clearAdd" }> {
  const replace = getReplaceSongs(api);
  if (replace) {
    try {
      await replace(playlistId, songIds);
      return { playlistId, writeMethod: "replaceSongs" };
    } catch {
      // fall through to clear+add
    }
  }
  await clearPlaylistSongs(api, playlistId);
  if (songIds.length) await addInChunks(api, playlistId, songIds);
  return { playlistId, writeMethod: "clearAdd" };
}

export async function findPlaylistByName(api: PlaylistsApi, name: string): Promise<Playlist | null> {
  const list = await api.list();
  const hit = (list || []).find((p) => p && p.name === name);
  return hit || null;
}

/** Ordinary (non-built-in) normal playlists may be deleted and recreated when clear fails. */
export function mayDeleteAndRecreatePlaylist(
  p: { type?: string; labels?: string[] } | null | undefined
): boolean {
  if (!p || p.type !== "normal") return false;
  return !playlistLabels(p).includes(BUILTIN_PLAYLIST_LABEL);
}

/**
 * Cover-refresh a named ordinary playlist: clear+add keeping id when possible;
 * if clear fails fatally, delete+recreate is allowed only for a normal non-built-in playlist.
 * Missing playlist → create a normal one. Empty matched set → empty playlist (allowed).
 * If the name happens to match the built-in 收藏, write via writeFavoritesPlaylist (never delete).
 */
export async function upsertLovedPlaylist(
  api: PlaylistsApi,
  songIds: number[],
  name: string = LOVED_PLAYLIST_NAME
): Promise<{
  playlistId: number;
  created: boolean;
  playlistIdChanged: boolean;
  writeMethod: "replaceSongs" | "clearAdd" | "recreate";
}> {
  const existing = await findPlaylistByName(api, name);
  if (existing) {
    const playlistId = existing.id;
    if (isBuiltInFavorites(existing)) {
      const written = await writeFavoritesPlaylist(api, songIds, playlistId);
      return {
        playlistId: written.playlistId,
        created: false,
        playlistIdChanged: false,
        writeMethod: written.writeMethod,
      };
    }
    if (!mayDeleteAndRecreatePlaylist(existing)) {
      throw new Error("不能把内置歌单当作自定义同步目标来删除重建");
    }
    try {
      await clearPlaylistSongs(api, playlistId);
      if (songIds.length) await addInChunks(api, playlistId, songIds);
      return { playlistId, created: false, playlistIdChanged: false, writeMethod: "clearAdd" };
    } catch {
      if (typeof api.delete === "function") {
        try {
          await api.delete(playlistId);
        } catch {
          /* continue to create */
        }
      }
      if (typeof api.create !== "function") {
        throw new Error("清空歌单失败，且无法重建普通歌单");
      }
      const created = await api.create({
        name,
        type: "normal",
        description: "Synced from Last.fm loved tracks",
      });
      if (songIds.length) await addInChunks(api, created.id, songIds);
      return {
        playlistId: created.id,
        created: true,
        playlistIdChanged: true,
        writeMethod: "recreate",
      };
    }
  }
  if (typeof api.create !== "function") {
    throw new Error("未找到歌单且无法创建");
  }
  const created = await api.create({
    name,
    type: "normal",
    description: "Synced from Last.fm loved tracks",
  });
  if (songIds.length) await addInChunks(api, created.id, songIds);
  return { playlistId: created.id, created: true, playlistIdChanged: false, writeMethod: "clearAdd" };
}

export interface SyncDeps {
  scrobbler: LastFmScrobbler;
  username: string;
  songsApi: { list(options?: { limit?: number; offset?: number }): Promise<Song[]> };
  playlistsApi: PlaylistsApi;
  hardCap?: number;
  now?: () => number;
  /**
   * Destination for this run. Missing / other values → favorites (built-in 收藏).
   */
  target?: "favorites" | "playlist";
  /** Used when target is "playlist". resolveLovedPlaylistName applied inside sync. */
  playlistName?: string;
  /** Prior synced playlist name (for targetChanged note on the playlist destination). */
  previousPlaylistName?: string | null;
}

/**
 * Full sync pipeline (callable from router). Independent of onlyMiot / scrobble / keep-alive.
 * Default destination is Songloft 红心 (built-in 收藏). Optional custom ordinary playlist.
 */
export async function syncLovedToPlaylist(deps: SyncDeps): Promise<LovedPlaylistSyncResult> {
  const ts = (deps.now || Date.now)();
  const hardCap = deps.hardCap ?? LOVED_HARD_CAP;
  const partial: {
    loved: number;
    matched: number;
    unmatched: number;
    truncated?: boolean;
    unmatchedSamples?: Array<{ artist: string; title: string }>;
  } = { loved: 0, matched: 0, unmatched: 0 };
  try {
    const loved = await deps.scrobbler.getLovedTracks({
      username: deps.username,
      hardCap,
    });
    partial.loved = loved.tracks.length;
    partial.truncated = loved.truncated;
    const library = await listAllLibrarySongs(deps.songsApi);
    const match = matchLovedTracks(loved.tracks, library);
    partial.matched = match.matched;
    partial.unmatched = match.unmatched;
    partial.unmatchedSamples = match.unmatchedSamples;
    const target = deps.target === "playlist" ? "playlist" : "favorites";
    if (target === "playlist") {
      const playlistName = resolveLovedPlaylistName(deps.playlistName);
      const prev = typeof deps.previousPlaylistName === "string" ? deps.previousPlaylistName.trim() : "";
      const targetChanged = !!prev && prev !== playlistName;
      const upsert = await upsertLovedPlaylist(deps.playlistsApi, match.matchedIds, playlistName);
      return {
        ok: true,
        ts,
        loved: loved.tracks.length,
        matched: match.matched,
        unmatched: match.unmatched,
        truncated: loved.truncated,
        playlistId: upsert.playlistId,
        playlistIdChanged: upsert.playlistIdChanged,
        created: upsert.created,
        unmatchedSamples: match.unmatchedSamples,
        playlistName,
        targetChanged,
        writeMethod: upsert.writeMethod,
      };
    }
    const favorites = await findBuiltInFavorites(deps.playlistsApi);
    if (!favorites) {
      return {
        ok: false,
        ts,
        loved: loved.tracks.length,
        matched: match.matched,
        unmatched: match.unmatched,
        truncated: loved.truncated,
        unmatchedSamples: match.unmatchedSamples,
        reason: "未找到内置「收藏」歌单",
      };
    }
    const written = await writeFavoritesPlaylist(deps.playlistsApi, match.matchedIds, favorites.id);
    return {
      ok: true,
      ts,
      loved: loved.tracks.length,
      matched: match.matched,
      unmatched: match.unmatched,
      truncated: loved.truncated,
      playlistId: written.playlistId,
      playlistIdChanged: false,
      created: false,
      unmatchedSamples: match.unmatchedSamples,
      playlistName: favorites.name || FAVORITES_PLAYLIST_NAME,
      targetChanged: false,
      writeMethod: written.writeMethod,
    };
  } catch (e) {
    // Preserve any counts already obtained before the failure (do not flash false zeros).
    return {
      ok: false,
      ts,
      loved: partial.loved,
      matched: partial.matched,
      unmatched: partial.unmatched,
      truncated: partial.truncated,
      unmatchedSamples: partial.unmatchedSamples,
      reason: String(e ?? "未知错误"),
    };
  }
}
