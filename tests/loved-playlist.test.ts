import { describe, expect, it, vi } from "vitest";
import { upsertLovedPlaylist, syncLovedToPlaylist, LOVED_PLAYLIST_NAME, resolveLovedPlaylistName } from "../src/loved-playlist";
import type { PlaylistsApi } from "../src/loved-playlist";

function mockApi(initial: Array<{ id: number; name: string; songs: number[] }>): PlaylistsApi & {
  state: typeof initial;
} {
  const state = initial.map((p) => ({ ...p, songs: [...p.songs] }));
  let nextId = 100;
  const api: PlaylistsApi & { state: typeof state } = {
    state,
    async list() {
      return state.map((p) => ({
        id: p.id,
        type: "normal" as const,
        name: p.name,
        description: "",
        cover_url: "",
        labels: [],
        song_count: p.songs.length,
        created_at: "",
        updated_at: "",
        sort_by: "position",
        sort_order: "asc",
      }));
    },
    async create(input) {
      const id = nextId++;
      state.push({ id, name: input.name, songs: [] });
      return {
        id,
        type: "normal",
        name: input.name,
        description: input.description || "",
        cover_url: "",
        labels: [],
        song_count: 0,
        created_at: "",
        updated_at: "",
        sort_by: "position",
        sort_order: "asc",
      };
    },
    async getSongs(playlistId) {
      const p = state.find((x) => x.id === playlistId);
      return (p?.songs || []).map((id) => ({
        id,
        type: "local" as const,
        title: "",
        artist: "",
        album: "",
        year: 0,
        genre: "",
        duration: 0,
        file_path: "",
        url: "",
        cover_url: "",
        file_size: 0,
        format: "",
        bit_rate: 0,
        sample_rate: 0,
        is_live: false,
        is_video: false,
        added_at: "",
        updated_at: "",
      }));
    },
    async addSongs(playlistId, songIds) {
      const p = state.find((x) => x.id === playlistId);
      if (!p) throw new Error("missing");
      let added = 0;
      for (const id of songIds) {
        if (!p.songs.includes(id)) {
          p.songs.push(id);
          added++;
        }
      }
      return { added, skipped: songIds.length - added };
    },
    async removeSongs(playlistId, songIds) {
      const p = state.find((x) => x.id === playlistId);
      if (!p) throw new Error("missing");
      const drop = new Set(songIds);
      p.songs = p.songs.filter((id) => !drop.has(id));
    },
    async delete(id) {
      const i = state.findIndex((x) => x.id === id);
      if (i >= 0) state.splice(i, 1);
    },
  };
  return api;
}

describe("upsertLovedPlaylist", () => {
  it("creates playlist when missing (including empty song list)", async () => {
    const api = mockApi([]);
    const r = await upsertLovedPlaylist(api, []);
    expect(r.created).toBe(true);
    expect(r.playlistIdChanged).toBe(false);
    expect(api.state).toHaveLength(1);
    expect(api.state[0].name).toBe(LOVED_PLAYLIST_NAME);
    expect(api.state[0].songs).toEqual([]);
  });

  it("cover-refreshes existing: removes old, adds new, keeps id", async () => {
    const api = mockApi([{ id: 7, name: LOVED_PLAYLIST_NAME, songs: [1, 2, 3] }]);
    const r = await upsertLovedPlaylist(api, [3, 9]);
    expect(r.playlistId).toBe(7);
    expect(r.created).toBe(false);
    expect(r.playlistIdChanged).toBe(false);
    expect(api.state[0].songs).toEqual([3, 9]);
  });

  it("unlove effect: previously present ids disappear on refresh", async () => {
    const api = mockApi([{ id: 7, name: LOVED_PLAYLIST_NAME, songs: [1, 2] }]);
    await upsertLovedPlaylist(api, [2]);
    expect(api.state[0].songs).toEqual([2]);
  });
});

