import { describe, expect, it, vi } from "vitest";
import { upsertLovedPlaylist, LOVED_PLAYLIST_NAME } from "../src/loved-playlist";
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
