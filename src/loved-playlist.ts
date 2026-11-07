/** Last.fm Loved → Songloft playlist "Last.fm Loved" (weak substitute; not host liked sync). */

import { LastFmScrobbler } from "./scrobbler";
import { matchLovedTracks, type LibrarySongRef } from "./match";

export const LOVED_PLAYLIST_NAME = "Last.fm Loved";
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
}

export interface LovedPlaylistSyncFail {
  ok: false;
  ts: number;
  loved: number;
  matched: number;
  unmatched: number;
  truncated?: boolean;
  reason: string;
}

export type LovedPlaylistSyncResult = LovedPlaylistSyncOk | LovedPlaylistSyncFail;

export function formatLovedSyncSummary(r: LovedPlaylistSyncResult | null | undefined): string {
  if (!r) return "尚未同步过";
  const when = new Date(r.ts).toLocaleString();
  if (!r.ok) {
    const partial =
      r.loved > 0
        ? `（已拉到 loved ${r.loved}·命中 ${r.matched}·未命中 ${r.unmatched}）`
        : "";
    return `${when} · 失败：${r.reason}${partial}`;
  }
  const trunc = r.truncated ? " · 已截断" : "";
  return `${when} · loved ${r.loved} · 命中 ${r.matched} · 未命中 ${r.unmatched}${trunc}`;
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
  create(input: { name: string; type?: "normal" | "radio"; description?: string }): Promise<Playlist>;
  getSongs(
    playlistId: number,
    options?: { limit?: number; offset?: number }
  ): Promise<Song[]>;
  addSongs(playlistId: number, songIds: number[]): Promise<{ added: number; skipped: number }>;
  removeSongs(playlistId: number, songIds: number[]): Promise<void>;
  delete(id: number): Promise<void>;
};

async function findPlaylistByName(api: PlaylistsApi, name: string): Promise<Playlist | null> {
  const list = await api.list();
  const hit = (list || []).find((p) => p && p.name === name);
  return hit || null;
}

async function clearPlaylistSongs(api: PlaylistsApi, playlistId: number): Promise<number> {
  const songs = await api.getSongs(playlistId);
  const ids = (songs || []).map((s) => s.id).filter((id) => typeof id === "number");
  if (!ids.length) return 0;
  // remove in chunks to avoid oversized payloads
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
 * Cover-refresh playlist: clear+add keeping id when possible; recreate if clear fails fatally.
 * Empty matched set → empty playlist (allowed).
 */
export async function upsertLovedPlaylist(
  api: PlaylistsApi,
  songIds: number[],
  name: string = LOVED_PLAYLIST_NAME
): Promise<{ playlistId: number; created: boolean; playlistIdChanged: boolean }> {
  const existing = await findPlaylistByName(api, name);
  if (existing) {
    const playlistId = existing.id;
    try {
      await clearPlaylistSongs(api, playlistId);
      if (songIds.length) await addInChunks(api, playlistId, songIds);
      return { playlistId, created: false, playlistIdChanged: false };
    } catch (e) {
      // Fallback: delete + recreate (id changes)
      try {
        await api.delete(playlistId);
      } catch {
        /* continue to create */
      }
      const created = await api.create({
        name,
        type: "normal",
        description: "Synced from Last.fm loved tracks",
      });
      if (songIds.length) await addInChunks(api, created.id, songIds);
      return { playlistId: created.id, created: true, playlistIdChanged: true };
    }
  }
  const created = await api.create({
    name,
    type: "normal",
    description: "Synced from Last.fm loved tracks",
  });
  if (songIds.length) await addInChunks(api, created.id, songIds);
  return { playlistId: created.id, created: true, playlistIdChanged: false };
}

export interface SyncDeps {
  scrobbler: LastFmScrobbler;
  username: string;
  songsApi: { list(options?: { limit?: number; offset?: number }): Promise<Song[]> };
  playlistsApi: PlaylistsApi;
  hardCap?: number;
  now?: () => number;
}

/**
 * Full sync pipeline (callable from router). Independent of onlyMiot / scrobble / keep-alive.
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
    const upsert = await upsertLovedPlaylist(deps.playlistsApi, match.matchedIds);
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