describe("syncLovedToPlaylist catch", () => {
  it("preserves partial counts on catch", async () => {
    const scrobbler = {
      getLovedTracks: async () => ({
        tracks: [
          { artist: "A", title: "T1" },
          { artist: "B", title: "T2" },
        ],
        truncated: false,
      }),
    };
    const songsApi = {
      list: async () => [{ id: 1, artist: "A", title: "T1" }],
    };
    const playlistsApi = {
      list: async () => {
        throw new Error("playlist boom");
      },
      create: async () => ({ id: 1 }),
      update: async () => ({}),
      addSongs: async () => ({}),
      removeSongs: async () => ({}),
    };
    const r = await syncLovedToPlaylist({
      scrobbler: scrobbler as any,
      username: "u",
      songsApi: songsApi as any,
      playlistsApi: playlistsApi as any,
      now: () => 123,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.loved).toBe(2);
    expect(r.matched).toBe(1);
    expect(r.unmatched).toBe(1);
    expect(r.reason).toMatch(/playlist boom/);
  });
});

describe("resolveLovedPlaylistName", () => {
  it("defaults when missing / empty / whitespace", () => {
    expect(resolveLovedPlaylistName(undefined)).toBe(LOVED_PLAYLIST_NAME);
    expect(resolveLovedPlaylistName(null)).toBe(LOVED_PLAYLIST_NAME);
    expect(resolveLovedPlaylistName("")).toBe(LOVED_PLAYLIST_NAME);
    expect(resolveLovedPlaylistName("   ")).toBe(LOVED_PLAYLIST_NAME);
    expect(resolveLovedPlaylistName("\t\n")).toBe(LOVED_PLAYLIST_NAME);
  });

  it("trims custom names", () => {
    expect(resolveLovedPlaylistName("  My Loved  ")).toBe("My Loved");
    expect(resolveLovedPlaylistName("红心收藏")).toBe("红心收藏");
  });
});

describe("upsertLovedPlaylist custom name", () => {
  it("creates / refreshes only the configured name; leaves old name alone", async () => {
    const api = mockApi([{ id: 7, name: LOVED_PLAYLIST_NAME, songs: [1, 2] }]);
    const r = await upsertLovedPlaylist(api, [9], "My Loved");
    expect(r.created).toBe(true);
    expect(api.state).toHaveLength(2);
    const old = api.state.find((p) => p.name === LOVED_PLAYLIST_NAME);
    const neu = api.state.find((p) => p.name === "My Loved");
    expect(old?.songs).toEqual([1, 2]);
    expect(neu?.songs).toEqual([9]);
  });

  it("cover-refreshes existing custom-named playlist", async () => {
    const api = mockApi([{ id: 3, name: "红心收藏", songs: [1] }]);
    const r = await upsertLovedPlaylist(api, [2, 3], "红心收藏");
    expect(r.playlistId).toBe(3);
    expect(r.created).toBe(false);
    expect(api.state[0].songs).toEqual([2, 3]);
  });
});

describe("syncLovedToPlaylist playlistName", () => {
  it("uses resolved playlistName and sets targetChanged", async () => {
    const scrobbler = {
      getLovedTracks: async () => ({
        tracks: [{ artist: "A", title: "T1" }],
        truncated: false,
      }),
    };
    const songsApi = {
      list: async () => [{ id: 1, artist: "A", title: "T1" }],
    };
    const api = mockApi([{ id: 7, name: LOVED_PLAYLIST_NAME, songs: [] }]);
    const r = await syncLovedToPlaylist({
      scrobbler: scrobbler as any,
      username: "u",
      songsApi: songsApi as any,
      playlistsApi: api,
      playlistName: "  ",
      previousPlaylistName: LOVED_PLAYLIST_NAME,
      now: () => 99,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.playlistName).toBe(LOVED_PLAYLIST_NAME);
    // previous === resolved → not changed
    expect(r.targetChanged).toBe(false);

    const r2 = await syncLovedToPlaylist({
      scrobbler: scrobbler as any,
      username: "u",
      songsApi: songsApi as any,
      playlistsApi: api,
      playlistName: "Alt Loved",
      previousPlaylistName: LOVED_PLAYLIST_NAME,
      now: () => 100,
    });
    expect(r2.ok).toBe(true);
    if (!r2.ok) return;
    expect(r2.playlistName).toBe("Alt Loved");
    expect(r2.targetChanged).toBe(true);
    expect(api.state.find((p) => p.name === "Alt Loved")?.songs).toEqual([1]);
    // old default playlist untouched by second sync's matching set write to new name
    expect(api.state.find((p) => p.name === LOVED_PLAYLIST_NAME)?.songs).toEqual([1]);
  });
});

