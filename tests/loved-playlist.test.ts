import { describe, expect, it, vi } from "vitest";
import {
  writeFavoritesPlaylist,
  upsertLovedPlaylist,
  syncLovedToPlaylist,
  findBuiltInFavorites,
  isBuiltInFavorites,
  isBuiltInRadioFavorites,
  mayDeleteAndRecreatePlaylist,
  LOVED_PLAYLIST_NAME,
  FAVORITES_PLAYLIST_NAME,
  resolveLovedPlaylistName,
  getReplaceSongs,
  listAllPlaylistSongs,
} from "../src/loved-playlist";
import type { PlaylistsApi } from "../src/loved-playlist";

type PlaylistRow = {
  id: number;
  name: string;
  songs: number[];
  type?: "normal" | "radio";
  labels?: string[];
};

function mockSong(id: number): Song {
  return {
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
  };
}

function mockApi(
  initial: PlaylistRow[],
  opts?: { pageSize?: number }
): PlaylistsApi & {
  state: PlaylistRow[];
  calls: { create: number; delete: number[]; replaceSongs: number[][]; removeSongs: number[][]; addSongs: number[][] };
} {
  const hostPageSize = opts?.pageSize ?? 2;
  const state = initial.map((p) => ({
    ...p,
    songs: [...p.songs],
    type: p.type ?? ("normal" as const),
    labels: [...(p.labels ?? [])],
  }));
  let nextId = 100;
  const calls = {
    create: 0,
    delete: [] as number[],
    replaceSongs: [] as number[][],
    removeSongs: [] as number[][],
    addSongs: [] as number[][],
  };
  const api: PlaylistsApi & { state: typeof state; calls: typeof calls } = {
    state,
    calls,
    async list() {
      return state.map((p) => ({
        id: p.id,
        type: p.type ?? "normal",
        name: p.name,
        description: "",
        cover_url: "",
        labels: [...(p.labels ?? [])],
        song_count: p.songs.length,
        created_at: "",
        updated_at: "",
        sort_by: "position",
        sort_order: "asc",
      }));
    },
    async create(input) {
      calls.create += 1;
      const id = nextId++;
      state.push({ id, name: input.name, songs: [], type: input.type ?? "normal", labels: [] });
      return {
        id,
        type: input.type ?? "normal",
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
    async getSongs(playlistId, options) {
      const p = state.find((x) => x.id === playlistId);
      const all = (p?.songs || []).map(mockSong);
      // Simulate a host that paginates by default if limit is omitted.
      const offset = typeof options?.offset === "number" && options.offset > 0 ? Math.floor(options.offset) : 0;
      const limit =
        typeof options?.limit === "number" && options.limit > 0 ? Math.floor(options.limit) : hostPageSize;
      return all.slice(offset, offset + limit);
    },
    async addSongs(playlistId, songIds) {
      calls.addSongs.push([playlistId, ...songIds]);
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
      calls.removeSongs.push([playlistId, ...songIds]);
      const p = state.find((x) => x.id === playlistId);
      if (!p) throw new Error("missing");
      const drop = new Set(songIds);
      p.songs = p.songs.filter((id) => !drop.has(id));
    },
    async delete(id) {
      calls.delete.push(id);
      const i = state.findIndex((x) => x.id === id);
      if (i >= 0) state.splice(i, 1);
    },
  };
  return api;
}

function favoritesFixtures(): PlaylistRow[] {
  return [
    { id: 1, name: FAVORITES_PLAYLIST_NAME, songs: [1, 2, 3], type: "normal", labels: ["built_in"] },
    { id: 2, name: "电台收藏", songs: [80, 81], type: "radio", labels: ["built_in"] },
    { id: 9, name: FAVORITES_PLAYLIST_NAME, songs: [70], type: "normal", labels: [] },
    { id: 10, name: "我喜欢的音乐", songs: [60], type: "normal", labels: [] },
    { id: 11, name: LOVED_PLAYLIST_NAME, songs: [50], type: "normal", labels: [] },
  ];
}

describe("isBuiltInFavorites", () => {
  it("matches built_in + type normal only, not by name and not radio", () => {
    expect(isBuiltInFavorites({ type: "normal", labels: ["built_in"] })).toBe(true);
    expect(isBuiltInFavorites({ type: "normal", labels: ["built_in", "other"] })).toBe(true);
    expect(isBuiltInFavorites({ type: "radio", labels: ["built_in"] })).toBe(false);
    expect(isBuiltInFavorites({ type: "normal", labels: [] })).toBe(false);
    expect(isBuiltInFavorites({ type: "normal", labels: ["auto_created"] })).toBe(false);
    expect(isBuiltInFavorites({ type: "normal" })).toBe(false);
    expect(isBuiltInFavorites(null)).toBe(false);
    expect(isBuiltInRadioFavorites({ type: "radio", labels: ["built_in"] })).toBe(true);
    expect(isBuiltInRadioFavorites({ type: "normal", labels: ["built_in"] })).toBe(false);
  });
});

describe("findBuiltInFavorites", () => {
  it("finds built_in normal playlist, not radio, not same-named ordinary playlist", async () => {
    const api = mockApi(favoritesFixtures());
    const hit = await findBuiltInFavorites(api);
    expect(hit?.id).toBe(1);
    expect(hit?.name).toBe(FAVORITES_PLAYLIST_NAME);
    expect(hit?.type).toBe("normal");
  });

  it("does not use lovedPlaylistName or the display name as the lookup key", async () => {
    const api = mockApi([
      { id: 2, name: "电台收藏", songs: [8], type: "radio", labels: ["built_in"] },
      { id: 4, name: "Favorites", songs: [1], type: "normal", labels: ["built_in"] },
      { id: 5, name: FAVORITES_PLAYLIST_NAME, songs: [9], type: "normal", labels: [] },
      { id: 6, name: "我喜欢的音乐", songs: [3], type: "normal", labels: [] },
    ]);
    const hit = await findBuiltInFavorites(api);
    expect(hit?.id).toBe(4);
    expect(hit?.name).toBe("Favorites");
  });

  it("returns null when only radio built-in exists", async () => {
    const api = mockApi([
      { id: 2, name: "电台收藏", songs: [8], type: "radio", labels: ["built_in"] },
      { id: 5, name: FAVORITES_PLAYLIST_NAME, songs: [9], type: "normal", labels: [] },
    ]);
    expect(await findBuiltInFavorites(api)).toBeNull();
  });
});

describe("writeFavoritesPlaylist", () => {
  it("uses replaceSongs when available and successful; never delete/create", async () => {
    const api = mockApi(favoritesFixtures());
    api.replaceSongs = async (playlistId, songIds) => {
      api.calls.replaceSongs.push([playlistId, ...songIds]);
      const p = api.state.find((x) => x.id === playlistId);
      if (!p) throw new Error("missing");
      p.songs = [...songIds];
    };
    const r = await writeFavoritesPlaylist(api, [3, 9], 1);
    expect(r.writeMethod).toBe("replaceSongs");
    expect(r.playlistId).toBe(1);
    expect(api.calls.replaceSongs).toEqual([[1, 3, 9]]);
    expect(api.calls.removeSongs).toEqual([]);
    expect(api.calls.addSongs).toEqual([]);
    expect(api.calls.delete).toEqual([]);
    expect(api.calls.create).toBe(0);
    expect(api.state.find((p) => p.id === 1)?.songs).toEqual([3, 9]);
    expect(api.state.find((p) => p.id === 2)?.songs).toEqual([80, 81]);
  });

  it("falls back to clear+add when replaceSongs throws; never delete/create", async () => {
    const api = mockApi(favoritesFixtures());
    api.replaceSongs = async () => {
      throw new Error("cannot replace built-in playlist");
    };
    const r = await writeFavoritesPlaylist(api, [3, 9], 1);
    expect(r.writeMethod).toBe("clearAdd");
    expect(r.playlistId).toBe(1);
    expect(api.calls.removeSongs.length).toBeGreaterThan(0);
    expect(api.calls.addSongs.length).toBeGreaterThan(0);
    expect(api.calls.delete).toEqual([]);
    expect(api.calls.create).toBe(0);
    expect(typeof api.delete).toBe("function");
    expect(api.state.find((p) => p.id === 1)?.songs).toEqual([3, 9]);
    expect(api.state.find((p) => p.id === 2)?.songs).toEqual([80, 81]);
  });

  it("falls back to clear+add when replaceSongs is missing; never delete/create", async () => {
    const api = mockApi(favoritesFixtures());
    expect(getReplaceSongs(api)).toBeNull();
    const r = await writeFavoritesPlaylist(api, [9], 1);
    expect(r.writeMethod).toBe("clearAdd");
    expect(api.calls.replaceSongs).toEqual([]);
    expect(api.calls.delete).toEqual([]);
    expect(api.calls.create).toBe(0);
    expect(api.state.find((p) => p.id === 1)?.songs).toEqual([9]);
  });

  it("empty matched set clears the favorites playlist when removals are allowed", async () => {
    const api = mockApi(favoritesFixtures());
    const r = await writeFavoritesPlaylist(api, [], 1);
    expect(r.writeMethod).toBe("clearAdd");
    expect(r.removalsSuppressed).toBe(false);
    expect(api.state.find((p) => p.id === 1)?.songs).toEqual([]);
    expect(api.calls.delete).toEqual([]);
    expect(api.calls.create).toBe(0);
  });

  it("skips removals when allowRemove is false", async () => {
    const api = mockApi(favoritesFixtures());
    const before = [...(api.state.find((p) => p.id === 1)?.songs ?? [])];
    const r = await writeFavoritesPlaylist(api, [], 1, { allowRemove: false });
    expect(r.removalsSuppressed).toBe(true);
    expect(api.state.find((p) => p.id === 1)?.songs).toEqual(before);
    expect(api.calls.removeSongs).toEqual([]);
  });

  it("paginates getSongs so leftovers on later pages are fully removed", async () => {
    const api = mockApi(
      [
        {
          id: 1,
          name: FAVORITES_PLAYLIST_NAME,
          songs: [1, 2, 3, 4, 5, 6, 7],
          type: "normal",
          labels: ["built_in"],
        },
      ],
      { pageSize: 2 }
    );
    const r = await writeFavoritesPlaylist(api, [7, 99], 1);
    expect(r.writeMethod).toBe("clearAdd");
    expect(api.state.find((p) => p.id === 1)?.songs).toEqual([7, 99]);
    expect(api.calls.delete).toEqual([]);
    expect(api.calls.create).toBe(0);
  });

  it("keeps previous favorites songs if add fails after write has started", async () => {
    const api = mockApi(favoritesFixtures());
    const original = [...(api.state.find((p) => p.id === 1)?.songs ?? [])];
    const addOrig = api.addSongs;
    api.addSongs = async (playlistId, songIds) => {
      await addOrig(playlistId, songIds);
      throw new Error("add failed after write");
    };
    await expect(writeFavoritesPlaylist(api, [3, 9], 1)).rejects.toThrow(/add failed after write/);
    const songs = api.state.find((p) => p.id === 1)?.songs ?? [];
    expect(songs).not.toEqual([]);
    expect(songs).toEqual(expect.arrayContaining(original));
    expect(api.calls.delete).toEqual([]);
    expect(api.calls.create).toBe(0);
    expect(api.calls.removeSongs).toEqual([]);
  });
});

describe("listAllPlaylistSongs", () => {
  it("walks multiple pages until a short page and collects every song", async () => {
    const api = mockApi([{ id: 7, name: "P", songs: [1, 2, 3, 4, 5] }], { pageSize: 2 });
    const songs = await listAllPlaylistSongs(api, 7, 2);
    expect(songs.map((s) => s.id)).toEqual([1, 2, 3, 4, 5]);
  });

  it("returns a single short page as-is", async () => {
    const api = mockApi([{ id: 7, name: "P", songs: [1, 2] }], { pageSize: 10 });
    const songs = await listAllPlaylistSongs(api, 7, 10);
    expect(songs.map((s) => s.id)).toEqual([1, 2]);
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

describe("syncLovedToPlaylist destination", () => {
  const scrobbler = {
    getLovedTracks: async () => ({
      tracks: [{ artist: "A", title: "T1" }],
      truncated: false,
    }),
  };
  const songsApi = {
    list: async () => [{ id: 1, artist: "A", title: "T1" }],
  };

  it("writes to built-in 收藏 and ignores lovedPlaylistName", async () => {
    const api = mockApi(favoritesFixtures());
    const r = await syncLovedToPlaylist({
      scrobbler: scrobbler as any,
      username: "u",
      songsApi: songsApi as any,
      playlistsApi: api,
      playlistName: "我喜欢的音乐",
      previousPlaylistName: LOVED_PLAYLIST_NAME,
      now: () => 99,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.playlistId).toBe(1);
    expect(r.playlistName).toBe(FAVORITES_PLAYLIST_NAME);
    expect(r.created).toBe(false);
    expect(r.playlistIdChanged).toBe(false);
    expect(r.targetChanged).toBe(false);
    expect(r.writeMethod).toBe("clearAdd");
    expect(api.state.find((p) => p.id === 1)?.songs).toEqual([1]);
    expect(api.state.find((p) => p.id === 10)?.songs).toEqual([60]);
    expect(api.state.find((p) => p.id === 11)?.songs).toEqual([50]);
    expect(api.state.find((p) => p.id === 2)?.songs).toEqual([80, 81]);
    expect(api.state.find((p) => p.id === 9)?.songs).toEqual([70]);
    expect(api.calls.delete).toEqual([]);
    expect(api.calls.create).toBe(0);
  });

  it("uses replaceSongs during sync when the host method succeeds", async () => {
    const api = mockApi(favoritesFixtures());
    api.replaceSongs = async (playlistId, songIds) => {
      api.calls.replaceSongs.push([playlistId, ...songIds]);
      const p = api.state.find((x) => x.id === playlistId);
      if (!p) throw new Error("missing");
      p.songs = [...songIds];
    };
    const r = await syncLovedToPlaylist({
      scrobbler: scrobbler as any,
      username: "u",
      songsApi: songsApi as any,
      playlistsApi: api,
      now: () => 100,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.writeMethod).toBe("replaceSongs");
    expect(api.calls.replaceSongs).toEqual([[1, 1]]);
    expect(api.calls.delete).toEqual([]);
    expect(api.calls.create).toBe(0);
    expect(api.state.find((p) => p.id === 1)?.songs).toEqual([1]);
    expect(api.state.find((p) => p.id === 2)?.songs).toEqual([80, 81]);
  });

  it("fails clearly when built-in 收藏 is missing and does not create a playlist", async () => {
    const api = mockApi([
      { id: 2, name: "电台收藏", songs: [80], type: "radio", labels: ["built_in"] },
      { id: 11, name: LOVED_PLAYLIST_NAME, songs: [50], type: "normal", labels: [] },
    ]);
    const r = await syncLovedToPlaylist({
      scrobbler: scrobbler as any,
      username: "u",
      songsApi: songsApi as any,
      playlistsApi: api,
      playlistName: "我喜欢的音乐",
      now: () => 101,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toContain("收藏");
    expect(r.loved).toBe(1);
    expect(r.matched).toBe(1);
    expect(api.calls.create).toBe(0);
    expect(api.calls.delete).toEqual([]);
    expect(api.state.find((p) => p.id === 2)?.songs).toEqual([80]);
    expect(api.state.find((p) => p.id === 11)?.songs).toEqual([50]);
  });

  it("does not write into 电台收藏", async () => {
    const api = mockApi(favoritesFixtures());
    await syncLovedToPlaylist({
      scrobbler: scrobbler as any,
      username: "u",
      songsApi: songsApi as any,
      playlistsApi: api,
      now: () => 102,
    });
    expect(api.state.find((p) => p.id === 2)?.songs).toEqual([80, 81]);
    expect(api.calls.replaceSongs.every((c) => c[0] !== 2)).toBe(true);
    expect(api.calls.addSongs.every((c) => c[0] !== 2)).toBe(true);
    expect(api.calls.removeSongs.every((c) => c[0] !== 2)).toBe(true);
  });
});

describe("mayDeleteAndRecreatePlaylist", () => {
  it("allows only ordinary normal playlists, not built-in or radio", () => {
    expect(mayDeleteAndRecreatePlaylist({ type: "normal", labels: [] })).toBe(true);
    expect(mayDeleteAndRecreatePlaylist({ type: "normal" })).toBe(true);
    expect(mayDeleteAndRecreatePlaylist({ type: "normal", labels: ["built_in"] })).toBe(false);
    expect(mayDeleteAndRecreatePlaylist({ type: "radio", labels: ["built_in"] })).toBe(false);
    expect(mayDeleteAndRecreatePlaylist({ type: "radio", labels: [] })).toBe(false);
    expect(mayDeleteAndRecreatePlaylist(null)).toBe(false);
  });
});

describe("upsertLovedPlaylist", () => {
  it("creates playlist when missing (including empty song list)", async () => {
    const api = mockApi([]);
    const r = await upsertLovedPlaylist(api, []);
    expect(r.created).toBe(true);
    expect(r.playlistIdChanged).toBe(false);
    expect(api.state).toHaveLength(1);
    expect(api.state[0].name).toBe(LOVED_PLAYLIST_NAME);
    expect(api.state[0].songs).toEqual([]);
    expect(api.state[0].type).toBe("normal");
  });

  it("cover-refreshes existing: removes old, adds new, keeps id", async () => {
    const api = mockApi([{ id: 7, name: LOVED_PLAYLIST_NAME, songs: [1, 2, 3] }]);
    const r = await upsertLovedPlaylist(api, [3, 9]);
    expect(r.playlistId).toBe(7);
    expect(r.created).toBe(false);
    expect(r.playlistIdChanged).toBe(false);
    expect(r.writeMethod).toBe("clearAdd");
    expect(api.state[0].songs).toEqual([3, 9]);
  });

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

  it("recreates a normal playlist when clear fails", async () => {
    const api = mockApi([{ id: 7, name: LOVED_PLAYLIST_NAME, songs: [1, 2] }]);
    api.removeSongs = async () => {
      throw new Error("clear failed");
    };
    const r = await upsertLovedPlaylist(api, [9]);
    expect(r.created).toBe(true);
    expect(r.playlistIdChanged).toBe(true);
    expect(r.writeMethod).toBe("recreate");
    expect(api.calls.delete).toEqual([7]);
    expect(api.calls.create).toBe(1);
    expect(api.state.find((p) => p.name === LOVED_PLAYLIST_NAME)?.songs).toEqual([9]);
    expect(api.state.find((p) => p.id === 7)).toBeUndefined();
  });

  it("never delete+rebuilds built-in 收藏 when name happens to match", async () => {
    const api = mockApi(favoritesFixtures());
    api.replaceSongs = async () => {
      throw new Error("cannot replace built-in playlist");
    };
    const r = await upsertLovedPlaylist(api, [9], FAVORITES_PLAYLIST_NAME);
    expect(r.playlistId).toBe(1);
    expect(r.created).toBe(false);
    expect(r.playlistIdChanged).toBe(false);
    expect(api.calls.delete).toEqual([]);
    expect(api.calls.create).toBe(0);
    expect(api.state.find((p) => p.id === 1)?.songs).toEqual([9]);
  });

  it("does not delete+rebuild built-in when clear fails", async () => {
    const api = mockApi(favoritesFixtures());
    api.replaceSongs = async () => {
      throw new Error("cannot replace built-in playlist");
    };
    api.removeSongs = async () => {
      throw new Error("clear failed");
    };
    await expect(upsertLovedPlaylist(api, [9], FAVORITES_PLAYLIST_NAME)).rejects.toThrow(/clear failed/);
    expect(api.calls.delete).toEqual([]);
    expect(api.calls.create).toBe(0);
    // Incremental path adds missing first; originals must still be present.
    expect(api.state.find((p) => p.id === 1)?.songs).toEqual([1, 2, 3, 9]);
  });

  it("does not empty or recreate a custom playlist when add fails", async () => {
    const api = mockApi([{ id: 7, name: LOVED_PLAYLIST_NAME, songs: [1, 2, 3] }]);
    const addOrig = api.addSongs;
    api.addSongs = async (playlistId, songIds) => {
      await addOrig(playlistId, songIds);
      throw new Error("add failed after write");
    };
    await expect(upsertLovedPlaylist(api, [3, 9])).rejects.toThrow(/add failed after write/);
    expect(api.calls.delete).toEqual([]);
    expect(api.calls.create).toBe(0);
    const songs = api.state.find((p) => p.id === 7)?.songs ?? [];
    expect(songs).not.toEqual([]);
    expect(songs).toEqual(expect.arrayContaining([1, 2, 3]));
  });
});

describe("syncLovedToPlaylist playlist target", () => {
  const scrobbler = {
    getLovedTracks: async () => ({
      tracks: [{ artist: "A", title: "T1" }],
      truncated: false,
    }),
  };
  const songsApi = {
    list: async () => [{ id: 1, artist: "A", title: "T1" }],
  };

  it("missing target still writes to built-in 收藏", async () => {
    const api = mockApi(favoritesFixtures());
    const r = await syncLovedToPlaylist({
      scrobbler: scrobbler as any,
      username: "u",
      songsApi: songsApi as any,
      playlistsApi: api,
      playlistName: "My Loved",
      now: () => 200,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.playlistId).toBe(1);
    expect(r.playlistName).toBe(FAVORITES_PLAYLIST_NAME);
    expect(api.calls.create).toBe(0);
    expect(api.state.find((p) => p.name === "My Loved")).toBeUndefined();
  });

  it("writes to a custom playlist by name and creates it when missing", async () => {
    const api = mockApi(favoritesFixtures());
    const r = await syncLovedToPlaylist({
      scrobbler: scrobbler as any,
      username: "u",
      songsApi: songsApi as any,
      playlistsApi: api,
      target: "playlist",
      playlistName: "  ",
      previousPlaylistName: LOVED_PLAYLIST_NAME,
      now: () => 201,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.playlistName).toBe(LOVED_PLAYLIST_NAME);
    expect(r.targetChanged).toBe(false);
    expect(api.state.find((p) => p.id === 11)?.songs).toEqual([1]);
    // favorites left alone
    expect(api.state.find((p) => p.id === 1)?.songs).toEqual([1, 2, 3]);

    const r2 = await syncLovedToPlaylist({
      scrobbler: scrobbler as any,
      username: "u",
      songsApi: songsApi as any,
      playlistsApi: api,
      target: "playlist",
      playlistName: "Alt Loved",
      previousPlaylistName: LOVED_PLAYLIST_NAME,
      now: () => 202,
    });
    expect(r2.ok).toBe(true);
    if (!r2.ok) return;
    expect(r2.playlistName).toBe("Alt Loved");
    expect(r2.targetChanged).toBe(true);
    expect(r2.created).toBe(true);
    expect(api.state.find((p) => p.name === "Alt Loved")?.songs).toEqual([1]);
    expect(api.state.find((p) => p.id === 11)?.songs).toEqual([1]);
    expect(api.state.find((p) => p.id === 1)?.songs).toEqual([1, 2, 3]);
  });

  it("cover-refreshes an existing custom-named playlist", async () => {
    const api = mockApi([{ id: 3, name: "红心收藏", songs: [8], type: "normal", labels: [] }]);
    const r = await syncLovedToPlaylist({
      scrobbler: scrobbler as any,
      username: "u",
      songsApi: songsApi as any,
      playlistsApi: api,
      target: "playlist",
      playlistName: "红心收藏",
      now: () => 203,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.playlistId).toBe(3);
    expect(r.created).toBe(false);
    expect(api.state[0].songs).toEqual([1]);
    expect(api.calls.delete).toEqual([]);
  });
});

describe("syncLovedToPlaylist empty/truncated protection", () => {
  const songsApi = {
    list: async () => [
      { id: 1, artist: "A", title: "T1" },
      { id: 2, artist: "B", title: "T2" },
    ],
  };

  it("does not empty favorites when Loved pull is empty", async () => {
    const api = mockApi(favoritesFixtures());
    const before = [...(api.state.find((p) => p.id === 1)?.songs ?? [])];
    const r = await syncLovedToPlaylist({
      scrobbler: { getLovedTracks: async () => ({ tracks: [], truncated: false }) } as any,
      username: "u",
      songsApi: songsApi as any,
      playlistsApi: api,
      now: () => 1,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.removalsSuppressed).toBe(true);
    expect(api.state.find((p) => p.id === 1)?.songs).toEqual(before);
    expect(api.calls.removeSongs).toEqual([]);
  });

  it("does not remove unmatched favorites when Loved is truncated@1000", async () => {
    const api = mockApi(favoritesFixtures());
    const before = [...(api.state.find((p) => p.id === 1)?.songs ?? [])];
    const r = await syncLovedToPlaylist({
      scrobbler: {
        getLovedTracks: async () => ({
          tracks: [{ artist: "A", title: "T1" }],
          truncated: true,
        }),
      } as any,
      username: "u",
      songsApi: songsApi as any,
      playlistsApi: api,
      now: () => 2,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.removalsSuppressed).toBe(true);
    expect(r.truncated).toBe(true);
    // May add matched id 1, but must not strip the rest
    const songs = api.state.find((p) => p.id === 1)?.songs ?? [];
    expect(songs).toEqual(expect.arrayContaining(before));
    expect(api.calls.removeSongs).toEqual([]);
  });
});
