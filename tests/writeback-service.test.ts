import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Playlist, Song } from "@songloft/plugin-sdk";
import { WritebackService, classifyEventSong } from "../src/writeback-run";
import type { PlaylistSongsChangeEvent } from "../src/writeback";
import type { WritebackSnapshot } from "../src/writeback-merge";

function song(id: number, artist: string, title: string, type: "local" | "remote" | "radio" = "local"): Song {
  return {
    id,
    type,
    title,
    artist,
    album: "",
    year: 0,
    genre: "",
    duration: 200,
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

interface Harness {
  service: WritebackService;
  playlistSongs: number[];
  favoritesId: number;
  calls: Array<{ kind: "love" | "unlove"; artist: string; title: string }>;
  saveSnapshot: ReturnType<typeof vi.fn>;
  handler: ((e: PlaylistSongsChangeEvent) => void | Promise<void>) | null;
  emit: (e: PlaylistSongsChangeEvent) => Promise<void>;
  events: unknown;
}

function harness(opts?: {
  favorites?: number[];
  favoritesId?: number;
  library?: Song[];
  initialSnapshot?: WritebackSnapshot | null;
  withEvents?: boolean;
  failWrites?: number;
  /** 模拟内置「收藏」不存在（重建中 / 首次建库前）。 */
  noFavorites?: boolean;
  /** 模拟宿主忽略 offset：getSongs 永远返回满页 → 收藏分页不完整（complete=false）。 */
  incompleteListing?: boolean;
}): Harness {
  const favoritesId = opts?.favoritesId ?? 42;
  const library = opts?.library ?? [song(1, "A", "One"), song(2, "B", "Two"), song(3, "C", "Three")];
  const playlistSongs = [...(opts?.favorites ?? [])];
  const calls: Harness["calls"] = [];
  const saveSnapshot = vi.fn(async () => {});
  let snapshot = opts?.initialSnapshot ?? null;
  let handler: Harness["handler"] = null;
  const events = opts?.withEvents
    ? {
        onPlaylistSongsChange: async (fn: (e: PlaylistSongsChangeEvent) => void | Promise<void>) => {
          handler = fn;
        },
        offPlaylistSongsChange: async () => {
          handler = null;
        },
      }
    : {};
  let failuresLeft = opts?.failWrites ?? 0;

  const playlists = {
    async list(): Promise<Playlist[]> {
      if (opts?.noFavorites) return [];
      return [
        {
          id: favoritesId,
          type: "normal",
          name: "收藏",
          description: "",
          cover_url: "",
          labels: ["built_in"],
          song_count: playlistSongs.length,
          created_at: "",
          updated_at: "",
          sort_by: "position",
          sort_order: "asc",
        },
      ];
    },
    async getSongs(playlistId: number): Promise<Song[]> {
      if (playlistId !== favoritesId) return [];
      if (opts?.incompleteListing) {
        // 宿主忽略 offset：每次都返回满页（500）→ listAllPlaylistSongsDetailed 判 complete=false。
        const page = playlistSongs.map((id) => library.find((x) => x.id === id) ?? song(id, "", ""));
        while (page.length < 500) page.push(song(page[0]?.id ?? 1, "", ""));
        return page;
      }
      return playlistSongs.map((id) => {
        const s = library.find((x) => x.id === id);
        return s ?? song(id, "", "");
      });
    },
    async addSongs(_playlistId: number, ids: number[]) {
      // 真实宿主：曲库里不存在的 songId 直接报 song not found，整轮失败。
      for (const id of ids) {
        if (!library.some((s) => s.id === id)) throw new Error(`song not found: ${id}`);
      }
      for (const id of ids) if (!playlistSongs.includes(id)) playlistSongs.push(id);
      return { added: ids.length, skipped: 0 };
    },
    async removeSongs(_playlistId: number, ids: number[]) {
      for (const id of ids) {
        const i = playlistSongs.indexOf(id);
        if (i >= 0) playlistSongs.splice(i, 1);
      }
    },
  };

  const service = new WritebackService({
    events,
    playlists: playlists as never,
    library: {
      list: async () => library,
      getById: async (id: number) => library.find((s) => s.id === id) ?? null,
    },
    store: {
      load: async () => snapshot,
      save: async (s: WritebackSnapshot) => {
        snapshot = s;
        saveSnapshot(s);
      },
    },
    getWriteApi: async () => ({
      love: async (artist: string, title: string) => {
        if (failuresLeft > 0) {
          failuresLeft -= 1;
          throw new Error("Last.FM error 29: Rate limit exceeded");
        }
        calls.push({ kind: "love", artist, title });
      },
      unlove: async (artist: string, title: string) => {
        calls.push({ kind: "unlove", artist, title });
      },
    }),
    withLock: async (fn) => ({ skipped: false as const, result: await fn() }),
    sleep: async () => {},
    maxAttempts: 2,
    baseDelayMs: 1,
    echoDrainMs: 0,
  });

  return {
    service,
    playlistSongs,
    favoritesId,
    calls,
    saveSnapshot: saveSnapshot as never,
    get handler() {
      return handler;
    },
    emit: async (e) => {
      await service.handleEvent(e);
    },
    events,
  } as Harness;
}

function event(
  songId: number,
  type: "add" | "remove",
  opts?: { playlistId?: number; artist?: string; title?: string; favoritesId?: number }
): PlaylistSongsChangeEvent {
  return {
    playlistId: opts?.playlistId ?? opts?.favoritesId ?? 42,
    songId,
    type,
    timestamp: 1_700_000_000_000,
    song: { id: songId, title: opts?.title ?? "T" + songId, artist: opts?.artist ?? "A" + songId },
  };
}

describe("classifyEventSong", () => {
  it("rejects radio and unknown types, allows local/remote", async () => {
    const lib = {
      getById: async (id: number) =>
        id === 5 ? song(5, "R", "Radio", "radio") : id === 6 ? song(6, "L", "Local") : null,
    };
    expect((await classifyEventSong(lib as never, event(5, "add"))).verdict).toBe("reject_radio");
    expect((await classifyEventSong(lib as never, event(6, "add"))).verdict).toBe("allow");
    expect((await classifyEventSong(lib as never, event(9, "add"))).verdict).toBe("allow");
    const unknown = await classifyEventSong(lib as never, {
      ...event(9, "add"),
      song: { id: 9, title: "", artist: "" },
    });
    expect(unknown.verdict).toBe("reject_unknown");
  });
});

const emptyBaseline = (): WritebackSnapshot => ({
  ts: 1,
  lovedKeys: [],
  favoriteIds: [],
  songKeys: {},
});

describe("WritebackService event handling", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("loves on add and unloves on remove for built-in favorites (not hardcoded id=1)", async () => {
    const h = harness({ favoritesId: 42, initialSnapshot: emptyBaseline() });
    await h.emit(event(1, "add", { playlistId: 42, artist: "A", title: "One" }));
    await h.service.drainQueue();
    await h.emit(event(2, "remove", { playlistId: 42, artist: "B", title: "Two" }));
    await h.service.drainQueue();
    await h.emit(event(3, "add", { playlistId: 99, artist: "C", title: "Three" }));
    await h.service.drainQueue();
    expect(h.calls).toEqual([
      { kind: "love", artist: "A", title: "One" },
      { kind: "unlove", artist: "B", title: "Two" },
    ]);
  });

  it("ignores non-favorites playlists entirely", async () => {
    const h = harness({ favoritesId: 42, initialSnapshot: emptyBaseline() });
    await h.emit(event(1, "add", { playlistId: 2 }));
    expect(h.calls).toEqual([]);
  });

  it("skips unlove when another song with the same key remains", async () => {
    const library = [song(11, "A", "One"), song(12, "a", "ONE")];
    const h = harness({
      favoritesId: 7,
      favorites: [11, 12],
      library,
      initialSnapshot: emptyBaseline(),
    });
    // remove 11 but 12 remains → no unlove
    h.playlistSongs.splice(0, h.playlistSongs.length, 12);
    await h.emit(event(11, "remove", { playlistId: 7, artist: "A", title: "One" }));
    await h.service.drainQueue();
    expect(h.calls).toEqual([]);
  });

  it("suppresses the plugin's own favorites writes", async () => {
    const h = harness({ favoritesId: 42, initialSnapshot: emptyBaseline() });
    h.service.registerFavoritesWrite(42, [1], [2]);
    await h.emit(event(1, "add", { playlistId: 42 }));
    await h.emit(event(2, "remove", { playlistId: 42 }));
    expect(h.calls).toEqual([]);
    await h.emit(event(1, "add", { playlistId: 42, artist: "A", title: "One" }));
    await h.service.drainQueue();
    expect(h.calls).toEqual([{ kind: "love", artist: "A", title: "One" }]);
  });

  it("uses writeFavoritesDiff to add-then-remove and registers the echo", async () => {
    const h = harness({ favorites: [1, 2], favoritesId: 42, initialSnapshot: emptyBaseline() });
    const diff = await h.service.writeFavoritesDiff({ toAdd: [3], toRemove: [1] }, 42);
    expect(diff).toMatchObject({
      toAdd: [3],
      toRemove: [1],
      removalsSuppressed: false,
      complete: true,
      addsSkipped: false,
    });
    expect(diff.currentIds.sort()).toEqual([1, 2]);
    expect(h.playlistSongs).toEqual([2, 3]);
    await h.emit(event(3, "add", { playlistId: 42 }));
    await h.emit(event(1, "remove", { playlistId: 42 }));
    expect(h.calls).toEqual([]);
  });

  it("skips removals when allowRemove is false", async () => {
    const h = harness({ favorites: [1, 2], favoritesId: 42, initialSnapshot: emptyBaseline() });
    const diff = await h.service.writeFavoritesDiff(
      { toAdd: [3], toRemove: [1] },
      42,
      { allowRemove: false }
    );
    expect(diff).toMatchObject({
      toAdd: [3],
      toRemove: [],
      removalsSuppressed: true,
      complete: true,
      addsSkipped: false,
    });
    expect(h.playlistSongs).toEqual([1, 2, 3]);
  });

  it("skips all toAdd when favorites listing is incomplete (P2-新 2)", async () => {
    const h = harness({
      favorites: [1, 2],
      favoritesId: 42,
      initialSnapshot: emptyBaseline(),
      incompleteListing: true,
    });
    const diff = await h.service.writeFavoritesDiff({ toAdd: [3], toRemove: [1] }, 42);
    expect(diff.toAdd).toEqual([]);
    expect(diff.toRemove).toEqual([]);
    expect(diff.complete).toBe(false);
    expect(diff.addsSkipped).toBe(true);
    expect(diff.removalsSuppressed).toBe(true);
    expect(h.playlistSongs).toEqual([1, 2]);
  });

  it("keeps echo roundKeys after drain so late host events are still suppressed", async () => {
    const h = harness({ favorites: [1], favoritesId: 42, initialSnapshot: emptyBaseline() });
    await h.service.writeFavoritesDiff({ toAdd: [2], toRemove: [] }, 42);
    expect(h.service.suppressor.roundSize()).toBeGreaterThan(0);
    // 模拟宿主事件晚于 TTL：roundKeys 仍应吸收
    await h.emit(event(2, "add", { playlistId: 42, artist: "B", title: "Two" }));
    await h.service.drainQueue();
    expect(h.calls).toEqual([]);
  });

  it("subscribes when the host exposes the API and returns false otherwise", async () => {
    const withApi = harness({ withEvents: true, initialSnapshot: emptyBaseline() });
    expect(await withApi.service.attachEvents()).toBe(true);
    expect(typeof withApi.handler).toBe("function");

    const logs: string[] = [];
    const service = new WritebackService({
      events: {},
      playlists: {
        list: async () => [],
        getSongs: async () => [],
        addSongs: async () => ({ added: 0, skipped: 0 }),
        removeSongs: async () => {},
      } as never,
      library: { list: async () => [], getById: async () => null },
      store: { load: async () => null, save: async () => {} },
      getWriteApi: async () => null,
      withLock: async (fn) => ({ skipped: false as const, result: await fn() }),
      log: (_level, message) => logs.push(message),
    });
    expect(await service.attachEvents()).toBe(false);
    expect(logs.join(" ")).toContain("请升级 Songloft");
  });

  it("noteManualLove does not mutate baseline or favorites", async () => {
    const baseline = { ts: 1, lovedKeys: [] as string[], favoriteIds: [1], songKeys: {} };
    const h = harness({
      favorites: [1],
      initialSnapshot: baseline,
    });
    const noted = await h.service.noteManualLove({ kind: "love", artist: "A", title: "One" });
    expect(noted.snapshotUpdated).toBe(false);
    expect(h.saveSnapshot).not.toHaveBeenCalled();
    expect(h.playlistSongs).toEqual([1]);
    expect(h.calls).toEqual([]);
  });

  it("does not enqueue or fabricate snapshot when baseline is missing", async () => {
    const h = harness({ favoritesId: 42, initialSnapshot: null });
    await h.emit(event(1, "add", { playlistId: 42, artist: "A", title: "One" }));
    await h.service.drainQueue();
    expect(h.calls).toEqual([]);
    expect(h.saveSnapshot).not.toHaveBeenCalled();
    expect(h.service.queueSize()).toBe(0);
  });
});

describe("WritebackService first snapshot", () => {
  it("records current state without loving history or unloving Last.fm-only tracks", async () => {
    const h = harness({ favorites: [1] });
    const built = await h.service.buildSnapshot({
      loved: [
        { artist: "A", title: "One" },
        { artist: "B", title: "Two" },
        { artist: "Nope", title: "Missing" },
      ],
      truncated: false,
      now: 5,
    });
    expect(built.snapshot.favoriteIds).toEqual([1]);
    expect(built.snapshot.lovedKeys).toEqual(["at:a\u0000one", "at:b\u0000two", "at:nope\u0000missing"]);
    expect(built.matched).toBe(2);
    expect(built.unmatched).toBe(1);
    expect(h.saveSnapshot).toHaveBeenCalledTimes(1);
    expect(h.calls).toEqual([]);
  });

  it("fails without saving when favorites listing is incomplete", async () => {
    const favoritesId = 42;
    const library = [song(1, "A", "One")];
    const playlistSongs = [1];
    const saveSnapshot = vi.fn(async () => {});
    let snapshot: WritebackSnapshot | null = null;
    const playlists = {
      async list(): Promise<Playlist[]> {
        return [
          {
            id: favoritesId,
            type: "normal",
            name: "收藏",
            description: "",
            cover_url: "",
            labels: ["built_in"],
            song_count: 1,
            created_at: "",
            updated_at: "",
            sort_by: "position",
            sort_order: "asc",
          },
        ];
      },
      // 忽略 offset 且每次都返回满页 → complete=false
      async getSongs(_playlistId: number, opts?: { limit?: number; offset?: number }): Promise<Song[]> {
        const limit = opts?.limit ?? 500;
        return Array.from({ length: limit }, (_, i) => library[i % library.length] ?? song(1, "A", "One"));
      },
      async addSongs() {
        return { added: 0, skipped: 0 };
      },
      async removeSongs() {},
    };
    void playlistSongs;
    const service = new WritebackService({
      playlists: playlists as never,
      library: {
        list: async () => library,
        getById: async (id: number) => library.find((s) => s.id === id) ?? null,
      },
      store: {
        load: async () => snapshot,
        save: async (s) => {
          snapshot = s;
          saveSnapshot(s);
        },
      },
      getWriteApi: async () => null,
      withLock: async (fn) => ({ skipped: false as const, result: await fn() }),
    });
    await expect(
      service.buildSnapshot({ loved: [{ artist: "A", title: "One" }], truncated: false })
    ).rejects.toThrow(/收藏列表不完整/);
    expect(saveSnapshot).not.toHaveBeenCalled();
    expect(snapshot).toBeNull();
  });
});

describe("WritebackService reconcile without catch-up", () => {
  it("after missing baseline, favorite changes then merge only records snapshot", async () => {
    // 记起点失败（无 snapshot）→ 收藏变更被跳过 → 再 reconcile 只记起点，不对既有 Loved/收藏追平
    const h = harness({
      favorites: [1],
      favoritesId: 42,
      initialSnapshot: null,
      library: [song(1, "A", "One"), song(2, "B", "Two"), song(3, "C", "Three")],
    });
    await h.emit(event(2, "add", { playlistId: 42, artist: "B", title: "Two" }));
    await h.service.drainQueue();
    expect(h.calls).toEqual([]);
    expect(h.saveSnapshot).not.toHaveBeenCalled();

    const loved = [
      { artist: "A", title: "One" },
      { artist: "B", title: "Two" },
    ];
    const result = await h.service.reconcileFavorites({
      scrobbler: {
        getLovedTracks: async () => ({ tracks: loved, truncated: false }),
      },
      username: "u",
      hardCap: 1000,
      now: 99,
    });
    expect(result.ok).toBe(true);
    expect(result.initializedSnapshot).toBe(true);
    expect(result.lovedCount).toBe(0);
    expect(result.unlovedCount).toBe(0);
    expect(result.added).toBe(0);
    expect(result.removed).toBe(0);
    expect(h.calls).toEqual([]);
    expect(result.snapshot?.favoriteIds).toEqual([1]);
    expect(result.snapshot?.lovedKeys).toEqual(["at:a\u0000one", "at:b\u0000two"]);
  });

  it("second reconcile after baseline does merge new LFM loves into favorites", async () => {
    const h = harness({
      favorites: [1],
      favoritesId: 42,
      initialSnapshot: {
        ts: 1,
        lovedKeys: ["at:a\u0000one"],
        favoriteIds: [1],
        songKeys: { "1": "at:a\u0000one" },
      },
      library: [song(1, "A", "One"), song(2, "B", "Two")],
    });
    const result = await h.service.reconcileFavorites({
      scrobbler: {
        getLovedTracks: async () => ({
          tracks: [
            { artist: "A", title: "One" },
            { artist: "B", title: "Two" },
          ],
          truncated: false,
        }),
      },
      username: "u",
      hardCap: 1000,
      now: 100,
    });
    expect(result.ok).toBe(true);
    expect(result.initializedSnapshot).toBe(false);
    expect(result.added).toBe(1);
    expect(h.playlistSongs).toContain(2);
  });

  it("does not write back a favorite the user deleted during a truncated round (P1-1)", async () => {
    // 起点收藏 [1,2]；用户已把 2 移出收藏（当前 [1]）；Loved 截断且新增 Three。
    const h = harness({
      favorites: [1],
      favoritesId: 42,
      initialSnapshot: {
        ts: 1,
        lovedKeys: ["at:a\u0000one", "at:b\u0000two"],
        favoriteIds: [1, 2],
        songKeys: { "1": "at:a\u0000one", "2": "at:b\u0000two" },
      },
    });
    const result = await h.service.reconcileFavorites({
      scrobbler: {
        getLovedTracks: async () => ({
          tracks: [
            { artist: "A", title: "One" },
            { artist: "C", title: "Three" },
          ],
          truncated: true,
        }),
      },
      username: "u",
      hardCap: 1000,
      now: 100,
    });
    expect(result.ok).toBe(true);
    // 只正向补上 3；被用户删掉的 2 绝不能回到「收藏」。
    expect(h.playlistSongs).toEqual([1, 3]);
    expect(h.playlistSongs).not.toContain(2);
    expect(result.added).toBe(1);
    expect(result.removed).toBe(0);
    expect(result.removalsSuppressed).toBe(true);
  });

  it("does not write back a deleted favorite when the Loved pull is empty (P1-1)", async () => {
    const h = harness({
      favorites: [1],
      favoritesId: 42,
      initialSnapshot: {
        ts: 1,
        lovedKeys: ["at:a\u0000one", "at:b\u0000two"],
        favoriteIds: [1, 2],
        songKeys: { "1": "at:a\u0000one", "2": "at:b\u0000two" },
      },
    });
    const result = await h.service.reconcileFavorites({
      scrobbler: { getLovedTracks: async () => ({ tracks: [], truncated: false }) },
      username: "u",
      hardCap: 1000,
      now: 100,
    });
    expect(result.ok).toBe(true);
    expect(h.playlistSongs).toEqual([1]);
  });

  it("does not write back a deleted favorite when the favorites listing is incomplete (P1-1)", async () => {
    // 收藏分页不完整（宿主忽略 offset）+ 有一条新的 Last.fm 喜欢：不得回滚用户删除。
    // 不完整时也跳过 toAdd（P2-新 2 保守策略），且不得把跳过的 id 推进起点。
    const h = harness({
      favorites: [1],
      favoritesId: 42,
      incompleteListing: true,
      initialSnapshot: {
        ts: 1,
        lovedKeys: ["at:a\u0000one", "at:b\u0000two"],
        favoriteIds: [1, 2],
        songKeys: { "1": "at:a\u0000one", "2": "at:b\u0000two" },
      },
    });
    const result = await h.service.reconcileFavorites({
      scrobbler: {
        getLovedTracks: async () => ({
          tracks: [
            { artist: "A", title: "One" },
            { artist: "C", title: "Three" },
          ],
          truncated: false,
        }),
      },
      username: "u",
      hardCap: 1000,
      now: 100,
    });
    expect(result.ok).toBe(true);
    expect(h.playlistSongs).toEqual([1]);
    expect(h.playlistSongs).not.toContain(2);
    expect(result.added).toBe(0);
    expect(result.removalsSuppressed).toBe(true);
    expect(result.snapshot?.favoriteIds).not.toContain(3);
    expect(result.snapshot?.favoriteIds).toContain(2); // unsafe 簿记保留，下轮可继续抑制回滚
  });

  it("keeps writing new loves when a stale baseline id can only be deferred (P1-2)", async () => {
    // 起点残留 99（曲库已无此曲），且本轮 Loved 截断 → 99 只会进 deferred。
    // 旧实现会把 deferred 的 99 并进写入集合，宿主 addSongs 报 song not found，整轮失败。
    const h = harness({
      favorites: [1],
      favoritesId: 42,
      initialSnapshot: {
        ts: 1,
        lovedKeys: ["at:a\u0000one", "at:gone\u0000away"],
        favoriteIds: [1, 99],
        songKeys: { "1": "at:a\u0000one", "99": "at:gone\u0000away" },
      },
      library: [song(1, "A", "One"), song(2, "B", "Two")],
    });
    const result = await h.service.reconcileFavorites({
      scrobbler: {
        getLovedTracks: async () => ({
          tracks: [
            { artist: "A", title: "One" },
            { artist: "B", title: "Two" },
          ],
          truncated: true,
        }),
      },
      username: "u",
      hardCap: 1000,
      now: 100,
    });
    expect(result.ok).toBe(true);
    expect(h.playlistSongs).toEqual([1, 2]);
    // 起点簿记里也要淘汰 99，否则后续每轮都会重试。
    expect(result.snapshot?.favoriteIds.sort()).toEqual([1, 2]);
  });

  it("keeps writing new loves after a baseline id is missing from the library (P1-2)", async () => {
    // 起点残留 99：曲库已无此曲，也没有 songKeys 映射 → 只能进 deferred。
    const h = harness({
      favorites: [1],
      favoritesId: 42,
      initialSnapshot: {
        ts: 1,
        lovedKeys: ["at:a\u0000one"],
        favoriteIds: [1, 99],
        songKeys: { "1": "at:a\u0000one" },
      },
      library: [song(1, "A", "One"), song(2, "B", "Two")],
    });
    const result = await h.service.reconcileFavorites({
      scrobbler: {
        getLovedTracks: async () => ({
          tracks: [
            { artist: "A", title: "One" },
            { artist: "B", title: "Two" },
          ],
          truncated: false,
        }),
      },
      username: "u",
      hardCap: 1000,
      now: 100,
    });
    expect(result.ok).toBe(true);
    expect(h.playlistSongs).toEqual([1, 2]);
    // 起点簿记里也要淘汰 99，否则后续每轮都会重试。
    expect(result.snapshot?.favoriteIds.sort()).toEqual([1, 2]);
  });

  it("fails without saving when the built-in favorites playlist is missing (P2-2)", async () => {
    const h = harness({ noFavorites: true });
    await expect(
      h.service.buildSnapshot({ loved: [{ artist: "A", title: "One" }], truncated: false })
    ).rejects.toThrow(/未找到内置「收藏」/);
    expect(h.saveSnapshot).not.toHaveBeenCalled();
    expect(h.service.runtimeStatus().queueSize).toBe(0);
  });

  it("reports an incomplete baseline in the reconcile reason (P2-1)", async () => {
    const h = harness({
      favorites: [1],
      favoritesId: 42,
      initialSnapshot: {
        ts: 1,
        truncated: true,
        lovedKeys: ["at:a\u0000one"],
        favoriteIds: [1],
        songKeys: { "1": "at:a\u0000one" },
      },
      library: [song(1, "A", "One"), song(2, "B", "Two")],
    });
    const result = await h.service.reconcileFavorites({
      scrobbler: {
        getLovedTracks: async () => ({
          tracks: [
            { artist: "A", title: "One" },
            { artist: "B", title: "Two" },
          ],
          truncated: false,
        }),
      },
      username: "u",
      hardCap: 1000,
      now: 100,
    });
    expect(result.ok).toBe(true);
    expect(result.baselineIncomplete).toBe(true);
    expect(result.reason).toContain("起点不完整");
  });

  it("does not delete unread favorites when outer listing is incomplete but inner is complete (P1-A)", async () => {
    // 外层分页异常（第 2 页重复 → complete=false，只见前 500）+ 内层正常读全 + 新增一条喜欢。
    // 旧实现会把 501..601 全部删掉，同时还报 removalsSuppressed=true。
    const favoritesId = 42;
    const total = 601;
    const library = Array.from({ length: total + 1 }, (_, i) => {
      const id = i + 1;
      return song(id, `A${id}`, `T${id}`);
    });
    const playlistSongs = Array.from({ length: total }, (_, i) => i + 1);
    const favoriteIds = [...playlistSongs];
    const lovedKeys = favoriteIds.map((id) => `at:a${id}\u0000t${id}`);
    const songKeys: Record<string, string> = {};
    for (const id of favoriteIds) songKeys[String(id)] = `at:a${id}\u0000t${id}`;

    let listingRound = 0;
    const removeCalls: number[][] = [];
    let snapshot: WritebackSnapshot = {
      ts: 1,
      lovedKeys,
      favoriteIds,
      songKeys,
    };
    const playlists = {
      async list(): Promise<Playlist[]> {
        return [
          {
            id: favoritesId,
            type: "normal",
            name: "收藏",
            description: "",
            cover_url: "",
            labels: ["built_in"],
            song_count: playlistSongs.length,
            created_at: "",
            updated_at: "",
            sort_by: "position",
            sort_order: "asc",
          },
        ];
      },
      async getSongs(
        _playlistId: number,
        opts?: { limit?: number; offset?: number }
      ): Promise<Song[]> {
        const limit = opts?.limit ?? 500;
        const offset = opts?.offset ?? 0;
        if (offset === 0) listingRound += 1;
        if (listingRound === 1) {
          // 外层：忽略 offset，永远返回前 500 → complete=false
          return playlistSongs.slice(0, 500).map((id) => library.find((s) => s.id === id)!);
        }
        // 内层：正常分页
        return playlistSongs
          .slice(offset, offset + limit)
          .map((id) => library.find((s) => s.id === id)!);
      },
      async addSongs(_playlistId: number, ids: number[]) {
        for (const id of ids) {
          if (!library.some((s) => s.id === id)) throw new Error(`song not found: ${id}`);
          if (!playlistSongs.includes(id)) playlistSongs.push(id);
        }
        return { added: ids.length, skipped: 0 };
      },
      async removeSongs(_playlistId: number, ids: number[]) {
        removeCalls.push([...ids]);
        for (const id of ids) {
          const i = playlistSongs.indexOf(id);
          if (i >= 0) playlistSongs.splice(i, 1);
        }
      },
    };
    const service = new WritebackService({
      playlists: playlists as never,
      library: {
        // 必须按 offset/limit 分页：曲库 >500 时整表返回会让 listAllLibrarySongs 死循环 OOM。
        list: async (opts?: { limit?: number; offset?: number }) => {
          const limit = opts?.limit ?? 500;
          const offset = opts?.offset ?? 0;
          return library.slice(offset, offset + limit);
        },
        getById: async (id: number) => library.find((s) => s.id === id) ?? null,
      },
      store: {
        load: async () => snapshot,
        save: async (s) => {
          snapshot = s;
        },
      },
      getWriteApi: async () => ({
        love: async () => {},
        unlove: async () => {},
      }),
      withLock: async (fn) => ({ skipped: false as const, result: await fn() }),
      sleep: async () => {},
      echoDrainMs: 0,
    });

    const newId = total + 1;
    const lovedTracks = [
      ...favoriteIds.map((id) => ({ artist: `A${id}`, title: `T${id}` })),
      { artist: `A${newId}`, title: `T${newId}` },
    ];
    const beforeLen = playlistSongs.length;
    const result = await service.reconcileFavorites({
      scrobbler: { getLovedTracks: async () => ({ tracks: lovedTracks, truncated: false }) },
      username: "u",
      hardCap: 1000,
      now: 100,
    });

    expect(result.ok).toBe(true);
    expect(result.removalsSuppressed).toBe(true);
    expect(result.removed).toBe(0);
    expect(removeCalls).toEqual([]);
    expect(playlistSongs.length).toBeGreaterThanOrEqual(beforeLen);
    expect(playlistSongs).toContain(newId);
    // 501 及之后必须仍在收藏
    for (let id = 501; id <= total; id++) {
      expect(playlistSongs).toContain(id);
    }
  });

  it("does not overwrite a user add that lands between outer and inner favorites reads (P1-B)", async () => {
    // 外层读完 [1,2] 后、内层读之前，用户把 7 加进收藏；写回不得用旧快照把 7 删掉。
    const favoritesId = 42;
    const library = [
      song(1, "A", "One"),
      song(2, "B", "Two"),
      song(3, "C", "Three"),
      song(7, "G", "Seven"),
    ];
    const playlistSongs = [1, 2];
    let listingRound = 0;
    const removeCalls: number[][] = [];
    let snapshot: WritebackSnapshot = {
      ts: 1,
      lovedKeys: ["at:a\u0000one", "at:b\u0000two"],
      favoriteIds: [1, 2],
      songKeys: { "1": "at:a\u0000one", "2": "at:b\u0000two" },
    };
    const playlists = {
      async list(): Promise<Playlist[]> {
        return [
          {
            id: favoritesId,
            type: "normal",
            name: "收藏",
            description: "",
            cover_url: "",
            labels: ["built_in"],
            song_count: playlistSongs.length,
            created_at: "",
            updated_at: "",
            sort_by: "position",
            sort_order: "asc",
          },
        ];
      },
      async getSongs(
        _playlistId: number,
        opts?: { limit?: number; offset?: number }
      ): Promise<Song[]> {
        const offset = opts?.offset ?? 0;
        if (offset === 0) {
          listingRound += 1;
          if (listingRound === 2) {
            // 内层读取开始前：用户把 7 加进收藏
            if (!playlistSongs.includes(7)) playlistSongs.push(7);
          }
        }
        const limit = opts?.limit ?? 500;
        return playlistSongs
          .slice(offset, offset + limit)
          .map((id) => library.find((s) => s.id === id)!);
      },
      async addSongs(_playlistId: number, ids: number[]) {
        for (const id of ids) if (!playlistSongs.includes(id)) playlistSongs.push(id);
        return { added: ids.length, skipped: 0 };
      },
      async removeSongs(_playlistId: number, ids: number[]) {
        removeCalls.push([...ids]);
        for (const id of ids) {
          const i = playlistSongs.indexOf(id);
          if (i >= 0) playlistSongs.splice(i, 1);
        }
      },
    };
    const service = new WritebackService({
      playlists: playlists as never,
      library: {
        list: async () => library,
        getById: async (id: number) => library.find((s) => s.id === id) ?? null,
      },
      store: {
        load: async () => snapshot,
        save: async (s) => {
          snapshot = s;
        },
      },
      getWriteApi: async () => ({ love: async () => {}, unlove: async () => {} }),
      withLock: async (fn) => ({ skipped: false as const, result: await fn() }),
      sleep: async () => {},
      echoDrainMs: 0,
    });

    const result = await service.reconcileFavorites({
      scrobbler: {
        getLovedTracks: async () => ({
          tracks: [
            { artist: "A", title: "One" },
            { artist: "B", title: "Two" },
            { artist: "C", title: "Three" },
          ],
          truncated: false,
        }),
      },
      username: "u",
      hardCap: 1000,
      now: 100,
    });
    expect(result.ok).toBe(true);
    expect(playlistSongs).toContain(7);
    expect(playlistSongs).toContain(3);
    expect(removeCalls.flat()).not.toContain(7);
  });

  it("does not restore a user remove that lands between outer and inner favorites reads (P1-B)", async () => {
    // 外层读完 [1,2] 后、内层读之前，用户把 2 移出收藏；写回不得把 2 加回去。
    const favoritesId = 42;
    const library = [song(1, "A", "One"), song(2, "B", "Two"), song(3, "C", "Three")];
    const playlistSongs = [1, 2];
    let listingRound = 0;
    let snapshot: WritebackSnapshot = {
      ts: 1,
      lovedKeys: ["at:a\u0000one", "at:b\u0000two"],
      favoriteIds: [1, 2],
      songKeys: { "1": "at:a\u0000one", "2": "at:b\u0000two" },
    };
    const playlists = {
      async list(): Promise<Playlist[]> {
        return [
          {
            id: favoritesId,
            type: "normal",
            name: "收藏",
            description: "",
            cover_url: "",
            labels: ["built_in"],
            song_count: playlistSongs.length,
            created_at: "",
            updated_at: "",
            sort_by: "position",
            sort_order: "asc",
          },
        ];
      },
      async getSongs(
        _playlistId: number,
        opts?: { limit?: number; offset?: number }
      ): Promise<Song[]> {
        const offset = opts?.offset ?? 0;
        if (offset === 0) {
          listingRound += 1;
          if (listingRound === 2) {
            const i = playlistSongs.indexOf(2);
            if (i >= 0) playlistSongs.splice(i, 1);
          }
        }
        const limit = opts?.limit ?? 500;
        return playlistSongs
          .slice(offset, offset + limit)
          .map((id) => library.find((s) => s.id === id)!);
      },
      async addSongs(_playlistId: number, ids: number[]) {
        for (const id of ids) if (!playlistSongs.includes(id)) playlistSongs.push(id);
        return { added: ids.length, skipped: 0 };
      },
      async removeSongs(_playlistId: number, ids: number[]) {
        for (const id of ids) {
          const i = playlistSongs.indexOf(id);
          if (i >= 0) playlistSongs.splice(i, 1);
        }
      },
    };
    const service = new WritebackService({
      playlists: playlists as never,
      library: {
        list: async () => library,
        getById: async (id: number) => library.find((s) => s.id === id) ?? null,
      },
      store: {
        load: async () => snapshot,
        save: async (s) => {
          snapshot = s;
        },
      },
      getWriteApi: async () => ({ love: async () => {}, unlove: async () => {} }),
      withLock: async (fn) => ({ skipped: false as const, result: await fn() }),
      sleep: async () => {},
      echoDrainMs: 0,
    });

    const result = await service.reconcileFavorites({
      scrobbler: {
        getLovedTracks: async () => ({
          tracks: [
            { artist: "A", title: "One" },
            { artist: "B", title: "Two" },
            { artist: "C", title: "Three" },
          ],
          truncated: false,
        }),
      },
      username: "u",
      hardCap: 1000,
      now: 100,
    });
    expect(result.ok).toBe(true);
    expect(playlistSongs).toContain(3);
    expect(playlistSongs).not.toContain(2);
  });

  it("keeps suppressed removals in the baseline and reports actual removed count (P2)", async () => {
    // 外层完整 → plan 要删 2；内层 incomplete → 实际不删；起点不得推进掉 2，removed 必须为 0。
    const favoritesId = 42;
    const library = [song(1, "A", "One"), song(2, "B", "Two")];
    const playlistSongs = [1, 2];
    let listingRound = 0;
    let snapshot: WritebackSnapshot = {
      ts: 1,
      lovedKeys: ["at:a\u0000one", "at:b\u0000two"],
      favoriteIds: [1, 2],
      songKeys: { "1": "at:a\u0000one", "2": "at:b\u0000two" },
    };
    const playlists = {
      async list(): Promise<Playlist[]> {
        return [
          {
            id: favoritesId,
            type: "normal",
            name: "收藏",
            description: "",
            cover_url: "",
            labels: ["built_in"],
            song_count: playlistSongs.length,
            created_at: "",
            updated_at: "",
            sort_by: "position",
            sort_order: "asc",
          },
        ];
      },
      async getSongs(
        _playlistId: number,
        opts?: { limit?: number; offset?: number }
      ): Promise<Song[]> {
        const offset = opts?.offset ?? 0;
        const limit = opts?.limit ?? 500;
        if (offset === 0) listingRound += 1;
        if (listingRound === 1) {
          return playlistSongs
            .slice(offset, offset + limit)
            .map((id) => library.find((s) => s.id === id)!);
        }
        // 内层：忽略 offset 并返回满页 → complete=false，抑制删除
        const page = playlistSongs.map((id) => library.find((s) => s.id === id)!);
        while (page.length < limit) page.push(song(page[0]?.id ?? 1, "", ""));
        return page;
      },
      async addSongs(_playlistId: number, ids: number[]) {
        for (const id of ids) if (!playlistSongs.includes(id)) playlistSongs.push(id);
        return { added: ids.length, skipped: 0 };
      },
      async removeSongs(_playlistId: number, ids: number[]) {
        for (const id of ids) {
          const i = playlistSongs.indexOf(id);
          if (i >= 0) playlistSongs.splice(i, 1);
        }
      },
    };
    const service = new WritebackService({
      playlists: playlists as never,
      library: {
        list: async () => library,
        getById: async (id: number) => library.find((s) => s.id === id) ?? null,
      },
      store: {
        load: async () => snapshot,
        save: async (s) => {
          snapshot = s;
        },
      },
      getWriteApi: async () => ({ love: async () => {}, unlove: async () => {} }),
      withLock: async (fn) => ({ skipped: false as const, result: await fn() }),
      sleep: async () => {},
      echoDrainMs: 0,
    });

    const result = await service.reconcileFavorites({
      scrobbler: {
        getLovedTracks: async () => ({
          tracks: [{ artist: "A", title: "One" }],
          truncated: false,
        }),
      },
      username: "u",
      hardCap: 1000,
      now: 100,
    });
    expect(result.ok).toBe(true);
    expect(result.removed).toBe(0);
    expect(result.removalsSuppressed).toBe(true);
    expect(playlistSongs).toEqual([1, 2]);
    expect(result.snapshot?.favoriteIds.sort()).toEqual([1, 2]);
    // 抑制删除时 lovedKeys 也必须回填，否则下轮 favDelta=0 且 lfmDelta=0 永久卡死
    expect(result.snapshot?.lovedKeys.sort()).toEqual(["at:a\u0000one", "at:b\u0000two"].sort());
    expect(result.snapshot?.songKeys?.["2"]).toBe("at:b\u0000two");
    expect(result.reason || "").toContain("已跳过从收藏删除");
    expect(result.reason || "").not.toContain("已跳过删除与 unlove");
  });

  it("converges suppressed favorite removal on the next complete inner read (P2-新 1)", async () => {
    // 第一轮：外层完整、内层 incomplete → 抑制删 2；第二轮内层完整 → 必须真的删掉。
    const favoritesId = 42;
    const library = [song(1, "A", "One"), song(2, "B", "Two")];
    const playlistSongs = [1, 2];
    let listingRound = 0;
    const removeCalls: number[][] = [];
    let snapshot: WritebackSnapshot = {
      ts: 1,
      lovedKeys: ["at:a\u0000one", "at:b\u0000two"],
      favoriteIds: [1, 2],
      songKeys: { "1": "at:a\u0000one", "2": "at:b\u0000two" },
    };
    const playlists = {
      async list(): Promise<Playlist[]> {
        return [
          {
            id: favoritesId,
            type: "normal",
            name: "收藏",
            description: "",
            cover_url: "",
            labels: ["built_in"],
            song_count: playlistSongs.length,
            created_at: "",
            updated_at: "",
            sort_by: "position",
            sort_order: "asc",
          },
        ];
      },
      async getSongs(
        _playlistId: number,
        opts?: { limit?: number; offset?: number }
      ): Promise<Song[]> {
        const offset = opts?.offset ?? 0;
        const limit = opts?.limit ?? 500;
        if (offset === 0) listingRound += 1;
        // round 1 outer + round 2 inner(incomplete)；之后全部完整
        if (listingRound === 2) {
          const page = playlistSongs.map((id) => library.find((s) => s.id === id)!);
          while (page.length < limit) page.push(song(page[0]?.id ?? 1, "", ""));
          return page;
        }
        return playlistSongs
          .slice(offset, offset + limit)
          .map((id) => library.find((s) => s.id === id)!);
      },
      async addSongs(_playlistId: number, ids: number[]) {
        for (const id of ids) if (!playlistSongs.includes(id)) playlistSongs.push(id);
        return { added: ids.length, skipped: 0 };
      },
      async removeSongs(_playlistId: number, ids: number[]) {
        removeCalls.push([...ids]);
        for (const id of ids) {
          const i = playlistSongs.indexOf(id);
          if (i >= 0) playlistSongs.splice(i, 1);
        }
      },
    };
    const service = new WritebackService({
      playlists: playlists as never,
      library: {
        list: async () => library,
        getById: async (id: number) => library.find((s) => s.id === id) ?? null,
      },
      store: {
        load: async () => snapshot,
        save: async (s) => {
          snapshot = s;
        },
      },
      getWriteApi: async () => ({ love: async () => {}, unlove: async () => {} }),
      withLock: async (fn) => ({ skipped: false as const, result: await fn() }),
      sleep: async () => {},
      echoDrainMs: 0,
    });

    const scrobbler = {
      getLovedTracks: async () => ({
        tracks: [{ artist: "A", title: "One" }],
        truncated: false,
      }),
    };
    const r1 = await service.reconcileFavorites({
      scrobbler,
      username: "u",
      hardCap: 1000,
      now: 100,
    });
    expect(r1.ok).toBe(true);
    expect(r1.removed).toBe(0);
    expect(removeCalls).toEqual([]);
    expect(r1.snapshot?.favoriteIds.sort()).toEqual([1, 2]);
    expect(r1.snapshot?.lovedKeys).toContain("at:b\u0000two");

    const r2 = await service.reconcileFavorites({
      scrobbler,
      username: "u",
      hardCap: 1000,
      now: 200,
    });
    expect(r2.ok).toBe(true);
    expect(r2.removed).toBe(1);
    expect(removeCalls).toEqual([[2]]);
    expect(playlistSongs).toEqual([1]);
    expect(r2.snapshot?.favoriteIds).toEqual([1]);
  });

  it("does not duplicate an unread favorite when inner listing ignores offset (P2-新 2)", async () => {
    // 收藏 600 首、宿主忽略 offset；550 已在未读区间，起点未记 550，Last.fm 刚红心 550。
    // 不完整时不得 addSongs(550)；完整读取后最多补一次、收藏里只能有 1 份。
    const favoritesId = 42;
    const total = 600;
    const library = Array.from({ length: total }, (_, i) => {
      const id = i + 1;
      return song(id, `A${id}`, `T${id}`);
    });
    const playlistSongs = Array.from({ length: total }, (_, i) => i + 1);
    // 起点故意漏掉 550（模拟此前簿记落后）
    const favoriteIds = playlistSongs.filter((id) => id !== 550);
    const lovedKeys = favoriteIds.map((id) => `at:a${id}\u0000t${id}`);
    const songKeys: Record<string, string> = {};
    for (const id of favoriteIds) songKeys[String(id)] = `at:a${id}\u0000t${id}`;

    let forceIncomplete = true;
    const addCalls: number[][] = [];
    let snapshot: WritebackSnapshot = {
      ts: 1,
      lovedKeys,
      favoriteIds,
      songKeys,
    };
    const playlists = {
      async list(): Promise<Playlist[]> {
        return [
          {
            id: favoritesId,
            type: "normal",
            name: "收藏",
            description: "",
            cover_url: "",
            labels: ["built_in"],
            song_count: playlistSongs.length,
            created_at: "",
            updated_at: "",
            sort_by: "position",
            sort_order: "asc",
          },
        ];
      },
      async getSongs(
        _playlistId: number,
        opts?: { limit?: number; offset?: number }
      ): Promise<Song[]> {
        const limit = opts?.limit ?? 500;
        const offset = opts?.offset ?? 0;
        if (forceIncomplete) {
          // 宿主忽略 offset：永远返回前 500 → complete=false
          return playlistSongs.slice(0, 500).map((id) => library.find((s) => s.id === id)!);
        }
        return playlistSongs
          .slice(offset, offset + limit)
          .map((id) => library.find((s) => s.id === id)!);
      },
      async addSongs(_playlistId: number, ids: number[]) {
        addCalls.push([...ids]);
        for (const id of ids) {
          // 不去重：模拟真实宿主可能写入重复条目
          playlistSongs.push(id);
        }
        return { added: ids.length, skipped: 0 };
      },
      async removeSongs(_playlistId: number, ids: number[]) {
        for (const id of ids) {
          const i = playlistSongs.indexOf(id);
          if (i >= 0) playlistSongs.splice(i, 1);
        }
      },
    };
    const service = new WritebackService({
      playlists: playlists as never,
      library: {
        list: async (opts?: { limit?: number; offset?: number }) => {
          const limit = opts?.limit ?? 500;
          const offset = opts?.offset ?? 0;
          return library.slice(offset, offset + limit);
        },
        getById: async (id: number) => library.find((s) => s.id === id) ?? null,
      },
      store: {
        load: async () => snapshot,
        save: async (s) => {
          snapshot = s;
        },
      },
      getWriteApi: async () => ({ love: async () => {}, unlove: async () => {} }),
      withLock: async (fn) => ({ skipped: false as const, result: await fn() }),
      sleep: async () => {},
      echoDrainMs: 0,
    });

    const lovedTracks = playlistSongs.map((id) => ({ artist: `A${id}`, title: `T${id}` }));
    const r1 = await service.reconcileFavorites({
      scrobbler: { getLovedTracks: async () => ({ tracks: lovedTracks, truncated: false }) },
      username: "u",
      hardCap: 2000,
      now: 100,
    });
    expect(r1.ok).toBe(true);
    expect(addCalls.flat()).not.toContain(550);
    expect(r1.added).toBe(0);
    expect(playlistSongs.filter((id) => id === 550)).toHaveLength(1);
    // 跳过的 add 不得推进起点，否则下轮永久不重试
    expect(r1.snapshot?.favoriteIds).not.toContain(550);
    expect(r1.reason || "").toMatch(/不完整/);

    forceIncomplete = false;
    const r2 = await service.reconcileFavorites({
      scrobbler: { getLovedTracks: async () => ({ tracks: lovedTracks, truncated: false }) },
      username: "u",
      hardCap: 2000,
      now: 200,
    });
    expect(r2.ok).toBe(true);
    // 完整读取后发现 550 已在收藏 → 不应再 add；整份收藏只有 1 个 550
    expect(addCalls.flat()).not.toContain(550);
    expect(playlistSongs.filter((id) => id === 550)).toHaveLength(1);
  });

  it("does not unlove a track the user re-added between outer and inner reads (P2-新 3)", async () => {
    // 外层见 [1]（2 已不在）；内层读前用户把 2 加回；不得对 Two 发 unlove，2 须留在收藏与起点。
    const favoritesId = 42;
    const library = [
      song(1, "A", "One"),
      song(2, "B", "Two"),
      song(3, "C", "Three"),
    ];
    const playlistSongs = [1];
    let listingRound = 0;
    const calls: Array<{ kind: string; artist: string; title: string }> = [];
    let snapshot: WritebackSnapshot = {
      ts: 1,
      lovedKeys: ["at:a\u0000one", "at:b\u0000two"],
      favoriteIds: [1, 2],
      songKeys: { "1": "at:a\u0000one", "2": "at:b\u0000two" },
    };
    const playlists = {
      async list(): Promise<Playlist[]> {
        return [
          {
            id: favoritesId,
            type: "normal",
            name: "收藏",
            description: "",
            cover_url: "",
            labels: ["built_in"],
            song_count: playlistSongs.length,
            created_at: "",
            updated_at: "",
            sort_by: "position",
            sort_order: "asc",
          },
        ];
      },
      async getSongs(
        _playlistId: number,
        opts?: { limit?: number; offset?: number }
      ): Promise<Song[]> {
        const offset = opts?.offset ?? 0;
        if (offset === 0) {
          listingRound += 1;
          if (listingRound === 2) {
            if (!playlistSongs.includes(2)) playlistSongs.push(2);
          }
        }
        const limit = opts?.limit ?? 500;
        return playlistSongs
          .slice(offset, offset + limit)
          .map((id) => library.find((s) => s.id === id)!);
      },
      async addSongs(_playlistId: number, ids: number[]) {
        for (const id of ids) if (!playlistSongs.includes(id)) playlistSongs.push(id);
        return { added: ids.length, skipped: 0 };
      },
      async removeSongs(_playlistId: number, ids: number[]) {
        for (const id of ids) {
          const i = playlistSongs.indexOf(id);
          if (i >= 0) playlistSongs.splice(i, 1);
        }
      },
    };
    const service = new WritebackService({
      playlists: playlists as never,
      library: {
        list: async () => library,
        getById: async (id: number) => library.find((s) => s.id === id) ?? null,
      },
      store: {
        load: async () => snapshot,
        save: async (s) => {
          snapshot = s;
        },
      },
      getWriteApi: async () => ({
        love: async (artist: string, title: string) => {
          calls.push({ kind: "love", artist, title });
        },
        unlove: async (artist: string, title: string) => {
          calls.push({ kind: "unlove", artist, title });
        },
      }),
      withLock: async (fn) => ({ skipped: false as const, result: await fn() }),
      sleep: async () => {},
      echoDrainMs: 0,
    });

    const result = await service.reconcileFavorites({
      scrobbler: {
        getLovedTracks: async () => ({
          tracks: [
            { artist: "A", title: "One" },
            { artist: "B", title: "Two" },
            { artist: "C", title: "Three" },
          ],
          truncated: false,
        }),
      },
      username: "u",
      hardCap: 1000,
      now: 100,
    });
    expect(result.ok).toBe(true);
    expect(calls.filter((c) => c.kind === "unlove" && c.title === "Two")).toEqual([]);
    expect(playlistSongs).toContain(2);
    expect(playlistSongs).toContain(3);
    expect(result.snapshot?.favoriteIds.sort()).toEqual([1, 2, 3].sort());
    expect(result.unlovedCount).toBe(0);
  });

  it("reason distinguishes favorite-removal suppression from unlove suppression (P2-新 4)", async () => {
    // 外层/Loved 完整，内层 incomplete：收藏删除被抑制，但 plan.unlove 仍可执行 → 文案不得说「已跳过 unlove」。
    const favoritesId = 42;
    const library = [song(1, "A", "One"), song(2, "B", "Two"), song(3, "C", "Three")];
    const playlistSongs = [1, 2];
    let listingRound = 0;
    const calls: Array<{ kind: string; artist: string; title: string }> = [];
    let snapshot: WritebackSnapshot = {
      ts: 1,
      lovedKeys: ["at:a\u0000one", "at:b\u0000two", "at:c\u0000three"],
      favoriteIds: [1, 2, 3],
      songKeys: { "1": "at:a\u0000one", "2": "at:b\u0000two", "3": "at:c\u0000three" },
    };
    const playlists = {
      async list(): Promise<Playlist[]> {
        return [
          {
            id: favoritesId,
            type: "normal",
            name: "收藏",
            description: "",
            cover_url: "",
            labels: ["built_in"],
            song_count: playlistSongs.length,
            created_at: "",
            updated_at: "",
            sort_by: "position",
            sort_order: "asc",
          },
        ];
      },
      async getSongs(
        _playlistId: number,
        opts?: { limit?: number; offset?: number }
      ): Promise<Song[]> {
        const offset = opts?.offset ?? 0;
        const limit = opts?.limit ?? 500;
        if (offset === 0) listingRound += 1;
        if (listingRound === 1) {
          return playlistSongs
            .slice(offset, offset + limit)
            .map((id) => library.find((s) => s.id === id)!);
        }
        const page = playlistSongs.map((id) => library.find((s) => s.id === id)!);
        while (page.length < limit) page.push(song(page[0]?.id ?? 1, "", ""));
        return page;
      },
      async addSongs(_playlistId: number, ids: number[]) {
        for (const id of ids) if (!playlistSongs.includes(id)) playlistSongs.push(id);
        return { added: ids.length, skipped: 0 };
      },
      async removeSongs(_playlistId: number, ids: number[]) {
        for (const id of ids) {
          const i = playlistSongs.indexOf(id);
          if (i >= 0) playlistSongs.splice(i, 1);
        }
      },
    };
    const service = new WritebackService({
      playlists: playlists as never,
      library: {
        list: async () => library,
        getById: async (id: number) => library.find((s) => s.id === id) ?? null,
      },
      store: {
        load: async () => snapshot,
        save: async (s) => {
          snapshot = s;
        },
      },
      getWriteApi: async () => ({
        love: async (artist: string, title: string) => {
          calls.push({ kind: "love", artist, title });
        },
        unlove: async (artist: string, title: string) => {
          calls.push({ kind: "unlove", artist, title });
        },
      }),
      withLock: async (fn) => ({ skipped: false as const, result: await fn() }),
      sleep: async () => {},
      echoDrainMs: 0,
    });

    // Last.fm 取消了 Two（收藏仍有 → 应删收藏但被内层抑制）；Three 已不在收藏但仍爱 → unlove
    const result = await service.reconcileFavorites({
      scrobbler: {
        getLovedTracks: async () => ({
          tracks: [
            { artist: "A", title: "One" },
            { artist: "C", title: "Three" },
          ],
          truncated: false,
        }),
      },
      username: "u",
      hardCap: 1000,
      now: 100,
    });
    expect(result.ok).toBe(true);
    expect(result.removed).toBe(0);
    expect(result.removalsSuppressed).toBe(true);
    expect(calls.some((c) => c.kind === "unlove" && c.title === "Three")).toBe(true);
    expect(result.reason || "").toContain("已跳过从收藏删除");
    expect(result.reason || "").not.toContain("已跳过删除与 unlove");
  });

  it("converges skipped Last.fm love into favorites on the next complete inner read (P1-新 1)", async () => {
    // 3 首曲库、收藏 [1,2]、Last.fm 新红心 Three；第一轮内层不完整 → 跳过 add；
    // 第二轮内层完整 → 必须 addSongs([3]) 且 added===1（现有 P2-新 2 用例测不出这条）。
    const favoritesId = 42;
    const library = [song(1, "A", "One"), song(2, "B", "Two"), song(3, "C", "Three")];
    const playlistSongs = [1, 2];
    let listingRound = 0;
    const addCalls: number[][] = [];
    let snapshot: WritebackSnapshot = {
      ts: 1,
      lovedKeys: ["at:a\u0000one", "at:b\u0000two"],
      favoriteIds: [1, 2],
      songKeys: { "1": "at:a\u0000one", "2": "at:b\u0000two" },
    };
    const playlists = {
      async list(): Promise<Playlist[]> {
        return [
          {
            id: favoritesId,
            type: "normal",
            name: "收藏",
            description: "",
            cover_url: "",
            labels: ["built_in"],
            song_count: playlistSongs.length,
            created_at: "",
            updated_at: "",
            sort_by: "position",
            sort_order: "asc",
          },
        ];
      },
      async getSongs(
        _playlistId: number,
        opts?: { limit?: number; offset?: number }
      ): Promise<Song[]> {
        const offset = opts?.offset ?? 0;
        const limit = opts?.limit ?? 500;
        if (offset === 0) listingRound += 1;
        // round 1 outer 完整；round 2 inner 不完整；之后全部完整
        if (listingRound === 2) {
          const page = playlistSongs.map((id) => library.find((s) => s.id === id)!);
          while (page.length < limit) page.push(song(page[0]?.id ?? 1, "", ""));
          return page;
        }
        return playlistSongs
          .slice(offset, offset + limit)
          .map((id) => library.find((s) => s.id === id)!);
      },
      async addSongs(_playlistId: number, ids: number[]) {
        addCalls.push([...ids]);
        for (const id of ids) if (!playlistSongs.includes(id)) playlistSongs.push(id);
        return { added: ids.length, skipped: 0 };
      },
      async removeSongs(_playlistId: number, ids: number[]) {
        for (const id of ids) {
          const i = playlistSongs.indexOf(id);
          if (i >= 0) playlistSongs.splice(i, 1);
        }
      },
    };
    const service = new WritebackService({
      playlists: playlists as never,
      library: {
        list: async () => library,
        getById: async (id: number) => library.find((s) => s.id === id) ?? null,
      },
      store: {
        load: async () => snapshot,
        save: async (s) => {
          snapshot = s;
        },
      },
      getWriteApi: async () => ({ love: async () => {}, unlove: async () => {} }),
      withLock: async (fn) => ({ skipped: false as const, result: await fn() }),
      sleep: async () => {},
      echoDrainMs: 0,
    });

    const scrobbler = {
      getLovedTracks: async () => ({
        tracks: [
          { artist: "A", title: "One" },
          { artist: "B", title: "Two" },
          { artist: "C", title: "Three" },
        ],
        truncated: false,
      }),
    };
    const r1 = await service.reconcileFavorites({
      scrobbler,
      username: "u",
      hardCap: 1000,
      now: 100,
    });
    expect(r1.ok).toBe(true);
    expect(r1.added).toBe(0);
    expect(addCalls).toEqual([]);
    expect(r1.snapshot?.favoriteIds.sort()).toEqual([1, 2]);
    expect(r1.snapshot?.favoriteIds).not.toContain(3);
    // 跳过的 add 必须同时撤 lovedKeys/songKeys，否则下一轮两边无变化永久不重试
    expect(r1.snapshot?.lovedKeys || []).not.toContain("at:c\u0000three");
    expect(r1.snapshot?.songKeys?.["3"]).toBeUndefined();
    expect(r1.reason || "").toMatch(/不完整/);

    const r2 = await service.reconcileFavorites({
      scrobbler,
      username: "u",
      hardCap: 1000,
      now: 200,
    });
    expect(r2.ok).toBe(true);
    expect(r2.added).toBe(1);
    expect(addCalls).toEqual([[3]]);
    expect(playlistSongs.sort()).toEqual([1, 2, 3]);
    expect(r2.snapshot?.favoriteIds.sort()).toEqual([1, 2, 3]);
  });

  it("loves a track the user added between outer and inner reads (P2-新 5)", async () => {
    // 起点 [1]；Last.fm 新红心 Three 触发内层读；内层读前用户把 2 加进收藏 → 必须 love Two。
    const favoritesId = 42;
    const library = [
      song(1, "A", "One"),
      song(2, "B", "Two"),
      song(3, "C", "Three"),
    ];
    const playlistSongs = [1];
    let listingRound = 0;
    const calls: Array<{ kind: string; artist: string; title: string }> = [];
    let snapshot: WritebackSnapshot = {
      ts: 1,
      lovedKeys: ["at:a\u0000one"],
      favoriteIds: [1],
      songKeys: { "1": "at:a\u0000one" },
    };
    const playlists = {
      async list(): Promise<Playlist[]> {
        return [
          {
            id: favoritesId,
            type: "normal",
            name: "收藏",
            description: "",
            cover_url: "",
            labels: ["built_in"],
            song_count: playlistSongs.length,
            created_at: "",
            updated_at: "",
            sort_by: "position",
            sort_order: "asc",
          },
        ];
      },
      async getSongs(
        _playlistId: number,
        opts?: { limit?: number; offset?: number }
      ): Promise<Song[]> {
        const offset = opts?.offset ?? 0;
        if (offset === 0) {
          listingRound += 1;
          if (listingRound === 2 && !playlistSongs.includes(2)) playlistSongs.push(2);
        }
        const limit = opts?.limit ?? 500;
        return playlistSongs
          .slice(offset, offset + limit)
          .map((id) => library.find((s) => s.id === id)!);
      },
      async addSongs(_playlistId: number, ids: number[]) {
        for (const id of ids) if (!playlistSongs.includes(id)) playlistSongs.push(id);
        return { added: ids.length, skipped: 0 };
      },
      async removeSongs(_playlistId: number, ids: number[]) {
        for (const id of ids) {
          const i = playlistSongs.indexOf(id);
          if (i >= 0) playlistSongs.splice(i, 1);
        }
      },
    };
    const service = new WritebackService({
      playlists: playlists as never,
      library: {
        list: async () => library,
        getById: async (id: number) => library.find((s) => s.id === id) ?? null,
      },
      store: {
        load: async () => snapshot,
        save: async (s) => {
          snapshot = s;
        },
      },
      getWriteApi: async () => ({
        love: async (artist: string, title: string) => {
          calls.push({ kind: "love", artist, title });
        },
        unlove: async (artist: string, title: string) => {
          calls.push({ kind: "unlove", artist, title });
        },
      }),
      withLock: async (fn) => ({ skipped: false as const, result: await fn() }),
      sleep: async () => {},
      echoDrainMs: 0,
    });

    const result = await service.reconcileFavorites({
      scrobbler: {
        getLovedTracks: async () => ({
          tracks: [
            { artist: "A", title: "One" },
            { artist: "C", title: "Three" },
          ],
          truncated: false,
        }),
      },
      username: "u",
      hardCap: 1000,
      now: 100,
    });
    expect(result.ok).toBe(true);
    expect(calls.some((c) => c.kind === "love" && c.title === "Two")).toBe(true);
    expect(result.lovedCount).toBeGreaterThanOrEqual(1);
    expect(result.snapshot?.favoriteIds.sort()).toEqual([1, 2, 3].sort());
    // P2-c：窗口补 love 只记 songKeys，不把「已调 API」写成远端已红心。
    expect(result.snapshot?.songKeys?.["2"]).toBe("at:b\u0000two");
    expect(result.snapshot?.lovedKeys || []).not.toContain("at:b\u0000two");
  });

  it("unloves a track the user removed between outer and inner reads (P2-新 6)", async () => {
    // 起点含 2；内层读前用户把 2 移出；Last.fm 仍爱 → 必须 unlove Two，且起点三集合一致。
    const favoritesId = 42;
    const library = [
      song(1, "A", "One"),
      song(2, "B", "Two"),
      song(4, "D", "Four"),
    ];
    const playlistSongs = [1, 2];
    let listingRound = 0;
    const calls: Array<{ kind: string; artist: string; title: string }> = [];
    let snapshot: WritebackSnapshot = {
      ts: 1,
      lovedKeys: ["at:a\u0000one", "at:b\u0000two"],
      favoriteIds: [1, 2],
      songKeys: { "1": "at:a\u0000one", "2": "at:b\u0000two" },
    };
    const playlists = {
      async list(): Promise<Playlist[]> {
        return [
          {
            id: favoritesId,
            type: "normal",
            name: "收藏",
            description: "",
            cover_url: "",
            labels: ["built_in"],
            song_count: playlistSongs.length,
            created_at: "",
            updated_at: "",
            sort_by: "position",
            sort_order: "asc",
          },
        ];
      },
      async getSongs(
        _playlistId: number,
        opts?: { limit?: number; offset?: number }
      ): Promise<Song[]> {
        const offset = opts?.offset ?? 0;
        if (offset === 0) {
          listingRound += 1;
          // 外层仍见 [1,2]；内层读前用户删掉 2
          if (listingRound === 2) {
            const i = playlistSongs.indexOf(2);
            if (i >= 0) playlistSongs.splice(i, 1);
          }
        }
        const limit = opts?.limit ?? 500;
        return playlistSongs
          .slice(offset, offset + limit)
          .map((id) => library.find((s) => s.id === id)!);
      },
      async addSongs(_playlistId: number, ids: number[]) {
        for (const id of ids) if (!playlistSongs.includes(id)) playlistSongs.push(id);
        return { added: ids.length, skipped: 0 };
      },
      async removeSongs(_playlistId: number, ids: number[]) {
        for (const id of ids) {
          const i = playlistSongs.indexOf(id);
          if (i >= 0) playlistSongs.splice(i, 1);
        }
      },
    };
    const service = new WritebackService({
      playlists: playlists as never,
      library: {
        list: async () => library,
        getById: async (id: number) => library.find((s) => s.id === id) ?? null,
      },
      store: {
        load: async () => snapshot,
        save: async (s) => {
          snapshot = s;
        },
      },
      getWriteApi: async () => ({
        love: async (artist: string, title: string) => {
          calls.push({ kind: "love", artist, title });
        },
        unlove: async (artist: string, title: string) => {
          calls.push({ kind: "unlove", artist, title });
        },
      }),
      withLock: async (fn) => ({ skipped: false as const, result: await fn() }),
      sleep: async () => {},
      echoDrainMs: 0,
    });

    const result = await service.reconcileFavorites({
      scrobbler: {
        getLovedTracks: async () => ({
          tracks: [
            { artist: "A", title: "One" },
            { artist: "B", title: "Two" },
            { artist: "D", title: "Four" },
          ],
          truncated: false,
        }),
      },
      username: "u",
      hardCap: 1000,
      now: 100,
    });
    expect(result.ok).toBe(true);
    expect(calls.some((c) => c.kind === "unlove" && c.title === "Two")).toBe(true);
    expect(result.unlovedCount).toBeGreaterThanOrEqual(1);
    expect(playlistSongs).not.toContain(2);
    expect(result.snapshot?.favoriteIds).not.toContain(2);
    // P2-c：窗口补 unlove 时 next.lovedKeys 仍含该键 → 不立刻从 lovedKeys 摘掉。
    expect(result.snapshot?.lovedKeys || []).toContain("at:b\u0000two");
  });

  it("does not unlove window-removed track when Loved list is truncated (P2-新 6 gate)", async () => {
    // Loved 截断 + 窗口内用户删歌 → 不得 unlove，收藏也不得被回滚。
    const favoritesId = 42;
    const library = [song(1, "A", "One"), song(2, "B", "Two"), song(3, "C", "Three")];
    const playlistSongs = [1, 2];
    let listingRound = 0;
    const calls: Array<{ kind: string; artist: string; title: string }> = [];
    let snapshot: WritebackSnapshot = {
      ts: 1,
      lovedKeys: ["at:a\u0000one", "at:b\u0000two"],
      favoriteIds: [1, 2],
      songKeys: { "1": "at:a\u0000one", "2": "at:b\u0000two" },
    };
    const playlists = {
      async list(): Promise<Playlist[]> {
        return [
          {
            id: favoritesId,
            type: "normal",
            name: "收藏",
            description: "",
            cover_url: "",
            labels: ["built_in"],
            song_count: playlistSongs.length,
            created_at: "",
            updated_at: "",
            sort_by: "position",
            sort_order: "asc",
          },
        ];
      },
      async getSongs(
        _playlistId: number,
        opts?: { limit?: number; offset?: number }
      ): Promise<Song[]> {
        const offset = opts?.offset ?? 0;
        if (offset === 0) {
          listingRound += 1;
          if (listingRound === 2) {
            const i = playlistSongs.indexOf(2);
            if (i >= 0) playlistSongs.splice(i, 1);
          }
        }
        const limit = opts?.limit ?? 500;
        return playlistSongs
          .slice(offset, offset + limit)
          .map((id) => library.find((s) => s.id === id)!);
      },
      async addSongs(_playlistId: number, ids: number[]) {
        for (const id of ids) if (!playlistSongs.includes(id)) playlistSongs.push(id);
        return { added: ids.length, skipped: 0 };
      },
      async removeSongs(_playlistId: number, ids: number[]) {
        for (const id of ids) {
          const i = playlistSongs.indexOf(id);
          if (i >= 0) playlistSongs.splice(i, 1);
        }
      },
    };
    const service = new WritebackService({
      playlists: playlists as never,
      library: {
        list: async () => library,
        getById: async (id: number) => library.find((s) => s.id === id) ?? null,
      },
      store: {
        load: async () => snapshot,
        save: async (s) => {
          snapshot = s;
        },
      },
      getWriteApi: async () => ({
        love: async (artist: string, title: string) => {
          calls.push({ kind: "love", artist, title });
        },
        unlove: async (artist: string, title: string) => {
          calls.push({ kind: "unlove", artist, title });
        },
      }),
      withLock: async (fn) => ({ skipped: false as const, result: await fn() }),
      sleep: async () => {},
      echoDrainMs: 0,
    });

    // truncated + 有差量（Three）触发内层读；窗口内用户删了 2
    const result = await service.reconcileFavorites({
      scrobbler: {
        getLovedTracks: async () => ({
          tracks: [
            { artist: "A", title: "One" },
            { artist: "B", title: "Two" },
            { artist: "C", title: "Three" },
          ],
          truncated: true,
        }),
      },
      username: "u",
      hardCap: 1000,
      now: 100,
    });
    expect(result.ok).toBe(true);
    expect(calls.filter((c) => c.kind === "unlove")).toEqual([]);
    expect(result.unlovedCount).toBe(0);
    // 收藏不得因截断回滚（2 已被用户删，不应被加回）
    expect(playlistSongs).not.toContain(2);
    expect(result.removalsSuppressed).toBe(true);
  });

  it("reason omits forward-fill claim when adds were skipped (P2-新 7)", async () => {
    // 外层与内层都不完整、added=0 时，不得声称「仅做正向补齐」。
    const favoritesId = 42;
    const library = [song(1, "A", "One"), song(2, "B", "Two"), song(3, "C", "Three")];
    const playlistSongs = [1, 2];
    let snapshot: WritebackSnapshot = {
      ts: 1,
      lovedKeys: ["at:a\u0000one", "at:b\u0000two"],
      favoriteIds: [1, 2],
      songKeys: { "1": "at:a\u0000one", "2": "at:b\u0000two" },
    };
    const playlists = {
      async list(): Promise<Playlist[]> {
        return [
          {
            id: favoritesId,
            type: "normal",
            name: "收藏",
            description: "",
            cover_url: "",
            labels: ["built_in"],
            song_count: playlistSongs.length,
            created_at: "",
            updated_at: "",
            sort_by: "position",
            sort_order: "asc",
          },
        ];
      },
      async getSongs(_playlistId: number): Promise<Song[]> {
        // 宿主忽略 offset：永远满页 → complete=false
        const page = playlistSongs.map((id) => library.find((s) => s.id === id)!);
        while (page.length < 500) page.push(song(page[0]?.id ?? 1, "", ""));
        return page;
      },
      async addSongs(_playlistId: number, ids: number[]) {
        for (const id of ids) if (!playlistSongs.includes(id)) playlistSongs.push(id);
        return { added: ids.length, skipped: 0 };
      },
      async removeSongs(_playlistId: number, ids: number[]) {
        for (const id of ids) {
          const i = playlistSongs.indexOf(id);
          if (i >= 0) playlistSongs.splice(i, 1);
        }
      },
    };
    const service = new WritebackService({
      playlists: playlists as never,
      library: {
        list: async () => library,
        getById: async (id: number) => library.find((s) => s.id === id) ?? null,
      },
      store: {
        load: async () => snapshot,
        save: async (s) => {
          snapshot = s;
        },
      },
      getWriteApi: async () => ({ love: async () => {}, unlove: async () => {} }),
      withLock: async (fn) => ({ skipped: false as const, result: await fn() }),
      sleep: async () => {},
      echoDrainMs: 0,
    });

    const result = await service.reconcileFavorites({
      scrobbler: {
        getLovedTracks: async () => ({
          tracks: [
            { artist: "A", title: "One" },
            { artist: "B", title: "Two" },
            { artist: "C", title: "Three" },
          ],
          truncated: false,
        }),
      },
      username: "u",
      hardCap: 1000,
      now: 100,
    });
    expect(result.ok).toBe(true);
    expect(result.added).toBe(0);
    expect(result.removalsSuppressed).toBe(true);
    expect(result.reason || "").toContain("已跳过删除与 unlove");
    expect(result.reason || "").not.toContain("仅做正向补齐");
    expect(result.reason || "").toContain("已跳过部分写入");
  });

  it("does not restore user-removed id into favoriteIds when suppressions resolve on complete inner read (P2-新 8)", async () => {
    // 外层 [1,2]、内层 [1]（用户已删 2）、Last.fm 也取消了 Two → 起点不得短暂塞回 2。
    const favoritesId = 42;
    const library = [song(1, "A", "One"), song(2, "B", "Two")];
    const playlistSongs = [1, 2];
    let listingRound = 0;
    let snapshot: WritebackSnapshot = {
      ts: 1,
      lovedKeys: ["at:a\u0000one", "at:b\u0000two"],
      favoriteIds: [1, 2],
      songKeys: { "1": "at:a\u0000one", "2": "at:b\u0000two" },
    };
    const playlists = {
      async list(): Promise<Playlist[]> {
        return [
          {
            id: favoritesId,
            type: "normal",
            name: "收藏",
            description: "",
            cover_url: "",
            labels: ["built_in"],
            song_count: playlistSongs.length,
            created_at: "",
            updated_at: "",
            sort_by: "position",
            sort_order: "asc",
          },
        ];
      },
      async getSongs(
        _playlistId: number,
        opts?: { limit?: number; offset?: number }
      ): Promise<Song[]> {
        const offset = opts?.offset ?? 0;
        if (offset === 0) {
          listingRound += 1;
          if (listingRound === 2) {
            const i = playlistSongs.indexOf(2);
            if (i >= 0) playlistSongs.splice(i, 1);
          }
        }
        const limit = opts?.limit ?? 500;
        return playlistSongs
          .slice(offset, offset + limit)
          .map((id) => library.find((s) => s.id === id)!);
      },
      async addSongs(_playlistId: number, ids: number[]) {
        for (const id of ids) if (!playlistSongs.includes(id)) playlistSongs.push(id);
        return { added: ids.length, skipped: 0 };
      },
      async removeSongs(_playlistId: number, ids: number[]) {
        for (const id of ids) {
          const i = playlistSongs.indexOf(id);
          if (i >= 0) playlistSongs.splice(i, 1);
        }
      },
    };
    const service = new WritebackService({
      playlists: playlists as never,
      library: {
        list: async () => library,
        getById: async (id: number) => library.find((s) => s.id === id) ?? null,
      },
      store: {
        load: async () => snapshot,
        save: async (s) => {
          snapshot = s;
        },
      },
      getWriteApi: async () => ({ love: async () => {}, unlove: async () => {} }),
      withLock: async (fn) => ({ skipped: false as const, result: await fn() }),
      sleep: async () => {},
      echoDrainMs: 0,
    });

    const result = await service.reconcileFavorites({
      scrobbler: {
        getLovedTracks: async () => ({
          tracks: [{ artist: "A", title: "One" }],
          truncated: false,
        }),
      },
      username: "u",
      hardCap: 1000,
      now: 100,
    });
    expect(result.ok).toBe(true);
    expect(result.removed).toBe(0);
    expect(playlistSongs).toEqual([1]);
    expect(result.snapshot?.favoriteIds).toEqual([1]);
    expect(result.snapshot?.favoriteIds).not.toContain(2);
  });

  it("retries deferred three-set ops after a safe complete round (consistency regression)", async () => {
    // 覆盖：跳过的 add、被抑制的 remove、窗口内用户加、窗口内用户删；
    // 第一轮延后的操作在下一轮安全完整读取后必须真正执行，且不得只改一侧集合卡死。
    const favoritesId = 42;
    const library = [
      song(1, "A", "One"),
      song(2, "B", "Two"),
      song(3, "C", "Three"),
      song(5, "E", "Five"),
      song(6, "F", "Six"),
      song(7, "G", "Seven"),
    ];
    let playlistSongs = [1, 2, 6];
    let listingRound = 0;
    let phase: "incomplete" | "converge" | "window" = "incomplete";
    const addCalls: number[][] = [];
    const removeCalls: number[][] = [];
    const calls: Array<{ kind: string; artist: string; title: string }> = [];
    let snapshot: WritebackSnapshot = {
      ts: 1,
      lovedKeys: ["at:a\u0000one", "at:b\u0000two", "at:f\u0000six"],
      favoriteIds: [1, 2, 6],
      songKeys: { "1": "at:a\u0000one", "2": "at:b\u0000two", "6": "at:f\u0000six" },
    };
    const playlists = {
      async list(): Promise<Playlist[]> {
        return [
          {
            id: favoritesId,
            type: "normal",
            name: "收藏",
            description: "",
            cover_url: "",
            labels: ["built_in"],
            song_count: playlistSongs.length,
            created_at: "",
            updated_at: "",
            sort_by: "position",
            sort_order: "asc",
          },
        ];
      },
      async getSongs(
        _playlistId: number,
        opts?: { limit?: number; offset?: number }
      ): Promise<Song[]> {
        const offset = opts?.offset ?? 0;
        const limit = opts?.limit ?? 500;
        if (offset === 0) listingRound += 1;
        if (phase === "incomplete" && listingRound === 2) {
          const page = playlistSongs.map((id) => library.find((s) => s.id === id)!);
          while (page.length < limit) page.push(song(page[0]?.id ?? 1, "", ""));
          return page;
        }
        if (phase === "window" && listingRound === 2) {
          // 外层仍见 6；内层前用户删 6、加 5
          const i = playlistSongs.indexOf(6);
          if (i >= 0) playlistSongs.splice(i, 1);
          if (!playlistSongs.includes(5)) playlistSongs.push(5);
        }
        return playlistSongs
          .slice(offset, offset + limit)
          .map((id) => library.find((s) => s.id === id)!);
      },
      async addSongs(_playlistId: number, ids: number[]) {
        addCalls.push([...ids]);
        for (const id of ids) if (!playlistSongs.includes(id)) playlistSongs.push(id);
        return { added: ids.length, skipped: 0 };
      },
      async removeSongs(_playlistId: number, ids: number[]) {
        removeCalls.push([...ids]);
        for (const id of ids) {
          const i = playlistSongs.indexOf(id);
          if (i >= 0) playlistSongs.splice(i, 1);
        }
      },
    };
    const service = new WritebackService({
      playlists: playlists as never,
      library: {
        list: async () => library,
        getById: async (id: number) => library.find((s) => s.id === id) ?? null,
      },
      store: {
        load: async () => snapshot,
        save: async (s) => {
          snapshot = s;
        },
      },
      getWriteApi: async () => ({
        love: async (artist: string, title: string) => {
          calls.push({ kind: "love", artist, title });
        },
        unlove: async (artist: string, title: string) => {
          calls.push({ kind: "unlove", artist, title });
        },
      }),
      withLock: async (fn) => ({ skipped: false as const, result: await fn() }),
      sleep: async () => {},
      echoDrainMs: 0,
    });

    // Round 1：LFM 取消 Two + 新红心 Three；内层不完整 → 跳过 add、抑制 remove
    const r1 = await service.reconcileFavorites({
      scrobbler: {
        getLovedTracks: async () => ({
          tracks: [
            { artist: "A", title: "One" },
            { artist: "C", title: "Three" },
            { artist: "F", title: "Six" },
          ],
          truncated: false,
        }),
      },
      username: "u",
      hardCap: 1000,
      now: 100,
    });
    expect(r1.ok).toBe(true);
    expect(r1.added).toBe(0);
    expect(r1.removed).toBe(0);
    expect(addCalls).toEqual([]);
    expect(removeCalls).toEqual([]);
    expect(r1.snapshot?.favoriteIds.sort()).toEqual([1, 2, 6]);
    expect(r1.snapshot?.lovedKeys || []).toContain("at:b\u0000two");
    expect(r1.snapshot?.lovedKeys || []).not.toContain("at:c\u0000three");
    expect(r1.snapshot?.songKeys?.["3"]).toBeUndefined();

    // Round 2：完整 → 延后的 add 3 / remove 2 必须真正执行
    phase = "converge";
    listingRound = 0;
    const r2 = await service.reconcileFavorites({
      scrobbler: {
        getLovedTracks: async () => ({
          tracks: [
            { artist: "A", title: "One" },
            { artist: "C", title: "Three" },
            { artist: "F", title: "Six" },
          ],
          truncated: false,
        }),
      },
      username: "u",
      hardCap: 1000,
      now: 200,
    });
    expect(r2.ok).toBe(true);
    expect(addCalls).toEqual([[3]]);
    expect(removeCalls).toEqual([[2]]);
    expect(r2.added).toBe(1);
    expect(r2.removed).toBe(1);
    expect(r2.snapshot?.favoriteIds.sort()).toEqual([1, 3, 6].sort());
    expect(r2.snapshot?.lovedKeys || []).toContain("at:c\u0000three");
    expect(r2.snapshot?.lovedKeys || []).not.toContain("at:b\u0000two");

    // Round 3：用新红心 Seven 触发内层读；窗口内删 6（LFM 仍爱）+ 加 5（LFM 未爱）
    phase = "window";
    listingRound = 0;
    addCalls.length = 0;
    removeCalls.length = 0;
    calls.length = 0;
    const r3 = await service.reconcileFavorites({
      scrobbler: {
        getLovedTracks: async () => ({
          tracks: [
            { artist: "A", title: "One" },
            { artist: "C", title: "Three" },
            { artist: "F", title: "Six" },
            { artist: "G", title: "Seven" },
          ],
          truncated: false,
        }),
      },
      username: "u",
      hardCap: 1000,
      now: 300,
    });
    expect(r3.ok).toBe(true);
    expect(addCalls.some((c) => c.includes(7))).toBe(true);
    expect(calls.some((c) => c.kind === "love" && c.title === "Five")).toBe(true);
    expect(calls.some((c) => c.kind === "unlove" && c.title === "Six")).toBe(true);
    expect(r3.snapshot?.favoriteIds).toContain(5);
    expect(r3.snapshot?.favoriteIds).toContain(7);
    expect(r3.snapshot?.favoriteIds).not.toContain(6);
    // P2-c：窗口 love/unlove 以 songKeys 记账；lovedKeys 等 Loved 读取确认。
    expect(r3.snapshot?.songKeys?.["5"]).toBe("at:e\u0000five");
    expect(r3.snapshot?.lovedKeys || []).not.toContain("at:e\u0000five");
    expect(r3.snapshot?.lovedKeys || []).toContain("at:f\u0000six");
    expect(playlistSongs).toContain(5);
    expect(playlistSongs).not.toContain(6);
  });

  it("unloves window-removed mbid track via songKeys fallback (P2-a)", async () => {
    // 曲库 3 首；起点 favoriteIds=[1,2]；lovedKeys 含 at: 与 mbid:；内层前删 2 → 必须 unlove。
    const favoritesId = 42;
    const mbidTwo = "11111111-1111-1111-1111-111111111111";
    const library = [song(1, "A", "One"), song(2, "B", "Two"), song(3, "C", "Three")];
    const playlistSongs = [1, 2];
    let listingRound = 0;
    const calls: Array<{ kind: string; artist: string; title: string }> = [];
    let snapshot: WritebackSnapshot = {
      ts: 1,
      lovedKeys: ["at:a\u0000one", `mbid:${mbidTwo}`],
      favoriteIds: [1, 2],
      songKeys: { "1": "at:a\u0000one", "2": `mbid:${mbidTwo}` },
    };
    const playlists = {
      async list(): Promise<Playlist[]> {
        return [
          {
            id: favoritesId,
            type: "normal",
            name: "收藏",
            description: "",
            cover_url: "",
            labels: ["built_in"],
            song_count: playlistSongs.length,
            created_at: "",
            updated_at: "",
            sort_by: "position",
            sort_order: "asc",
          },
        ];
      },
      async getSongs(
        _playlistId: number,
        opts?: { limit?: number; offset?: number }
      ): Promise<Song[]> {
        const offset = opts?.offset ?? 0;
        if (offset === 0) {
          listingRound += 1;
          if (listingRound === 2) {
            const i = playlistSongs.indexOf(2);
            if (i >= 0) playlistSongs.splice(i, 1);
          }
        }
        const limit = opts?.limit ?? 500;
        return playlistSongs
          .slice(offset, offset + limit)
          .map((id) => library.find((s) => s.id === id)!);
      },
      async addSongs(_playlistId: number, ids: number[]) {
        for (const id of ids) if (!playlistSongs.includes(id)) playlistSongs.push(id);
        return { added: ids.length, skipped: 0 };
      },
      async removeSongs(_playlistId: number, ids: number[]) {
        for (const id of ids) {
          const i = playlistSongs.indexOf(id);
          if (i >= 0) playlistSongs.splice(i, 1);
        }
      },
    };
    const service = new WritebackService({
      playlists: playlists as never,
      library: {
        list: async () => library,
        getById: async (id: number) => library.find((s) => s.id === id) ?? null,
      },
      store: {
        load: async () => snapshot,
        save: async (s) => {
          snapshot = s;
        },
      },
      getWriteApi: async () => ({
        love: async (artist: string, title: string) => {
          calls.push({ kind: "love", artist, title });
        },
        unlove: async (artist: string, title: string) => {
          calls.push({ kind: "unlove", artist, title });
        },
      }),
      withLock: async (fn) => ({ skipped: false as const, result: await fn() }),
      sleep: async () => {},
      echoDrainMs: 0,
    });

    const r1 = await service.reconcileFavorites({
      scrobbler: {
        getLovedTracks: async () => ({
          tracks: [
            { artist: "A", title: "One" },
            { artist: "B", title: "Two", mbid: mbidTwo },
            { artist: "C", title: "Three" },
          ],
          truncated: false,
        }),
      },
      username: "u",
      hardCap: 1000,
      now: 100,
    });
    expect(r1.ok).toBe(true);
    expect(calls.some((c) => c.kind === "unlove" && c.title === "Two")).toBe(true);
    expect(r1.unlovedCount).toBeGreaterThanOrEqual(1);
    expect(playlistSongs).not.toContain(2);
    expect(r1.snapshot?.favoriteIds).not.toContain(2);

    // 后续完整轮不得再重复 unlove
    calls.length = 0;
    listingRound = 0;
    const r2 = await service.reconcileFavorites({
      scrobbler: {
        getLovedTracks: async () => ({
          tracks: [
            { artist: "A", title: "One" },
            { artist: "C", title: "Three" },
          ],
          truncated: false,
        }),
      },
      username: "u",
      hardCap: 1000,
      now: 200,
    });
    expect(r2.ok).toBe(true);
    expect(calls.filter((c) => c.kind === "unlove")).toEqual([]);
  });

  it("reason omits forward-fill claim when incomplete and nothing to add (P3-1)", async () => {
    // 外层与内层都不完整、无待加、added=0 → 不得声称「仅做正向补齐」。
    const favoritesId = 42;
    const library = [song(1, "A", "One"), song(2, "B", "Two")];
    const playlistSongs = [1, 2];
    let snapshot: WritebackSnapshot = {
      ts: 1,
      lovedKeys: ["at:a\u0000one", "at:b\u0000two"],
      favoriteIds: [1, 2],
      songKeys: { "1": "at:a\u0000one", "2": "at:b\u0000two" },
    };
    const playlists = {
      async list(): Promise<Playlist[]> {
        return [
          {
            id: favoritesId,
            type: "normal",
            name: "收藏",
            description: "",
            cover_url: "",
            labels: ["built_in"],
            song_count: playlistSongs.length,
            created_at: "",
            updated_at: "",
            sort_by: "position",
            sort_order: "asc",
          },
        ];
      },
      async getSongs(_playlistId: number): Promise<Song[]> {
        const page = playlistSongs.map((id) => library.find((s) => s.id === id)!);
        while (page.length < 500) page.push(song(page[0]?.id ?? 1, "", ""));
        return page;
      },
      async addSongs(_playlistId: number, ids: number[]) {
        for (const id of ids) if (!playlistSongs.includes(id)) playlistSongs.push(id);
        return { added: ids.length, skipped: 0 };
      },
      async removeSongs(_playlistId: number, ids: number[]) {
        for (const id of ids) {
          const i = playlistSongs.indexOf(id);
          if (i >= 0) playlistSongs.splice(i, 1);
        }
      },
    };
    const service = new WritebackService({
      playlists: playlists as never,
      library: {
        list: async () => library,
        getById: async (id: number) => library.find((s) => s.id === id) ?? null,
      },
      store: {
        load: async () => snapshot,
        save: async (s) => {
          snapshot = s;
        },
      },
      getWriteApi: async () => ({ love: async () => {}, unlove: async () => {} }),
      withLock: async (fn) => ({ skipped: false as const, result: await fn() }),
      sleep: async () => {},
      echoDrainMs: 0,
    });

    const result = await service.reconcileFavorites({
      scrobbler: {
        getLovedTracks: async () => ({
          tracks: [
            { artist: "A", title: "One" },
            { artist: "B", title: "Two" },
          ],
          truncated: false,
        }),
      },
      username: "u",
      hardCap: 1000,
      now: 100,
    });
    expect(result.ok).toBe(true);
    expect(result.added).toBe(0);
    expect(result.removalsSuppressed).toBe(true);
    expect(result.reason || "").toContain("已跳过删除与 unlove");
    expect(result.reason || "").not.toContain("仅做正向补齐");
  });

  it("keeps window-loved track when next Loved read lags (P2-c love)", async () => {
    // 窗口内 love 后下一轮 Loved 尚未包含该曲 → 不得 removeSongs 掉用户刚收藏的歌。
    const favoritesId = 42;
    const library = [song(1, "A", "One"), song(2, "B", "Two"), song(3, "C", "Three")];
    const playlistSongs = [1];
    let listingRound = 0;
    const removeCalls: number[][] = [];
    const calls: Array<{ kind: string; artist: string; title: string }> = [];
    let snapshot: WritebackSnapshot = {
      ts: 1,
      lovedKeys: ["at:a\u0000one"],
      favoriteIds: [1],
      songKeys: { "1": "at:a\u0000one" },
    };
    const playlists = {
      async list(): Promise<Playlist[]> {
        return [
          {
            id: favoritesId,
            type: "normal",
            name: "收藏",
            description: "",
            cover_url: "",
            labels: ["built_in"],
            song_count: playlistSongs.length,
            created_at: "",
            updated_at: "",
            sort_by: "position",
            sort_order: "asc",
          },
        ];
      },
      async getSongs(
        _playlistId: number,
        opts?: { limit?: number; offset?: number }
      ): Promise<Song[]> {
        const offset = opts?.offset ?? 0;
        if (offset === 0) {
          listingRound += 1;
          if (listingRound === 2 && !playlistSongs.includes(2)) playlistSongs.push(2);
        }
        const limit = opts?.limit ?? 500;
        return playlistSongs
          .slice(offset, offset + limit)
          .map((id) => library.find((s) => s.id === id)!);
      },
      async addSongs(_playlistId: number, ids: number[]) {
        for (const id of ids) if (!playlistSongs.includes(id)) playlistSongs.push(id);
        return { added: ids.length, skipped: 0 };
      },
      async removeSongs(_playlistId: number, ids: number[]) {
        removeCalls.push([...ids]);
        for (const id of ids) {
          const i = playlistSongs.indexOf(id);
          if (i >= 0) playlistSongs.splice(i, 1);
        }
      },
    };
    const service = new WritebackService({
      playlists: playlists as never,
      library: {
        list: async () => library,
        getById: async (id: number) => library.find((s) => s.id === id) ?? null,
      },
      store: {
        load: async () => snapshot,
        save: async (s) => {
          snapshot = s;
        },
      },
      getWriteApi: async () => ({
        love: async (artist: string, title: string) => {
          calls.push({ kind: "love", artist, title });
        },
        unlove: async (artist: string, title: string) => {
          calls.push({ kind: "unlove", artist, title });
        },
      }),
      withLock: async (fn) => ({ skipped: false as const, result: await fn() }),
      sleep: async () => {},
      echoDrainMs: 0,
    });

    const r1 = await service.reconcileFavorites({
      scrobbler: {
        getLovedTracks: async () => ({
          tracks: [
            { artist: "A", title: "One" },
            { artist: "C", title: "Three" },
          ],
          truncated: false,
        }),
      },
      username: "u",
      hardCap: 1000,
      now: 100,
    });
    expect(r1.ok).toBe(true);
    expect(calls.some((c) => c.kind === "love" && c.title === "Two")).toBe(true);
    expect(playlistSongs).toContain(2);

    // 下一轮 Loved 仍滞后（不含 Two）
    listingRound = 0;
    removeCalls.length = 0;
    const r2 = await service.reconcileFavorites({
      scrobbler: {
        getLovedTracks: async () => ({
          tracks: [
            { artist: "A", title: "One" },
            { artist: "C", title: "Three" },
          ],
          truncated: false,
        }),
      },
      username: "u",
      hardCap: 1000,
      now: 200,
    });
    expect(r2.ok).toBe(true);
    expect(removeCalls.some((c) => c.includes(2))).toBe(false);
    expect(playlistSongs).toContain(2);
    expect(r2.snapshot?.favoriteIds).toContain(2);
  });

  it("does not re-add window-unloved track when next Loved read lags (P2-c unlove)", async () => {
    // 窗口内 unlove 后下一轮 Loved 仍含该曲 → 不得 addSongs 把用户刚删的歌加回。
    const favoritesId = 42;
    const library = [song(1, "A", "One"), song(2, "B", "Two"), song(3, "C", "Three")];
    const playlistSongs = [1, 2];
    let listingRound = 0;
    const addCalls: number[][] = [];
    const calls: Array<{ kind: string; artist: string; title: string }> = [];
    let snapshot: WritebackSnapshot = {
      ts: 1,
      lovedKeys: ["at:a\u0000one", "at:b\u0000two"],
      favoriteIds: [1, 2],
      songKeys: { "1": "at:a\u0000one", "2": "at:b\u0000two" },
    };
    const playlists = {
      async list(): Promise<Playlist[]> {
        return [
          {
            id: favoritesId,
            type: "normal",
            name: "收藏",
            description: "",
            cover_url: "",
            labels: ["built_in"],
            song_count: playlistSongs.length,
            created_at: "",
            updated_at: "",
            sort_by: "position",
            sort_order: "asc",
          },
        ];
      },
      async getSongs(
        _playlistId: number,
        opts?: { limit?: number; offset?: number }
      ): Promise<Song[]> {
        const offset = opts?.offset ?? 0;
        if (offset === 0) {
          listingRound += 1;
          if (listingRound === 2) {
            const i = playlistSongs.indexOf(2);
            if (i >= 0) playlistSongs.splice(i, 1);
          }
        }
        const limit = opts?.limit ?? 500;
        return playlistSongs
          .slice(offset, offset + limit)
          .map((id) => library.find((s) => s.id === id)!);
      },
      async addSongs(_playlistId: number, ids: number[]) {
        addCalls.push([...ids]);
        for (const id of ids) if (!playlistSongs.includes(id)) playlistSongs.push(id);
        return { added: ids.length, skipped: 0 };
      },
      async removeSongs(_playlistId: number, ids: number[]) {
        for (const id of ids) {
          const i = playlistSongs.indexOf(id);
          if (i >= 0) playlistSongs.splice(i, 1);
        }
      },
    };
    const service = new WritebackService({
      playlists: playlists as never,
      library: {
        list: async () => library,
        getById: async (id: number) => library.find((s) => s.id === id) ?? null,
      },
      store: {
        load: async () => snapshot,
        save: async (s) => {
          snapshot = s;
        },
      },
      getWriteApi: async () => ({
        love: async (artist: string, title: string) => {
          calls.push({ kind: "love", artist, title });
        },
        unlove: async (artist: string, title: string) => {
          calls.push({ kind: "unlove", artist, title });
        },
      }),
      withLock: async (fn) => ({ skipped: false as const, result: await fn() }),
      sleep: async () => {},
      echoDrainMs: 0,
    });

    const r1 = await service.reconcileFavorites({
      scrobbler: {
        getLovedTracks: async () => ({
          tracks: [
            { artist: "A", title: "One" },
            { artist: "B", title: "Two" },
            { artist: "C", title: "Three" },
          ],
          truncated: false,
        }),
      },
      username: "u",
      hardCap: 1000,
      now: 100,
    });
    expect(r1.ok).toBe(true);
    expect(calls.some((c) => c.kind === "unlove" && c.title === "Two")).toBe(true);
    expect(playlistSongs).not.toContain(2);

    listingRound = 0;
    addCalls.length = 0;
    const r2 = await service.reconcileFavorites({
      scrobbler: {
        getLovedTracks: async () => ({
          tracks: [
            { artist: "A", title: "One" },
            { artist: "B", title: "Two" },
            { artist: "C", title: "Three" },
          ],
          truncated: false,
        }),
      },
      username: "u",
      hardCap: 1000,
      now: 200,
    });
    expect(r2.ok).toBe(true);
    expect(addCalls.some((c) => c.includes(2))).toBe(false);
    expect(playlistSongs).not.toContain(2);
    expect(r2.snapshot?.favoriteIds).not.toContain(2);
  });

  it("unloves window delete deferred from unsafe truncated round (P2-b)", async () => {
    // Loved 截断轮发生窗口删除 → 本轮不得 unlove；随后安全完整轮必须补 unlove，再下一轮不再抖动。
    const favoritesId = 42;
    const library = [song(1, "A", "One"), song(2, "B", "Two"), song(3, "C", "Three")];
    const playlistSongs = [1, 2];
    let listingRound = 0;
    let lovedTruncated = true;
    const calls: Array<{ kind: string; artist: string; title: string }> = [];
    let snapshot: WritebackSnapshot = {
      ts: 1,
      lovedKeys: ["at:a\u0000one", "at:b\u0000two"],
      favoriteIds: [1, 2],
      songKeys: { "1": "at:a\u0000one", "2": "at:b\u0000two" },
    };
    const playlists = {
      async list(): Promise<Playlist[]> {
        return [
          {
            id: favoritesId,
            type: "normal",
            name: "收藏",
            description: "",
            cover_url: "",
            labels: ["built_in"],
            song_count: playlistSongs.length,
            created_at: "",
            updated_at: "",
            sort_by: "position",
            sort_order: "asc",
          },
        ];
      },
      async getSongs(
        _playlistId: number,
        opts?: { limit?: number; offset?: number }
      ): Promise<Song[]> {
        const offset = opts?.offset ?? 0;
        if (offset === 0) {
          listingRound += 1;
          if (lovedTruncated && listingRound === 2) {
            const i = playlistSongs.indexOf(2);
            if (i >= 0) playlistSongs.splice(i, 1);
          }
        }
        const limit = opts?.limit ?? 500;
        return playlistSongs
          .slice(offset, offset + limit)
          .map((id) => library.find((s) => s.id === id)!);
      },
      async addSongs(_playlistId: number, ids: number[]) {
        for (const id of ids) if (!playlistSongs.includes(id)) playlistSongs.push(id);
        return { added: ids.length, skipped: 0 };
      },
      async removeSongs(_playlistId: number, ids: number[]) {
        for (const id of ids) {
          const i = playlistSongs.indexOf(id);
          if (i >= 0) playlistSongs.splice(i, 1);
        }
      },
    };
    const service = new WritebackService({
      playlists: playlists as never,
      library: {
        list: async () => library,
        getById: async (id: number) => library.find((s) => s.id === id) ?? null,
      },
      store: {
        load: async () => snapshot,
        save: async (s) => {
          snapshot = s;
        },
      },
      getWriteApi: async () => ({
        love: async (artist: string, title: string) => {
          calls.push({ kind: "love", artist, title });
        },
        unlove: async (artist: string, title: string) => {
          calls.push({ kind: "unlove", artist, title });
        },
      }),
      withLock: async (fn) => ({ skipped: false as const, result: await fn() }),
      sleep: async () => {},
      echoDrainMs: 0,
    });

    const r1 = await service.reconcileFavorites({
      scrobbler: {
        getLovedTracks: async () => ({
          tracks: [
            { artist: "A", title: "One" },
            { artist: "B", title: "Two" },
            { artist: "C", title: "Three" },
          ],
          truncated: true,
        }),
      },
      username: "u",
      hardCap: 1000,
      now: 100,
    });
    expect(r1.ok).toBe(true);
    expect(r1.removalsSuppressed).toBe(true);
    expect(calls.filter((c) => c.kind === "unlove")).toEqual([]);
    expect(playlistSongs).not.toContain(2);
    // 起点必须留下 2，供下一安全轮补 unlove
    expect(r1.snapshot?.favoriteIds).toContain(2);
    expect(r1.snapshot?.lovedKeys || []).toContain("at:b\u0000two");

    lovedTruncated = false;
    listingRound = 0;
    calls.length = 0;
    const r2 = await service.reconcileFavorites({
      scrobbler: {
        getLovedTracks: async () => ({
          tracks: [
            { artist: "A", title: "One" },
            { artist: "B", title: "Two" },
            { artist: "C", title: "Three" },
          ],
          truncated: false,
        }),
      },
      username: "u",
      hardCap: 1000,
      now: 200,
    });
    expect(r2.ok).toBe(true);
    expect(calls.some((c) => c.kind === "unlove" && c.title === "Two")).toBe(true);
    expect(r2.snapshot?.favoriteIds).not.toContain(2);

    listingRound = 0;
    calls.length = 0;
    const r3 = await service.reconcileFavorites({
      scrobbler: {
        getLovedTracks: async () => ({
          tracks: [
            { artist: "A", title: "One" },
            { artist: "C", title: "Three" },
          ],
          truncated: false,
        }),
      },
      username: "u",
      hardCap: 1000,
      now: 300,
    });
    expect(r3.ok).toBe(true);
    expect(calls.filter((c) => c.kind === "unlove")).toEqual([]);
    expect(r3.snapshot?.favoriteIds).not.toContain(2);
  });

  it("stays stable across truncated then safe rounds when no window delete (P2-b control)", async () => {
    const favoritesId = 42;
    const library = [song(1, "A", "One"), song(2, "B", "Two"), song(3, "C", "Three")];
    const playlistSongs = [1, 2];
    const calls: Array<{ kind: string; artist: string; title: string }> = [];
    let snapshot: WritebackSnapshot = {
      ts: 1,
      lovedKeys: ["at:a\u0000one", "at:b\u0000two"],
      favoriteIds: [1, 2],
      songKeys: { "1": "at:a\u0000one", "2": "at:b\u0000two" },
    };
    const playlists = {
      async list(): Promise<Playlist[]> {
        return [
          {
            id: favoritesId,
            type: "normal",
            name: "收藏",
            description: "",
            cover_url: "",
            labels: ["built_in"],
            song_count: playlistSongs.length,
            created_at: "",
            updated_at: "",
            sort_by: "position",
            sort_order: "asc",
          },
        ];
      },
      async getSongs(
        _playlistId: number,
        opts?: { limit?: number; offset?: number }
      ): Promise<Song[]> {
        const offset = opts?.offset ?? 0;
        const limit = opts?.limit ?? 500;
        return playlistSongs
          .slice(offset, offset + limit)
          .map((id) => library.find((s) => s.id === id)!);
      },
      async addSongs(_playlistId: number, ids: number[]) {
        for (const id of ids) if (!playlistSongs.includes(id)) playlistSongs.push(id);
        return { added: ids.length, skipped: 0 };
      },
      async removeSongs(_playlistId: number, ids: number[]) {
        for (const id of ids) {
          const i = playlistSongs.indexOf(id);
          if (i >= 0) playlistSongs.splice(i, 1);
        }
      },
    };
    const service = new WritebackService({
      playlists: playlists as never,
      library: {
        list: async () => library,
        getById: async (id: number) => library.find((s) => s.id === id) ?? null,
      },
      store: {
        load: async () => snapshot,
        save: async (s) => {
          snapshot = s;
        },
      },
      getWriteApi: async () => ({
        love: async (artist: string, title: string) => {
          calls.push({ kind: "love", artist, title });
        },
        unlove: async (artist: string, title: string) => {
          calls.push({ kind: "unlove", artist, title });
        },
      }),
      withLock: async (fn) => ({ skipped: false as const, result: await fn() }),
      sleep: async () => {},
      echoDrainMs: 0,
    });

    const r1 = await service.reconcileFavorites({
      scrobbler: {
        getLovedTracks: async () => ({
          tracks: [
            { artist: "A", title: "One" },
            { artist: "B", title: "Two" },
            { artist: "C", title: "Three" },
          ],
          truncated: true,
        }),
      },
      username: "u",
      hardCap: 1000,
      now: 100,
    });
    expect(r1.ok).toBe(true);
    expect(calls.filter((c) => c.kind === "unlove")).toEqual([]);

    calls.length = 0;
    const r2 = await service.reconcileFavorites({
      scrobbler: {
        getLovedTracks: async () => ({
          tracks: [
            { artist: "A", title: "One" },
            { artist: "B", title: "Two" },
            { artist: "C", title: "Three" },
          ],
          truncated: false,
        }),
      },
      username: "u",
      hardCap: 1000,
      now: 200,
    });
    expect(r2.ok).toBe(true);
    expect(calls.filter((c) => c.kind === "unlove" && c.title === "Two")).toEqual([]);
    expect(r2.snapshot?.favoriteIds.sort()).toEqual([1, 2, 3].sort());
    expect(playlistSongs.sort()).toEqual([1, 2, 3].sort());
  });

  it("does not re-add window-removed track already cancelled on Last.fm after unsafe round (P2-b control)", async () => {
    // 窗口内用户删了且远端也已取消 → 不得被加回收藏。
    const favoritesId = 42;
    const library = [song(1, "A", "One"), song(2, "B", "Two"), song(3, "C", "Three")];
    const playlistSongs = [1, 2];
    let listingRound = 0;
    let lovedTruncated = true;
    const addCalls: number[][] = [];
    let snapshot: WritebackSnapshot = {
      ts: 1,
      lovedKeys: ["at:a\u0000one", "at:b\u0000two"],
      favoriteIds: [1, 2],
      songKeys: { "1": "at:a\u0000one", "2": "at:b\u0000two" },
    };
    const playlists = {
      async list(): Promise<Playlist[]> {
        return [
          {
            id: favoritesId,
            type: "normal",
            name: "收藏",
            description: "",
            cover_url: "",
            labels: ["built_in"],
            song_count: playlistSongs.length,
            created_at: "",
            updated_at: "",
            sort_by: "position",
            sort_order: "asc",
          },
        ];
      },
      async getSongs(
        _playlistId: number,
        opts?: { limit?: number; offset?: number }
      ): Promise<Song[]> {
        const offset = opts?.offset ?? 0;
        if (offset === 0) {
          listingRound += 1;
          if (lovedTruncated && listingRound === 2) {
            const i = playlistSongs.indexOf(2);
            if (i >= 0) playlistSongs.splice(i, 1);
          }
        }
        const limit = opts?.limit ?? 500;
        return playlistSongs
          .slice(offset, offset + limit)
          .map((id) => library.find((s) => s.id === id)!);
      },
      async addSongs(_playlistId: number, ids: number[]) {
        addCalls.push([...ids]);
        for (const id of ids) if (!playlistSongs.includes(id)) playlistSongs.push(id);
        return { added: ids.length, skipped: 0 };
      },
      async removeSongs(_playlistId: number, ids: number[]) {
        for (const id of ids) {
          const i = playlistSongs.indexOf(id);
          if (i >= 0) playlistSongs.splice(i, 1);
        }
      },
    };
    const service = new WritebackService({
      playlists: playlists as never,
      library: {
        list: async () => library,
        getById: async (id: number) => library.find((s) => s.id === id) ?? null,
      },
      store: {
        load: async () => snapshot,
        save: async (s) => {
          snapshot = s;
        },
      },
      getWriteApi: async () => ({ love: async () => {}, unlove: async () => {} }),
      withLock: async (fn) => ({ skipped: false as const, result: await fn() }),
      sleep: async () => {},
      echoDrainMs: 0,
    });

    // r1：截断 + 窗口删 2；Loved 本轮已不含 Two（远端也取消）。
    // unsafe 会把 prev lovedKeys 并进 next，P2-b 可能暂留起点；关键是后续不得加回收藏。
    const r1 = await service.reconcileFavorites({
      scrobbler: {
        getLovedTracks: async () => ({
          tracks: [
            { artist: "A", title: "One" },
            { artist: "C", title: "Three" },
          ],
          truncated: true,
        }),
      },
      username: "u",
      hardCap: 1000,
      now: 100,
    });
    expect(r1.ok).toBe(true);
    expect(playlistSongs).not.toContain(2);
    expect(addCalls.some((c) => c.includes(2))).toBe(false);

    lovedTruncated = false;
    listingRound = 0;
    addCalls.length = 0;
    const r2 = await service.reconcileFavorites({
      scrobbler: {
        getLovedTracks: async () => ({
          tracks: [
            { artist: "A", title: "One" },
            { artist: "C", title: "Three" },
          ],
          truncated: false,
        }),
      },
      username: "u",
      hardCap: 1000,
      now: 200,
    });
    expect(r2.ok).toBe(true);
    expect(addCalls.some((c) => c.includes(2))).toBe(false);
    expect(playlistSongs).not.toContain(2);
    expect(r2.snapshot?.favoriteIds).not.toContain(2);

    listingRound = 0;
    addCalls.length = 0;
    const r3 = await service.reconcileFavorites({
      scrobbler: {
        getLovedTracks: async () => ({
          tracks: [
            { artist: "A", title: "One" },
            { artist: "C", title: "Three" },
          ],
          truncated: false,
        }),
      },
      username: "u",
      hardCap: 1000,
      now: 300,
    });
    expect(r3.ok).toBe(true);
    expect(addCalls.some((c) => c.includes(2))).toBe(false);
    expect(playlistSongs).not.toContain(2);
    expect(r3.snapshot?.favoriteIds).not.toContain(2);
  });

  it("keeps plan-loved track when next Loved read lags (P1-新 1 love)", async () => {
    // 主路径 plan.love 后下一轮 Loved 仍不含该曲 → 不得 removeSongs 刚收藏的歌。
    const favoritesId = 42;
    const library = [song(1, "A", "One"), song(2, "B", "Two"), song(3, "C", "Three")];
    const playlistSongs = [1, 2];
    const removeCalls: number[][] = [];
    const calls: Array<{ kind: string; artist: string; title: string }> = [];
    let snapshot: WritebackSnapshot = {
      ts: 1,
      lovedKeys: ["at:a\u0000one"],
      favoriteIds: [1],
      songKeys: { "1": "at:a\u0000one" },
    };
    const playlists = {
      async list(): Promise<Playlist[]> {
        return [
          {
            id: favoritesId,
            type: "normal",
            name: "收藏",
            description: "",
            cover_url: "",
            labels: ["built_in"],
            song_count: playlistSongs.length,
            created_at: "",
            updated_at: "",
            sort_by: "position",
            sort_order: "asc",
          },
        ];
      },
      async getSongs(
        _playlistId: number,
        opts?: { limit?: number; offset?: number }
      ): Promise<Song[]> {
        const offset = opts?.offset ?? 0;
        const limit = opts?.limit ?? 500;
        return playlistSongs
          .slice(offset, offset + limit)
          .map((id) => library.find((s) => s.id === id)!);
      },
      async addSongs(_playlistId: number, ids: number[]) {
        for (const id of ids) if (!playlistSongs.includes(id)) playlistSongs.push(id);
        return { added: ids.length, skipped: 0 };
      },
      async removeSongs(_playlistId: number, ids: number[]) {
        removeCalls.push([...ids]);
        for (const id of ids) {
          const i = playlistSongs.indexOf(id);
          if (i >= 0) playlistSongs.splice(i, 1);
        }
      },
    };
    const service = new WritebackService({
      playlists: playlists as never,
      library: {
        list: async () => library,
        getById: async (id: number) => library.find((s) => s.id === id) ?? null,
      },
      store: {
        load: async () => snapshot,
        save: async (s) => {
          snapshot = s;
        },
      },
      getWriteApi: async () => ({
        love: async (artist: string, title: string) => {
          calls.push({ kind: "love", artist, title });
        },
        unlove: async (artist: string, title: string) => {
          calls.push({ kind: "unlove", artist, title });
        },
      }),
      withLock: async (fn) => ({ skipped: false as const, result: await fn() }),
      sleep: async () => {},
      echoDrainMs: 0,
    });

    const laggingLoved = {
      getLovedTracks: async () => ({
        tracks: [
          { artist: "A", title: "One" },
          { artist: "C", title: "Three" },
        ],
        truncated: false,
      }),
    };
    const r1 = await service.reconcileFavorites({
      scrobbler: laggingLoved,
      username: "u",
      hardCap: 1000,
      now: 100,
    });
    expect(r1.ok).toBe(true);
    expect(calls.some((c) => c.kind === "love" && c.title === "Two")).toBe(true);
    expect(r1.snapshot?.songKeys?.["2"]).toBe("at:b\u0000two");
    expect(r1.snapshot?.lovedKeys || []).not.toContain("at:b\u0000two");
    expect(playlistSongs).toContain(2);

    removeCalls.length = 0;
    const r2 = await service.reconcileFavorites({
      scrobbler: laggingLoved,
      username: "u",
      hardCap: 1000,
      now: 200,
    });
    expect(r2.ok).toBe(true);
    expect(removeCalls.some((c) => c.includes(2))).toBe(false);
    expect(playlistSongs).toContain(2);
    expect(r2.snapshot?.favoriteIds).toContain(2);
  });

  it("does not re-add plan-unloved track when next Loved read lags (P1-新 1 unlove)", async () => {
    // 主路径 plan.unlove 后下一轮 Loved 仍含该曲 → 不得 addSongs 把刚取消的歌加回。
    const favoritesId = 42;
    const library = [song(1, "A", "One"), song(2, "B", "Two"), song(3, "C", "Three")];
    const playlistSongs = [1];
    const addCalls: number[][] = [];
    const calls: Array<{ kind: string; artist: string; title: string }> = [];
    let snapshot: WritebackSnapshot = {
      ts: 1,
      lovedKeys: ["at:a\u0000one", "at:b\u0000two"],
      favoriteIds: [1, 2],
      songKeys: { "1": "at:a\u0000one", "2": "at:b\u0000two" },
    };
    const playlists = {
      async list(): Promise<Playlist[]> {
        return [
          {
            id: favoritesId,
            type: "normal",
            name: "收藏",
            description: "",
            cover_url: "",
            labels: ["built_in"],
            song_count: playlistSongs.length,
            created_at: "",
            updated_at: "",
            sort_by: "position",
            sort_order: "asc",
          },
        ];
      },
      async getSongs(
        _playlistId: number,
        opts?: { limit?: number; offset?: number }
      ): Promise<Song[]> {
        const offset = opts?.offset ?? 0;
        const limit = opts?.limit ?? 500;
        return playlistSongs
          .slice(offset, offset + limit)
          .map((id) => library.find((s) => s.id === id)!);
      },
      async addSongs(_playlistId: number, ids: number[]) {
        addCalls.push([...ids]);
        for (const id of ids) if (!playlistSongs.includes(id)) playlistSongs.push(id);
        return { added: ids.length, skipped: 0 };
      },
      async removeSongs(_playlistId: number, ids: number[]) {
        for (const id of ids) {
          const i = playlistSongs.indexOf(id);
          if (i >= 0) playlistSongs.splice(i, 1);
        }
      },
    };
    const service = new WritebackService({
      playlists: playlists as never,
      library: {
        list: async () => library,
        getById: async (id: number) => library.find((s) => s.id === id) ?? null,
      },
      store: {
        load: async () => snapshot,
        save: async (s) => {
          snapshot = s;
        },
      },
      getWriteApi: async () => ({
        love: async (artist: string, title: string) => {
          calls.push({ kind: "love", artist, title });
        },
        unlove: async (artist: string, title: string) => {
          calls.push({ kind: "unlove", artist, title });
        },
      }),
      withLock: async (fn) => ({ skipped: false as const, result: await fn() }),
      sleep: async () => {},
      echoDrainMs: 0,
    });

    const stillLoved = {
      getLovedTracks: async () => ({
        tracks: [
          { artist: "A", title: "One" },
          { artist: "B", title: "Two" },
          { artist: "C", title: "Three" },
        ],
        truncated: false,
      }),
    };
    const r1 = await service.reconcileFavorites({
      scrobbler: stillLoved,
      username: "u",
      hardCap: 1000,
      now: 100,
    });
    expect(r1.ok).toBe(true);
    expect(calls.some((c) => c.kind === "unlove" && c.title === "Two")).toBe(true);
    expect(r1.snapshot?.lovedKeys || []).toContain("at:b\u0000two");
    expect(playlistSongs).not.toContain(2);

    addCalls.length = 0;
    const r2 = await service.reconcileFavorites({
      scrobbler: stillLoved,
      username: "u",
      hardCap: 1000,
      now: 200,
    });
    expect(r2.ok).toBe(true);
    expect(addCalls.some((c) => c.includes(2))).toBe(false);
    expect(playlistSongs).not.toContain(2);
    expect(r2.snapshot?.favoriteIds).not.toContain(2);
  });

  it("keeps plan-loved track when Loved never reflects (P1-新 1 permanent)", async () => {
    // love 成功但 Loved 永久以另一键出现（feat.）→ 收藏必须保持，不得永久删除。
    const favoritesId = 42;
    const library = [song(1, "A", "One"), song(2, "B", "Two"), song(3, "C", "Three")];
    const playlistSongs = [1, 2];
    const removeCalls: number[][] = [];
    let snapshot: WritebackSnapshot = {
      ts: 1,
      lovedKeys: ["at:a\u0000one"],
      favoriteIds: [1],
      songKeys: { "1": "at:a\u0000one" },
    };
    const playlists = {
      async list(): Promise<Playlist[]> {
        return [
          {
            id: favoritesId,
            type: "normal",
            name: "收藏",
            description: "",
            cover_url: "",
            labels: ["built_in"],
            song_count: playlistSongs.length,
            created_at: "",
            updated_at: "",
            sort_by: "position",
            sort_order: "asc",
          },
        ];
      },
      async getSongs(
        _playlistId: number,
        opts?: { limit?: number; offset?: number }
      ): Promise<Song[]> {
        const offset = opts?.offset ?? 0;
        const limit = opts?.limit ?? 500;
        return playlistSongs
          .slice(offset, offset + limit)
          .map((id) => library.find((s) => s.id === id)!);
      },
      async addSongs(_playlistId: number, ids: number[]) {
        for (const id of ids) if (!playlistSongs.includes(id)) playlistSongs.push(id);
        return { added: ids.length, skipped: 0 };
      },
      async removeSongs(_playlistId: number, ids: number[]) {
        removeCalls.push([...ids]);
        for (const id of ids) {
          const i = playlistSongs.indexOf(id);
          if (i >= 0) playlistSongs.splice(i, 1);
        }
      },
    };
    const service = new WritebackService({
      playlists: playlists as never,
      library: {
        list: async () => library,
        getById: async (id: number) => library.find((s) => s.id === id) ?? null,
      },
      store: {
        load: async () => snapshot,
        save: async (s) => {
          snapshot = s;
        },
      },
      getWriteApi: async () => ({ love: async () => {}, unlove: async () => {} }),
      withLock: async (fn) => ({ skipped: false as const, result: await fn() }),
      sleep: async () => {},
      echoDrainMs: 0,
    });

    // 永久不反映：读到的是规范化后的 feat. 键，从未出现 at:b\0two。
    const neverReflects = {
      getLovedTracks: async () => ({
        tracks: [
          { artist: "A", title: "One" },
          { artist: "C", title: "Three" },
          { artist: "B feat. X", title: "Two" },
        ],
        truncated: false,
      }),
    };
    for (const now of [100, 200, 300]) {
      removeCalls.length = 0;
      const r = await service.reconcileFavorites({
        scrobbler: neverReflects,
        username: "u",
        hardCap: 1000,
        now,
      });
      expect(r.ok).toBe(true);
      expect(removeCalls.some((c) => c.includes(2))).toBe(false);
      expect(playlistSongs).toContain(2);
      expect(r.snapshot?.favoriteIds).toContain(2);
    }
  });

  it("does not unlove window-removed mbid track when sibling remains (P2-新 1 window)", async () => {
    const favoritesId = 42;
    const mbidTwo = "11111111-1111-1111-1111-111111111111";
    const mbidKey = `mbid:${mbidTwo}`;
    const library = [
      song(1, "A", "One"),
      song(2, "B", "Two"),
      song(5, "B", "Two"),
      song(3, "C", "Three"),
    ];
    const playlistSongs = [1, 2, 5];
    let listingRound = 0;
    const calls: Array<{ kind: string; artist: string; title: string }> = [];
    let snapshot: WritebackSnapshot = {
      ts: 1,
      lovedKeys: ["at:a\u0000one", mbidKey],
      favoriteIds: [1, 2, 5],
      songKeys: { "1": "at:a\u0000one", "2": mbidKey, "5": mbidKey },
    };
    const playlists = {
      async list(): Promise<Playlist[]> {
        return [
          {
            id: favoritesId,
            type: "normal",
            name: "收藏",
            description: "",
            cover_url: "",
            labels: ["built_in"],
            song_count: playlistSongs.length,
            created_at: "",
            updated_at: "",
            sort_by: "position",
            sort_order: "asc",
          },
        ];
      },
      async getSongs(
        _playlistId: number,
        opts?: { limit?: number; offset?: number }
      ): Promise<Song[]> {
        const offset = opts?.offset ?? 0;
        if (offset === 0) {
          listingRound += 1;
          if (listingRound === 2) {
            const i = playlistSongs.indexOf(2);
            if (i >= 0) playlistSongs.splice(i, 1);
          }
        }
        const limit = opts?.limit ?? 500;
        return playlistSongs
          .slice(offset, offset + limit)
          .map((id) => library.find((s) => s.id === id)!);
      },
      async addSongs(_playlistId: number, ids: number[]) {
        for (const id of ids) if (!playlistSongs.includes(id)) playlistSongs.push(id);
        return { added: ids.length, skipped: 0 };
      },
      async removeSongs(_playlistId: number, ids: number[]) {
        for (const id of ids) {
          const i = playlistSongs.indexOf(id);
          if (i >= 0) playlistSongs.splice(i, 1);
        }
      },
    };
    const service = new WritebackService({
      playlists: playlists as never,
      library: {
        list: async () => library,
        getById: async (id: number) => library.find((s) => s.id === id) ?? null,
      },
      store: {
        load: async () => snapshot,
        save: async (s) => {
          snapshot = s;
        },
      },
      getWriteApi: async () => ({
        love: async (artist: string, title: string) => {
          calls.push({ kind: "love", artist, title });
        },
        unlove: async (artist: string, title: string) => {
          calls.push({ kind: "unlove", artist, title });
        },
      }),
      withLock: async (fn) => ({ skipped: false as const, result: await fn() }),
      sleep: async () => {},
      echoDrainMs: 0,
    });

    const r1 = await service.reconcileFavorites({
      scrobbler: {
        getLovedTracks: async () => ({
          tracks: [
            { artist: "A", title: "One" },
            { artist: "B", title: "Two", mbid: mbidTwo },
            { artist: "C", title: "Three" },
          ],
          truncated: false,
        }),
      },
      username: "u",
      hardCap: 1000,
      now: 100,
    });
    expect(r1.ok).toBe(true);
    expect(calls.filter((c) => c.kind === "unlove" && c.title === "Two")).toEqual([]);
    expect(playlistSongs.sort()).toEqual([1, 5, 3].sort());
    expect(r1.snapshot?.favoriteIds.sort()).toEqual([1, 5, 3].sort());
  });

  it("does not unlove window-removed at-key track when sibling remains (P2-新 1 control)", async () => {
    const favoritesId = 42;
    const library = [
      song(1, "A", "One"),
      song(2, "B", "Two"),
      song(5, "B", "Two"),
      song(3, "C", "Three"),
    ];
    const playlistSongs = [1, 2, 5];
    let listingRound = 0;
    const calls: Array<{ kind: string; artist: string; title: string }> = [];
    let snapshot: WritebackSnapshot = {
      ts: 1,
      lovedKeys: ["at:a\u0000one", "at:b\u0000two"],
      favoriteIds: [1, 2, 5],
      songKeys: { "1": "at:a\u0000one", "2": "at:b\u0000two", "5": "at:b\u0000two" },
    };
    const playlists = {
      async list(): Promise<Playlist[]> {
        return [
          {
            id: favoritesId,
            type: "normal",
            name: "收藏",
            description: "",
            cover_url: "",
            labels: ["built_in"],
            song_count: playlistSongs.length,
            created_at: "",
            updated_at: "",
            sort_by: "position",
            sort_order: "asc",
          },
        ];
      },
      async getSongs(
        _playlistId: number,
        opts?: { limit?: number; offset?: number }
      ): Promise<Song[]> {
        const offset = opts?.offset ?? 0;
        if (offset === 0) {
          listingRound += 1;
          if (listingRound === 2) {
            const i = playlistSongs.indexOf(2);
            if (i >= 0) playlistSongs.splice(i, 1);
          }
        }
        const limit = opts?.limit ?? 500;
        return playlistSongs
          .slice(offset, offset + limit)
          .map((id) => library.find((s) => s.id === id)!);
      },
      async addSongs(_playlistId: number, ids: number[]) {
        for (const id of ids) if (!playlistSongs.includes(id)) playlistSongs.push(id);
        return { added: ids.length, skipped: 0 };
      },
      async removeSongs(_playlistId: number, ids: number[]) {
        for (const id of ids) {
          const i = playlistSongs.indexOf(id);
          if (i >= 0) playlistSongs.splice(i, 1);
        }
      },
    };
    const service = new WritebackService({
      playlists: playlists as never,
      library: {
        list: async () => library,
        getById: async (id: number) => library.find((s) => s.id === id) ?? null,
      },
      store: {
        load: async () => snapshot,
        save: async (s) => {
          snapshot = s;
        },
      },
      getWriteApi: async () => ({
        love: async (artist: string, title: string) => {
          calls.push({ kind: "love", artist, title });
        },
        unlove: async (artist: string, title: string) => {
          calls.push({ kind: "unlove", artist, title });
        },
      }),
      withLock: async (fn) => ({ skipped: false as const, result: await fn() }),
      sleep: async () => {},
      echoDrainMs: 0,
    });

    const result = await service.reconcileFavorites({
      scrobbler: {
        getLovedTracks: async () => ({
          tracks: [
            { artist: "A", title: "One" },
            { artist: "B", title: "Two" },
            { artist: "C", title: "Three" },
          ],
          truncated: false,
        }),
      },
      username: "u",
      hardCap: 1000,
      now: 100,
    });
    expect(result.ok).toBe(true);
    expect(calls.filter((c) => c.kind === "unlove" && c.title === "Two")).toEqual([]);
    expect(playlistSongs.sort()).toEqual([1, 5, 3].sort());
  });

  it("does not churn mbid duplicate across unsafe then safe rounds (P2-新 1 + P2-b)", async () => {
    // 截断轮窗口删 mbid 副本之一、另一份仍在 → 本轮与下一安全轮都不得误 unlove，不得加回已删的那份。
    const favoritesId = 42;
    const mbidTwo = "11111111-1111-1111-1111-111111111111";
    const mbidKey = `mbid:${mbidTwo}`;
    const library = [
      song(1, "A", "One"),
      song(2, "B", "Two"),
      song(5, "B", "Two"),
      song(3, "C", "Three"),
    ];
    const playlistSongs = [1, 2, 5];
    let listingRound = 0;
    let lovedTruncated = true;
    const addCalls: number[][] = [];
    const calls: Array<{ kind: string; artist: string; title: string }> = [];
    let snapshot: WritebackSnapshot = {
      ts: 1,
      lovedKeys: ["at:a\u0000one", mbidKey],
      favoriteIds: [1, 2, 5],
      songKeys: { "1": "at:a\u0000one", "2": mbidKey, "5": mbidKey },
    };
    const playlists = {
      async list(): Promise<Playlist[]> {
        return [
          {
            id: favoritesId,
            type: "normal",
            name: "收藏",
            description: "",
            cover_url: "",
            labels: ["built_in"],
            song_count: playlistSongs.length,
            created_at: "",
            updated_at: "",
            sort_by: "position",
            sort_order: "asc",
          },
        ];
      },
      async getSongs(
        _playlistId: number,
        opts?: { limit?: number; offset?: number }
      ): Promise<Song[]> {
        const offset = opts?.offset ?? 0;
        if (offset === 0) {
          listingRound += 1;
          if (lovedTruncated && listingRound === 2) {
            const i = playlistSongs.indexOf(2);
            if (i >= 0) playlistSongs.splice(i, 1);
          }
        }
        const limit = opts?.limit ?? 500;
        return playlistSongs
          .slice(offset, offset + limit)
          .map((id) => library.find((s) => s.id === id)!);
      },
      async addSongs(_playlistId: number, ids: number[]) {
        addCalls.push([...ids]);
        for (const id of ids) if (!playlistSongs.includes(id)) playlistSongs.push(id);
        return { added: ids.length, skipped: 0 };
      },
      async removeSongs(_playlistId: number, ids: number[]) {
        for (const id of ids) {
          const i = playlistSongs.indexOf(id);
          if (i >= 0) playlistSongs.splice(i, 1);
        }
      },
    };
    const service = new WritebackService({
      playlists: playlists as never,
      library: {
        list: async () => library,
        getById: async (id: number) => library.find((s) => s.id === id) ?? null,
      },
      store: {
        load: async () => snapshot,
        save: async (s) => {
          snapshot = s;
        },
      },
      getWriteApi: async () => ({
        love: async (artist: string, title: string) => {
          calls.push({ kind: "love", artist, title });
        },
        unlove: async (artist: string, title: string) => {
          calls.push({ kind: "unlove", artist, title });
        },
      }),
      withLock: async (fn) => ({ skipped: false as const, result: await fn() }),
      sleep: async () => {},
      echoDrainMs: 0,
    });

    const lovedTracks = [
      { artist: "A", title: "One" },
      { artist: "B", title: "Two", mbid: mbidTwo },
      { artist: "C", title: "Three" },
    ];
    const r1 = await service.reconcileFavorites({
      scrobbler: {
        getLovedTracks: async () => ({ tracks: lovedTracks, truncated: true }),
      },
      username: "u",
      hardCap: 1000,
      now: 100,
    });
    expect(r1.ok).toBe(true);
    expect(calls.filter((c) => c.kind === "unlove")).toEqual([]);
    expect(playlistSongs).not.toContain(2);
    expect(playlistSongs).toContain(5);

    lovedTruncated = false;
    listingRound = 0;
    calls.length = 0;
    addCalls.length = 0;
    const r2 = await service.reconcileFavorites({
      scrobbler: {
        getLovedTracks: async () => ({ tracks: lovedTracks, truncated: false }),
      },
      username: "u",
      hardCap: 1000,
      now: 200,
    });
    expect(r2.ok).toBe(true);
    expect(calls.filter((c) => c.kind === "unlove" && c.title === "Two")).toEqual([]);
    expect(addCalls.some((c) => c.includes(2))).toBe(false);
    expect(playlistSongs.sort()).toEqual([1, 5, 3].sort());
    expect(r2.snapshot?.favoriteIds.sort()).toEqual([1, 5, 3].sort());

    listingRound = 0;
    calls.length = 0;
    addCalls.length = 0;
    const r3 = await service.reconcileFavorites({
      scrobbler: {
        getLovedTracks: async () => ({ tracks: lovedTracks, truncated: false }),
      },
      username: "u",
      hardCap: 1000,
      now: 300,
    });
    expect(r3.ok).toBe(true);
    expect(calls.filter((c) => c.kind === "unlove")).toEqual([]);
    expect(addCalls.some((c) => c.includes(2))).toBe(false);
    expect(playlistSongs.sort()).toEqual([1, 5, 3].sort());
    expect(r3.snapshot?.favoriteIds.sort()).toEqual([1, 5, 3].sort());
  });

  it("keeps event-loved re-add when next Loved read lags (P1-新 1a H1)", async () => {
    // 曾被 unlove 且已确认清键后，事件再收藏；Loved 滞后 → 不得 removeSongs。
    const favoritesId = 42;
    const library = [song(1, "A", "One"), song(2, "B", "Two"), song(3, "C", "Three")];
    const playlistSongs = [1, 3];
    const removeCalls: number[][] = [];
    let snapshot: WritebackSnapshot = {
      ts: 1,
      lovedKeys: ["at:a\u0000one", "at:c\u0000three"],
      favoriteIds: [1, 3],
      songKeys: { "1": "at:a\u0000one", "3": "at:c\u0000three" },
    };
    const playlists = {
      async list(): Promise<Playlist[]> {
        return [
          {
            id: favoritesId,
            type: "normal",
            name: "收藏",
            description: "",
            cover_url: "",
            labels: ["built_in"],
            song_count: playlistSongs.length,
            created_at: "",
            updated_at: "",
            sort_by: "position",
            sort_order: "asc",
          },
        ];
      },
      async getSongs(
        _playlistId: number,
        opts?: { limit?: number; offset?: number }
      ): Promise<Song[]> {
        const offset = opts?.offset ?? 0;
        const limit = opts?.limit ?? 500;
        return playlistSongs
          .slice(offset, offset + limit)
          .map((id) => library.find((s) => s.id === id)!);
      },
      async addSongs(_playlistId: number, ids: number[]) {
        for (const id of ids) if (!playlistSongs.includes(id)) playlistSongs.push(id);
        return { added: ids.length, skipped: 0 };
      },
      async removeSongs(_playlistId: number, ids: number[]) {
        removeCalls.push([...ids]);
        for (const id of ids) {
          const i = playlistSongs.indexOf(id);
          if (i >= 0) playlistSongs.splice(i, 1);
        }
      },
    };
    const service = new WritebackService({
      playlists: playlists as never,
      library: {
        list: async () => library,
        getById: async (id: number) => library.find((s) => s.id === id) ?? null,
      },
      store: {
        load: async () => snapshot,
        save: async (s) => {
          snapshot = s;
        },
      },
      getWriteApi: async () => ({
        love: async () => {},
        unlove: async () => {},
      }),
      withLock: async (fn) => ({ skipped: false as const, result: await fn() }),
      sleep: async () => {},
      echoDrainMs: 0,
    });

    playlistSongs.push(2);
    await service.handleEvent(event(2, "add", { playlistId: 42, artist: "B", title: "Two" }));
    await service.drainQueue();
    expect(snapshot.favoriteIds).toContain(2);
    expect(snapshot.lovedKeys || []).not.toContain("at:b\u0000two");
    expect(snapshot.songKeys?.["2"]).toBe("at:b\u0000two");

    removeCalls.length = 0;
    const r = await service.reconcileFavorites({
      scrobbler: {
        getLovedTracks: async () => ({
          tracks: [
            { artist: "A", title: "One" },
            { artist: "C", title: "Three" },
          ],
          truncated: false,
        }),
      },
      username: "u",
      hardCap: 1000,
      now: 100,
    });
    expect(r.ok).toBe(true);
    expect(removeCalls.some((c) => c.includes(2))).toBe(false);
    expect(playlistSongs).toContain(2);
    expect(r.snapshot?.favoriteIds).toContain(2);
  });

  it("keeps event-loved new favorite when next Loved read lags (P1-新 1a H2)", async () => {
    // 起点从未有该键的新收藏；事件 love 后 Loved 滞后 → 不得删。
    const favoritesId = 42;
    const library = [song(1, "A", "One"), song(2, "B", "Two"), song(3, "C", "Three")];
    const playlistSongs = [1, 2];
    const removeCalls: number[][] = [];
    let snapshot: WritebackSnapshot = {
      ts: 1,
      lovedKeys: ["at:a\u0000one"],
      favoriteIds: [1],
      songKeys: { "1": "at:a\u0000one" },
    };
    const playlists = {
      async list(): Promise<Playlist[]> {
        return [
          {
            id: favoritesId,
            type: "normal",
            name: "收藏",
            description: "",
            cover_url: "",
            labels: ["built_in"],
            song_count: playlistSongs.length,
            created_at: "",
            updated_at: "",
            sort_by: "position",
            sort_order: "asc",
          },
        ];
      },
      async getSongs(
        _playlistId: number,
        opts?: { limit?: number; offset?: number }
      ): Promise<Song[]> {
        const offset = opts?.offset ?? 0;
        const limit = opts?.limit ?? 500;
        return playlistSongs
          .slice(offset, offset + limit)
          .map((id) => library.find((s) => s.id === id)!);
      },
      async addSongs(_playlistId: number, ids: number[]) {
        for (const id of ids) if (!playlistSongs.includes(id)) playlistSongs.push(id);
        return { added: ids.length, skipped: 0 };
      },
      async removeSongs(_playlistId: number, ids: number[]) {
        removeCalls.push([...ids]);
        for (const id of ids) {
          const i = playlistSongs.indexOf(id);
          if (i >= 0) playlistSongs.splice(i, 1);
        }
      },
    };
    const service = new WritebackService({
      playlists: playlists as never,
      library: {
        list: async () => library,
        getById: async (id: number) => library.find((s) => s.id === id) ?? null,
      },
      store: {
        load: async () => snapshot,
        save: async (s) => {
          snapshot = s;
        },
      },
      getWriteApi: async () => ({
        love: async () => {},
        unlove: async () => {},
      }),
      withLock: async (fn) => ({ skipped: false as const, result: await fn() }),
      sleep: async () => {},
      echoDrainMs: 0,
    });

    await service.handleEvent(event(2, "add", { playlistId: 42, artist: "B", title: "Two" }));
    await service.drainQueue();
    expect(snapshot.lovedKeys || []).not.toContain("at:b\u0000two");

    const r = await service.reconcileFavorites({
      scrobbler: {
        getLovedTracks: async () => ({
          tracks: [{ artist: "A", title: "One" }, { artist: "C", title: "Three" }],
          truncated: false,
        }),
      },
      username: "u",
      hardCap: 1000,
      now: 100,
    });
    expect(r.ok).toBe(true);
    expect(removeCalls.some((c) => c.includes(2))).toBe(false);
    expect(playlistSongs).toContain(2);
  });

  it("keeps event-loved track when Loved never reflects feat. key (P1-新 1a I1)", async () => {
    const favoritesId = 42;
    const library = [song(1, "A", "One"), song(2, "B", "Two"), song(3, "C", "Three")];
    const playlistSongs = [1, 2, 3];
    const removeCalls: number[][] = [];
    let snapshot: WritebackSnapshot = {
      ts: 1,
      lovedKeys: ["at:a\u0000one", "at:c\u0000three"],
      favoriteIds: [1, 3],
      songKeys: { "1": "at:a\u0000one", "3": "at:c\u0000three" },
    };
    const playlists = {
      async list(): Promise<Playlist[]> {
        return [
          {
            id: favoritesId,
            type: "normal",
            name: "收藏",
            description: "",
            cover_url: "",
            labels: ["built_in"],
            song_count: playlistSongs.length,
            created_at: "",
            updated_at: "",
            sort_by: "position",
            sort_order: "asc",
          },
        ];
      },
      async getSongs(
        _playlistId: number,
        opts?: { limit?: number; offset?: number }
      ): Promise<Song[]> {
        const offset = opts?.offset ?? 0;
        const limit = opts?.limit ?? 500;
        return playlistSongs
          .slice(offset, offset + limit)
          .map((id) => library.find((s) => s.id === id)!);
      },
      async addSongs(_playlistId: number, ids: number[]) {
        for (const id of ids) if (!playlistSongs.includes(id)) playlistSongs.push(id);
        return { added: ids.length, skipped: 0 };
      },
      async removeSongs(_playlistId: number, ids: number[]) {
        removeCalls.push([...ids]);
        for (const id of ids) {
          const i = playlistSongs.indexOf(id);
          if (i >= 0) playlistSongs.splice(i, 1);
        }
      },
    };
    const service = new WritebackService({
      playlists: playlists as never,
      library: {
        list: async () => library,
        getById: async (id: number) => library.find((s) => s.id === id) ?? null,
      },
      store: {
        load: async () => snapshot,
        save: async (s) => {
          snapshot = s;
        },
      },
      getWriteApi: async () => ({
        love: async () => {},
        unlove: async () => {},
      }),
      withLock: async (fn) => ({ skipped: false as const, result: await fn() }),
      sleep: async () => {},
      echoDrainMs: 0,
    });

    await service.handleEvent(event(2, "add", { playlistId: 42, artist: "B", title: "Two" }));
    await service.drainQueue();

    const featLoved = {
      getLovedTracks: async () => ({
        tracks: [
          { artist: "A", title: "One" },
          { artist: "B feat. X", title: "Two" },
          { artist: "C", title: "Three" },
        ],
        truncated: false,
      }),
    };
    for (const now of [200, 300, 400, 500]) {
      removeCalls.length = 0;
      const r = await service.reconcileFavorites({
        scrobbler: featLoved,
        username: "u",
        hardCap: 1000,
        now,
      });
      expect(r.ok).toBe(true);
      expect(removeCalls.some((c) => c.includes(2))).toBe(false);
      expect(playlistSongs).toContain(2);
      expect(r.snapshot?.favoriteIds).toContain(2);
    }
  });

  it("does not re-add event-unloved track when Loved still contains it (P1-新 1a I2)", async () => {
    const favoritesId = 42;
    const library = [song(1, "A", "One"), song(2, "B", "Two"), song(3, "C", "Three")];
    const playlistSongs = [1, 3];
    const addCalls: number[][] = [];
    let snapshot: WritebackSnapshot = {
      ts: 1,
      lovedKeys: ["at:a\u0000one", "at:b\u0000two", "at:c\u0000three"],
      favoriteIds: [1, 2, 3],
      songKeys: { "1": "at:a\u0000one", "2": "at:b\u0000two", "3": "at:c\u0000three" },
    };
    const playlists = {
      async list(): Promise<Playlist[]> {
        return [
          {
            id: favoritesId,
            type: "normal",
            name: "收藏",
            description: "",
            cover_url: "",
            labels: ["built_in"],
            song_count: playlistSongs.length,
            created_at: "",
            updated_at: "",
            sort_by: "position",
            sort_order: "asc",
          },
        ];
      },
      async getSongs(
        _playlistId: number,
        opts?: { limit?: number; offset?: number }
      ): Promise<Song[]> {
        const offset = opts?.offset ?? 0;
        const limit = opts?.limit ?? 500;
        return playlistSongs
          .slice(offset, offset + limit)
          .map((id) => library.find((s) => s.id === id)!);
      },
      async addSongs(_playlistId: number, ids: number[]) {
        addCalls.push([...ids]);
        for (const id of ids) if (!playlistSongs.includes(id)) playlistSongs.push(id);
        return { added: ids.length, skipped: 0 };
      },
      async removeSongs(_playlistId: number, ids: number[]) {
        for (const id of ids) {
          const i = playlistSongs.indexOf(id);
          if (i >= 0) playlistSongs.splice(i, 1);
        }
      },
    };
    const service = new WritebackService({
      playlists: playlists as never,
      library: {
        list: async () => library,
        getById: async (id: number) => library.find((s) => s.id === id) ?? null,
      },
      store: {
        load: async () => snapshot,
        save: async (s) => {
          snapshot = s;
        },
      },
      getWriteApi: async () => ({
        love: async () => {},
        unlove: async () => {},
      }),
      withLock: async (fn) => ({ skipped: false as const, result: await fn() }),
      sleep: async () => {},
      echoDrainMs: 0,
    });

    await service.handleEvent(event(2, "remove", { playlistId: 42, artist: "B", title: "Two" }));
    await service.drainQueue();
    expect(snapshot.favoriteIds).not.toContain(2);
    expect(snapshot.lovedKeys || []).toContain("at:b\u0000two");

    addCalls.length = 0;
    const r = await service.reconcileFavorites({
      scrobbler: {
        getLovedTracks: async () => ({
          tracks: [
            { artist: "A", title: "One" },
            { artist: "B", title: "Two" },
            { artist: "C", title: "Three" },
          ],
          truncated: false,
        }),
      },
      username: "u",
      hardCap: 1000,
      now: 100,
    });
    expect(r.ok).toBe(true);
    expect(addCalls.some((c) => c.includes(2))).toBe(false);
    expect(playlistSongs).not.toContain(2);
    expect(r.snapshot?.favoriteIds).not.toContain(2);
  });

  it("clears stale lovedKeys on truncated re-love so next complete round keeps favorite (P1-新 1b E1a)", async () => {
    const favoritesId = 42;
    const library = [song(1, "A", "One"), song(2, "B", "Two"), song(3, "C", "Three")];
    const playlistSongs = [1, 2, 3];
    const removeCalls: number[][] = [];
    let snapshot: WritebackSnapshot = {
      ts: 1,
      lovedKeys: ["at:a\u0000one", "at:b\u0000two", "at:c\u0000three"],
      favoriteIds: [1, 3],
      songKeys: { "1": "at:a\u0000one", "3": "at:c\u0000three" },
    };
    const playlists = {
      async list(): Promise<Playlist[]> {
        return [
          {
            id: favoritesId,
            type: "normal",
            name: "收藏",
            description: "",
            cover_url: "",
            labels: ["built_in"],
            song_count: playlistSongs.length,
            created_at: "",
            updated_at: "",
            sort_by: "position",
            sort_order: "asc",
          },
        ];
      },
      async getSongs(
        _playlistId: number,
        opts?: { limit?: number; offset?: number }
      ): Promise<Song[]> {
        const offset = opts?.offset ?? 0;
        const limit = opts?.limit ?? 500;
        return playlistSongs
          .slice(offset, offset + limit)
          .map((id) => library.find((s) => s.id === id)!);
      },
      async addSongs(_playlistId: number, ids: number[]) {
        for (const id of ids) if (!playlistSongs.includes(id)) playlistSongs.push(id);
        return { added: ids.length, skipped: 0 };
      },
      async removeSongs(_playlistId: number, ids: number[]) {
        removeCalls.push([...ids]);
        for (const id of ids) {
          const i = playlistSongs.indexOf(id);
          if (i >= 0) playlistSongs.splice(i, 1);
        }
      },
    };
    const service = new WritebackService({
      playlists: playlists as never,
      library: {
        list: async () => library,
        getById: async (id: number) => library.find((s) => s.id === id) ?? null,
      },
      store: {
        load: async () => snapshot,
        save: async (s) => {
          snapshot = s;
        },
      },
      getWriteApi: async () => ({
        love: async () => {},
        unlove: async () => {},
      }),
      withLock: async (fn) => ({ skipped: false as const, result: await fn() }),
      sleep: async () => {},
      echoDrainMs: 0,
    });

    const withoutTwo = [
      { artist: "A", title: "One" },
      { artist: "C", title: "Three" },
    ];
    const r1 = await service.reconcileFavorites({
      scrobbler: { getLovedTracks: async () => ({ tracks: withoutTwo, truncated: true }) },
      username: "u",
      hardCap: 1000,
      now: 100,
    });
    expect(r1.ok).toBe(true);
    expect(r1.removalsSuppressed).toBe(true);
    expect(r1.snapshot?.lovedKeys || []).not.toContain("at:b\u0000two");
    expect(r1.snapshot?.favoriteIds).toContain(2);

    removeCalls.length = 0;
    const r2 = await service.reconcileFavorites({
      scrobbler: { getLovedTracks: async () => ({ tracks: withoutTwo, truncated: false }) },
      username: "u",
      hardCap: 1000,
      now: 200,
    });
    expect(r2.ok).toBe(true);
    expect(removeCalls.some((c) => c.includes(2))).toBe(false);
    expect(playlistSongs).toContain(2);
    expect(r2.snapshot?.favoriteIds).toContain(2);
  });

  it("clears stale lovedKeys on empty-Loved re-love so next complete round keeps favorite (P1-新 1b E1d)", async () => {
    const favoritesId = 42;
    const library = [song(1, "A", "One"), song(2, "B", "Two"), song(3, "C", "Three")];
    const playlistSongs = [1, 2, 3];
    const removeCalls: number[][] = [];
    let snapshot: WritebackSnapshot = {
      ts: 1,
      lovedKeys: ["at:a\u0000one", "at:b\u0000two", "at:c\u0000three"],
      favoriteIds: [1, 3],
      songKeys: { "1": "at:a\u0000one", "3": "at:c\u0000three" },
    };
    const playlists = {
      async list(): Promise<Playlist[]> {
        return [
          {
            id: favoritesId,
            type: "normal",
            name: "收藏",
            description: "",
            cover_url: "",
            labels: ["built_in"],
            song_count: playlistSongs.length,
            created_at: "",
            updated_at: "",
            sort_by: "position",
            sort_order: "asc",
          },
        ];
      },
      async getSongs(
        _playlistId: number,
        opts?: { limit?: number; offset?: number }
      ): Promise<Song[]> {
        const offset = opts?.offset ?? 0;
        const limit = opts?.limit ?? 500;
        return playlistSongs
          .slice(offset, offset + limit)
          .map((id) => library.find((s) => s.id === id)!);
      },
      async addSongs(_playlistId: number, ids: number[]) {
        for (const id of ids) if (!playlistSongs.includes(id)) playlistSongs.push(id);
        return { added: ids.length, skipped: 0 };
      },
      async removeSongs(_playlistId: number, ids: number[]) {
        removeCalls.push([...ids]);
        for (const id of ids) {
          const i = playlistSongs.indexOf(id);
          if (i >= 0) playlistSongs.splice(i, 1);
        }
      },
    };
    const service = new WritebackService({
      playlists: playlists as never,
      library: {
        list: async () => library,
        getById: async (id: number) => library.find((s) => s.id === id) ?? null,
      },
      store: {
        load: async () => snapshot,
        save: async (s) => {
          snapshot = s;
        },
      },
      getWriteApi: async () => ({
        love: async () => {},
        unlove: async () => {},
      }),
      withLock: async (fn) => ({ skipped: false as const, result: await fn() }),
      sleep: async () => {},
      echoDrainMs: 0,
    });

    const r1 = await service.reconcileFavorites({
      scrobbler: { getLovedTracks: async () => ({ tracks: [], truncated: false }) },
      username: "u",
      hardCap: 1000,
      now: 100,
    });
    expect(r1.ok).toBe(true);
    expect(r1.removalsSuppressed).toBe(true);
    expect(r1.snapshot?.lovedKeys || []).not.toContain("at:b\u0000two");

    removeCalls.length = 0;
    const r2 = await service.reconcileFavorites({
      scrobbler: {
        getLovedTracks: async () => ({
          tracks: [
            { artist: "A", title: "One" },
            { artist: "C", title: "Three" },
          ],
          truncated: false,
        }),
      },
      username: "u",
      hardCap: 1000,
      now: 200,
    });
    expect(r2.ok).toBe(true);
    expect(removeCalls.some((c) => c.includes(2))).toBe(false);
    expect(playlistSongs).toContain(2);
  });

  it("keeps re-loved favorite across natural unlove then truncated love then complete lag (P1-新 1b E2)", async () => {
    const favoritesId = 42;
    const library = [song(1, "A", "One"), song(2, "B", "Two"), song(3, "C", "Three")];
    const playlistSongs = [1, 2];
    const removeCalls: number[][] = [];
    const calls: Array<{ kind: string; artist: string; title: string }> = [];
    let snapshot: WritebackSnapshot = {
      ts: 1,
      lovedKeys: ["at:a\u0000one", "at:b\u0000two"],
      favoriteIds: [1, 2],
      songKeys: { "1": "at:a\u0000one", "2": "at:b\u0000two" },
    };
    const playlists = {
      async list(): Promise<Playlist[]> {
        return [
          {
            id: favoritesId,
            type: "normal",
            name: "收藏",
            description: "",
            cover_url: "",
            labels: ["built_in"],
            song_count: playlistSongs.length,
            created_at: "",
            updated_at: "",
            sort_by: "position",
            sort_order: "asc",
          },
        ];
      },
      async getSongs(
        _playlistId: number,
        opts?: { limit?: number; offset?: number }
      ): Promise<Song[]> {
        const offset = opts?.offset ?? 0;
        const limit = opts?.limit ?? 500;
        return playlistSongs
          .slice(offset, offset + limit)
          .map((id) => library.find((s) => s.id === id)!);
      },
      async addSongs(_playlistId: number, ids: number[]) {
        for (const id of ids) if (!playlistSongs.includes(id)) playlistSongs.push(id);
        return { added: ids.length, skipped: 0 };
      },
      async removeSongs(_playlistId: number, ids: number[]) {
        removeCalls.push([...ids]);
        for (const id of ids) {
          const i = playlistSongs.indexOf(id);
          if (i >= 0) playlistSongs.splice(i, 1);
        }
      },
    };
    const service = new WritebackService({
      playlists: playlists as never,
      library: {
        list: async () => library,
        getById: async (id: number) => library.find((s) => s.id === id) ?? null,
      },
      store: {
        load: async () => snapshot,
        save: async (s) => {
          snapshot = s;
        },
      },
      getWriteApi: async () => ({
        love: async (artist: string, title: string) => {
          calls.push({ kind: "love", artist, title });
        },
        unlove: async (artist: string, title: string) => {
          calls.push({ kind: "unlove", artist, title });
        },
      }),
      withLock: async (fn) => ({ skipped: false as const, result: await fn() }),
      sleep: async () => {},
      echoDrainMs: 0,
    });

    // R1：用户删 2，Loved 仍含 Two → unlove；键按设计暂留
    playlistSongs.splice(playlistSongs.indexOf(2), 1);
    const r1 = await service.reconcileFavorites({
      scrobbler: {
        getLovedTracks: async () => ({
          tracks: [
            { artist: "A", title: "One" },
            { artist: "B", title: "Two" },
          ],
          truncated: false,
        }),
      },
      username: "u",
      hardCap: 1000,
      now: 100,
    });
    expect(r1.ok).toBe(true);
    expect(calls.some((c) => c.kind === "unlove" && c.title === "Two")).toBe(true);
    expect(r1.snapshot?.lovedKeys || []).toContain("at:b\u0000two");

    // R2：加回 2 + Three，截断轮 love；陈旧键须清掉
    playlistSongs.push(2, 3);
    calls.length = 0;
    const r2 = await service.reconcileFavorites({
      scrobbler: {
        getLovedTracks: async () => ({
          tracks: [
            { artist: "A", title: "One" },
            { artist: "C", title: "Three" },
          ],
          truncated: true,
        }),
      },
      username: "u",
      hardCap: 1000,
      now: 200,
    });
    expect(r2.ok).toBe(true);
    expect(calls.some((c) => c.kind === "love" && c.title === "Two")).toBe(true);
    expect(r2.snapshot?.lovedKeys || []).not.toContain("at:b\u0000two");
    expect(r2.snapshot?.favoriteIds).toContain(2);

    // R3：完整轮 Loved 仍不含 Two → 不得删刚收藏
    removeCalls.length = 0;
    const r3 = await service.reconcileFavorites({
      scrobbler: {
        getLovedTracks: async () => ({
          tracks: [
            { artist: "A", title: "One" },
            { artist: "C", title: "Three" },
          ],
          truncated: false,
        }),
      },
      username: "u",
      hardCap: 1000,
      now: 300,
    });
    expect(r3.ok).toBe(true);
    expect(removeCalls.some((c) => c.includes(2))).toBe(false);
    expect(playlistSongs).toContain(2);
    expect(r3.snapshot?.favoriteIds).toContain(2);
  });

  it("keeps new favorite without prior key across truncated love then complete lag (P1-新 1b E1c)", async () => {
    const favoritesId = 42;
    const library = [song(1, "A", "One"), song(2, "B", "Two"), song(3, "C", "Three")];
    const playlistSongs = [1, 2, 3];
    const removeCalls: number[][] = [];
    let snapshot: WritebackSnapshot = {
      ts: 1,
      lovedKeys: ["at:a\u0000one", "at:c\u0000three"],
      favoriteIds: [1, 3],
      songKeys: { "1": "at:a\u0000one", "3": "at:c\u0000three" },
    };
    const playlists = {
      async list(): Promise<Playlist[]> {
        return [
          {
            id: favoritesId,
            type: "normal",
            name: "收藏",
            description: "",
            cover_url: "",
            labels: ["built_in"],
            song_count: playlistSongs.length,
            created_at: "",
            updated_at: "",
            sort_by: "position",
            sort_order: "asc",
          },
        ];
      },
      async getSongs(
        _playlistId: number,
        opts?: { limit?: number; offset?: number }
      ): Promise<Song[]> {
        const offset = opts?.offset ?? 0;
        const limit = opts?.limit ?? 500;
        return playlistSongs
          .slice(offset, offset + limit)
          .map((id) => library.find((s) => s.id === id)!);
      },
      async addSongs(_playlistId: number, ids: number[]) {
        for (const id of ids) if (!playlistSongs.includes(id)) playlistSongs.push(id);
        return { added: ids.length, skipped: 0 };
      },
      async removeSongs(_playlistId: number, ids: number[]) {
        removeCalls.push([...ids]);
        for (const id of ids) {
          const i = playlistSongs.indexOf(id);
          if (i >= 0) playlistSongs.splice(i, 1);
        }
      },
    };
    const service = new WritebackService({
      playlists: playlists as never,
      library: {
        list: async () => library,
        getById: async (id: number) => library.find((s) => s.id === id) ?? null,
      },
      store: {
        load: async () => snapshot,
        save: async (s) => {
          snapshot = s;
        },
      },
      getWriteApi: async () => ({
        love: async () => {},
        unlove: async () => {},
      }),
      withLock: async (fn) => ({ skipped: false as const, result: await fn() }),
      sleep: async () => {},
      echoDrainMs: 0,
    });

    const withoutTwo = [
      { artist: "A", title: "One" },
      { artist: "C", title: "Three" },
    ];
    await service.reconcileFavorites({
      scrobbler: { getLovedTracks: async () => ({ tracks: withoutTwo, truncated: true }) },
      username: "u",
      hardCap: 1000,
      now: 100,
    });
    removeCalls.length = 0;
    const r2 = await service.reconcileFavorites({
      scrobbler: { getLovedTracks: async () => ({ tracks: withoutTwo, truncated: false }) },
      username: "u",
      hardCap: 1000,
      now: 200,
    });
    expect(r2.ok).toBe(true);
    expect(removeCalls.some((c) => c.includes(2))).toBe(false);
    expect(playlistSongs).toContain(2);
  });

  it("does not remove re-loved track when truncated round already sees it on Loved (P1-新 1b E1b)", async () => {
    const favoritesId = 42;
    const library = [song(1, "A", "One"), song(2, "B", "Two"), song(3, "C", "Three")];
    const playlistSongs = [1, 2, 3];
    const removeCalls: number[][] = [];
    let snapshot: WritebackSnapshot = {
      ts: 1,
      lovedKeys: ["at:a\u0000one", "at:b\u0000two", "at:c\u0000three"],
      favoriteIds: [1, 3],
      songKeys: { "1": "at:a\u0000one", "3": "at:c\u0000three" },
    };
    const playlists = {
      async list(): Promise<Playlist[]> {
        return [
          {
            id: favoritesId,
            type: "normal",
            name: "收藏",
            description: "",
            cover_url: "",
            labels: ["built_in"],
            song_count: playlistSongs.length,
            created_at: "",
            updated_at: "",
            sort_by: "position",
            sort_order: "asc",
          },
        ];
      },
      async getSongs(
        _playlistId: number,
        opts?: { limit?: number; offset?: number }
      ): Promise<Song[]> {
        const offset = opts?.offset ?? 0;
        const limit = opts?.limit ?? 500;
        return playlistSongs
          .slice(offset, offset + limit)
          .map((id) => library.find((s) => s.id === id)!);
      },
      async addSongs(_playlistId: number, ids: number[]) {
        for (const id of ids) if (!playlistSongs.includes(id)) playlistSongs.push(id);
        return { added: ids.length, skipped: 0 };
      },
      async removeSongs(_playlistId: number, ids: number[]) {
        removeCalls.push([...ids]);
        for (const id of ids) {
          const i = playlistSongs.indexOf(id);
          if (i >= 0) playlistSongs.splice(i, 1);
        }
      },
    };
    const service = new WritebackService({
      playlists: playlists as never,
      library: {
        list: async () => library,
        getById: async (id: number) => library.find((s) => s.id === id) ?? null,
      },
      store: {
        load: async () => snapshot,
        save: async (s) => {
          snapshot = s;
        },
      },
      getWriteApi: async () => ({
        love: async () => {},
        unlove: async () => {},
      }),
      withLock: async (fn) => ({ skipped: false as const, result: await fn() }),
      sleep: async () => {},
      echoDrainMs: 0,
    });

    const withTwo = [
      { artist: "A", title: "One" },
      { artist: "B", title: "Two" },
      { artist: "C", title: "Three" },
    ];
    await service.reconcileFavorites({
      scrobbler: { getLovedTracks: async () => ({ tracks: withTwo, truncated: true }) },
      username: "u",
      hardCap: 1000,
      now: 100,
    });
    removeCalls.length = 0;
    const r2 = await service.reconcileFavorites({
      scrobbler: { getLovedTracks: async () => ({ tracks: withTwo, truncated: false }) },
      username: "u",
      hardCap: 1000,
      now: 200,
    });
    expect(r2.ok).toBe(true);
    expect(removeCalls.some((c) => c.includes(2))).toBe(false);
    expect(playlistSongs).toContain(2);
  });

  it("does not unlove window-removed mbid track when sibling has no songKeys (P2-新 1 natural window)", async () => {
    const favoritesId = 42;
    const mbidTwo = "11111111-1111-1111-1111-111111111111";
    const mbidKey = `mbid:${mbidTwo}`;
    const library = [
      song(1, "A", "One"),
      song(2, "B", "Two"),
      song(5, "B", "Two"),
      song(3, "C", "Three"),
    ];
    const playlistSongs = [1, 2, 5];
    let listingRound = 0;
    const calls: Array<{ kind: string; artist: string; title: string }> = [];
    let snapshot: WritebackSnapshot = {
      ts: 1,
      lovedKeys: ["at:a\u0000one", mbidKey],
      favoriteIds: [1, 2, 5],
      // 自然形态：只为被删的 2 记 mbid 键，兄弟 5 无 songKeys
      songKeys: { "1": "at:a\u0000one", "2": mbidKey },
    };
    const playlists = {
      async list(): Promise<Playlist[]> {
        return [
          {
            id: favoritesId,
            type: "normal",
            name: "收藏",
            description: "",
            cover_url: "",
            labels: ["built_in"],
            song_count: playlistSongs.length,
            created_at: "",
            updated_at: "",
            sort_by: "position",
            sort_order: "asc",
          },
        ];
      },
      async getSongs(
        _playlistId: number,
        opts?: { limit?: number; offset?: number }
      ): Promise<Song[]> {
        const offset = opts?.offset ?? 0;
        if (offset === 0) {
          listingRound += 1;
          if (listingRound === 2) {
            const i = playlistSongs.indexOf(2);
            if (i >= 0) playlistSongs.splice(i, 1);
          }
        }
        const limit = opts?.limit ?? 500;
        return playlistSongs
          .slice(offset, offset + limit)
          .map((id) => library.find((s) => s.id === id)!);
      },
      async addSongs(_playlistId: number, ids: number[]) {
        for (const id of ids) if (!playlistSongs.includes(id)) playlistSongs.push(id);
        return { added: ids.length, skipped: 0 };
      },
      async removeSongs(_playlistId: number, ids: number[]) {
        for (const id of ids) {
          const i = playlistSongs.indexOf(id);
          if (i >= 0) playlistSongs.splice(i, 1);
        }
      },
    };
    const service = new WritebackService({
      playlists: playlists as never,
      library: {
        list: async () => library,
        getById: async (id: number) => library.find((s) => s.id === id) ?? null,
      },
      store: {
        load: async () => snapshot,
        save: async (s) => {
          snapshot = s;
        },
      },
      getWriteApi: async () => ({
        love: async (artist: string, title: string) => {
          calls.push({ kind: "love", artist, title });
        },
        unlove: async (artist: string, title: string) => {
          calls.push({ kind: "unlove", artist, title });
        },
      }),
      withLock: async (fn) => ({ skipped: false as const, result: await fn() }),
      sleep: async () => {},
      echoDrainMs: 0,
    });

    const r1 = await service.reconcileFavorites({
      scrobbler: {
        getLovedTracks: async () => ({
          tracks: [
            { artist: "A", title: "One" },
            { artist: "B", title: "Two", mbid: mbidTwo },
            { artist: "C", title: "Three" },
          ],
          truncated: false,
        }),
      },
      username: "u",
      hardCap: 1000,
      now: 100,
    });
    expect(r1.ok).toBe(true);
    expect(calls.filter((c) => c.kind === "unlove" && c.title === "Two")).toEqual([]);
    expect(playlistSongs).toContain(5);
    expect(playlistSongs).not.toContain(2);
  });

  it("does not churn natural mbid duplicate across unsafe then safe rounds (P2-新 1 natural P2-b)", async () => {
    // P2-b 块 stillInFav 守护：兄弟无 songKeys 的自然形态。
    const favoritesId = 42;
    const mbidTwo = "11111111-1111-1111-1111-111111111111";
    const mbidKey = `mbid:${mbidTwo}`;
    const library = [
      song(1, "A", "One"),
      song(2, "B", "Two"),
      song(5, "B", "Two"),
      song(3, "C", "Three"),
    ];
    const playlistSongs = [1, 2, 5];
    let listingRound = 0;
    let lovedTruncated = true;
    const addCalls: number[][] = [];
    const calls: Array<{ kind: string; artist: string; title: string }> = [];
    let snapshot: WritebackSnapshot = {
      ts: 1,
      lovedKeys: ["at:a\u0000one", mbidKey],
      favoriteIds: [1, 2, 5],
      songKeys: { "1": "at:a\u0000one", "2": mbidKey },
    };
    const playlists = {
      async list(): Promise<Playlist[]> {
        return [
          {
            id: favoritesId,
            type: "normal",
            name: "收藏",
            description: "",
            cover_url: "",
            labels: ["built_in"],
            song_count: playlistSongs.length,
            created_at: "",
            updated_at: "",
            sort_by: "position",
            sort_order: "asc",
          },
        ];
      },
      async getSongs(
        _playlistId: number,
        opts?: { limit?: number; offset?: number }
      ): Promise<Song[]> {
        const offset = opts?.offset ?? 0;
        if (offset === 0) {
          listingRound += 1;
          if (lovedTruncated && listingRound === 2) {
            const i = playlistSongs.indexOf(2);
            if (i >= 0) playlistSongs.splice(i, 1);
          }
        }
        const limit = opts?.limit ?? 500;
        return playlistSongs
          .slice(offset, offset + limit)
          .map((id) => library.find((s) => s.id === id)!);
      },
      async addSongs(_playlistId: number, ids: number[]) {
        addCalls.push([...ids]);
        for (const id of ids) if (!playlistSongs.includes(id)) playlistSongs.push(id);
        return { added: ids.length, skipped: 0 };
      },
      async removeSongs(_playlistId: number, ids: number[]) {
        for (const id of ids) {
          const i = playlistSongs.indexOf(id);
          if (i >= 0) playlistSongs.splice(i, 1);
        }
      },
    };
    const service = new WritebackService({
      playlists: playlists as never,
      library: {
        list: async () => library,
        getById: async (id: number) => library.find((s) => s.id === id) ?? null,
      },
      store: {
        load: async () => snapshot,
        save: async (s) => {
          snapshot = s;
        },
      },
      getWriteApi: async () => ({
        love: async (artist: string, title: string) => {
          calls.push({ kind: "love", artist, title });
        },
        unlove: async (artist: string, title: string) => {
          calls.push({ kind: "unlove", artist, title });
        },
      }),
      withLock: async (fn) => ({ skipped: false as const, result: await fn() }),
      sleep: async () => {},
      echoDrainMs: 0,
    });

    const lovedTracks = [
      { artist: "A", title: "One" },
      { artist: "B", title: "Two", mbid: mbidTwo },
      { artist: "C", title: "Three" },
    ];
    const r1 = await service.reconcileFavorites({
      scrobbler: {
        getLovedTracks: async () => ({ tracks: lovedTracks, truncated: true }),
      },
      username: "u",
      hardCap: 1000,
      now: 100,
    });
    expect(r1.ok).toBe(true);
    expect(calls.filter((c) => c.kind === "unlove")).toEqual([]);
    expect(playlistSongs).not.toContain(2);
    expect(playlistSongs).toContain(5);

    lovedTruncated = false;
    listingRound = 0;
    calls.length = 0;
    addCalls.length = 0;
    const r2 = await service.reconcileFavorites({
      scrobbler: {
        getLovedTracks: async () => ({ tracks: lovedTracks, truncated: false }),
      },
      username: "u",
      hardCap: 1000,
      now: 200,
    });
    expect(r2.ok).toBe(true);
    expect(calls.filter((c) => c.kind === "unlove" && c.title === "Two")).toEqual([]);
    expect(addCalls.some((c) => c.includes(2))).toBe(false);
    expect(playlistSongs.sort()).toEqual([1, 5, 3].sort());
    expect(r2.snapshot?.favoriteIds.sort()).toEqual([1, 5, 3].sort());
  });

  it("love guard does not treat next.lovedKeys alone as Loved confirmation (P1-新 1b guard)", async () => {
    // 截断轮 next.lovedKeys 会并上 prev 陈旧键；守卫必须读 lovedNowKeys，否则会再次乐观写入。
    const favoritesId = 42;
    const library = [song(1, "A", "One"), song(2, "B", "Two"), song(3, "C", "Three")];
    const playlistSongs = [1, 2, 3];
    let snapshot: WritebackSnapshot = {
      ts: 1,
      lovedKeys: ["at:a\u0000one", "at:b\u0000two", "at:c\u0000three"],
      favoriteIds: [1, 3],
      songKeys: { "1": "at:a\u0000one", "3": "at:c\u0000three" },
    };
    const playlists = {
      async list(): Promise<Playlist[]> {
        return [
          {
            id: favoritesId,
            type: "normal",
            name: "收藏",
            description: "",
            cover_url: "",
            labels: ["built_in"],
            song_count: playlistSongs.length,
            created_at: "",
            updated_at: "",
            sort_by: "position",
            sort_order: "asc",
          },
        ];
      },
      async getSongs(
        _playlistId: number,
        opts?: { limit?: number; offset?: number }
      ): Promise<Song[]> {
        const offset = opts?.offset ?? 0;
        const limit = opts?.limit ?? 500;
        return playlistSongs
          .slice(offset, offset + limit)
          .map((id) => library.find((s) => s.id === id)!);
      },
      async addSongs(_playlistId: number, ids: number[]) {
        for (const id of ids) if (!playlistSongs.includes(id)) playlistSongs.push(id);
        return { added: ids.length, skipped: 0 };
      },
      async removeSongs(_playlistId: number, ids: number[]) {
        for (const id of ids) {
          const i = playlistSongs.indexOf(id);
          if (i >= 0) playlistSongs.splice(i, 1);
        }
      },
    };
    const service = new WritebackService({
      playlists: playlists as never,
      library: {
        list: async () => library,
        getById: async (id: number) => library.find((s) => s.id === id) ?? null,
      },
      store: {
        load: async () => snapshot,
        save: async (s) => {
          snapshot = s;
        },
      },
      getWriteApi: async () => ({
        love: async () => {},
        unlove: async () => {},
      }),
      withLock: async (fn) => ({ skipped: false as const, result: await fn() }),
      sleep: async () => {},
      echoDrainMs: 0,
    });

    const r1 = await service.reconcileFavorites({
      scrobbler: {
        getLovedTracks: async () => ({
          tracks: [
            { artist: "A", title: "One" },
            { artist: "C", title: "Three" },
          ],
          truncated: true,
        }),
      },
      username: "u",
      hardCap: 1000,
      now: 100,
    });
    expect(r1.ok).toBe(true);
    // next.lovedKeys 在 unsafe 下会并 prev，但落盘不得保留未确认的 Two
    expect(r1.snapshot?.lovedKeys || []).not.toContain("at:b\u0000two");
    expect(r1.snapshot?.songKeys?.["2"]).toBe("at:b\u0000two");
  });

  it("keeps favorite after unlove→love two-click when Loved lags (P1-新 1a N1)", async () => {
    // 已在收藏且已有 lovedKeys → 事件 unlove → 事件 love；下一轮 Loved 只反映 unlove → 不得 removeSongs。
    const favoritesId = 42;
    const library = [song(1, "A", "One"), song(2, "B", "Two"), song(3, "C", "Three")];
    const playlistSongs = [1, 2];
    const removeCalls: number[][] = [];
    let snapshot: WritebackSnapshot = {
      ts: 1,
      lovedKeys: ["at:a\u0000one", "at:b\u0000two"],
      favoriteIds: [1, 2],
      songKeys: { "1": "at:a\u0000one", "2": "at:b\u0000two" },
    };
    const playlists = {
      async list(): Promise<Playlist[]> {
        return [
          {
            id: favoritesId,
            type: "normal",
            name: "收藏",
            description: "",
            cover_url: "",
            labels: ["built_in"],
            song_count: playlistSongs.length,
            created_at: "",
            updated_at: "",
            sort_by: "position",
            sort_order: "asc",
          },
        ];
      },
      async getSongs(
        _playlistId: number,
        opts?: { limit?: number; offset?: number }
      ): Promise<Song[]> {
        const offset = opts?.offset ?? 0;
        const limit = opts?.limit ?? 500;
        return playlistSongs
          .slice(offset, offset + limit)
          .map((id) => library.find((s) => s.id === id)!);
      },
      async addSongs(_playlistId: number, ids: number[]) {
        for (const id of ids) if (!playlistSongs.includes(id)) playlistSongs.push(id);
        return { added: ids.length, skipped: 0 };
      },
      async removeSongs(_playlistId: number, ids: number[]) {
        removeCalls.push([...ids]);
        for (const id of ids) {
          const i = playlistSongs.indexOf(id);
          if (i >= 0) playlistSongs.splice(i, 1);
        }
      },
    };
    const service = new WritebackService({
      playlists: playlists as never,
      library: {
        list: async () => library,
        getById: async (id: number) => library.find((s) => s.id === id) ?? null,
      },
      store: {
        load: async () => snapshot,
        save: async (s) => {
          snapshot = s;
        },
      },
      getWriteApi: async () => ({
        love: async () => {},
        unlove: async () => {},
      }),
      withLock: async (fn) => ({ skipped: false as const, result: await fn() }),
      sleep: async () => {},
      echoDrainMs: 0,
    });

    const i = playlistSongs.indexOf(2);
    if (i >= 0) playlistSongs.splice(i, 1);
    await service.handleEvent(event(2, "remove", { playlistId: 42, artist: "B", title: "Two" }));
    await service.drainQueue();
    expect(snapshot.favoriteIds).not.toContain(2);
    expect(snapshot.lovedKeys || []).toContain("at:b\u0000two");

    playlistSongs.push(2);
    await service.handleEvent(event(2, "add", { playlistId: 42, artist: "B", title: "Two" }));
    await service.drainQueue();
    expect(snapshot.favoriteIds).toContain(2);
    expect(snapshot.lovedKeys || []).not.toContain("at:b\u0000two");
    expect(snapshot.songKeys?.["2"]).toBe("at:b\u0000two");

    removeCalls.length = 0;
    const r = await service.reconcileFavorites({
      scrobbler: {
        getLovedTracks: async () => ({
          tracks: [{ artist: "A", title: "One" }],
          truncated: false,
        }),
      },
      username: "u",
      hardCap: 1000,
      now: 100,
    });
    expect(r.ok).toBe(true);
    expect(removeCalls.some((c) => c.includes(2))).toBe(false);
    expect(playlistSongs).toContain(2);
    expect(r.snapshot?.favoriteIds).toContain(2);
  });

  it("keeps favorite after unlove→love when Loved stores feat. key forever (P1-新 1a N2)", async () => {
    const favoritesId = 42;
    const library = [song(1, "A", "One"), song(2, "B", "Two"), song(3, "C", "Three")];
    const playlistSongs = [1, 2];
    const removeCalls: number[][] = [];
    let snapshot: WritebackSnapshot = {
      ts: 1,
      lovedKeys: ["at:a\u0000one", "at:b\u0000two"],
      favoriteIds: [1, 2],
      songKeys: { "1": "at:a\u0000one", "2": "at:b\u0000two" },
    };
    const playlists = {
      async list(): Promise<Playlist[]> {
        return [
          {
            id: favoritesId,
            type: "normal",
            name: "收藏",
            description: "",
            cover_url: "",
            labels: ["built_in"],
            song_count: playlistSongs.length,
            created_at: "",
            updated_at: "",
            sort_by: "position",
            sort_order: "asc",
          },
        ];
      },
      async getSongs(
        _playlistId: number,
        opts?: { limit?: number; offset?: number }
      ): Promise<Song[]> {
        const offset = opts?.offset ?? 0;
        const limit = opts?.limit ?? 500;
        return playlistSongs
          .slice(offset, offset + limit)
          .map((id) => library.find((s) => s.id === id)!);
      },
      async addSongs(_playlistId: number, ids: number[]) {
        for (const id of ids) if (!playlistSongs.includes(id)) playlistSongs.push(id);
        return { added: ids.length, skipped: 0 };
      },
      async removeSongs(_playlistId: number, ids: number[]) {
        removeCalls.push([...ids]);
        for (const id of ids) {
          const i = playlistSongs.indexOf(id);
          if (i >= 0) playlistSongs.splice(i, 1);
        }
      },
    };
    const service = new WritebackService({
      playlists: playlists as never,
      library: {
        list: async () => library,
        getById: async (id: number) => library.find((s) => s.id === id) ?? null,
      },
      store: {
        load: async () => snapshot,
        save: async (s) => {
          snapshot = s;
        },
      },
      getWriteApi: async () => ({
        love: async () => {},
        unlove: async () => {},
      }),
      withLock: async (fn) => ({ skipped: false as const, result: await fn() }),
      sleep: async () => {},
      echoDrainMs: 0,
    });

    const i = playlistSongs.indexOf(2);
    if (i >= 0) playlistSongs.splice(i, 1);
    await service.handleEvent(event(2, "remove", { playlistId: 42, artist: "B", title: "Two" }));
    await service.drainQueue();
    playlistSongs.push(2);
    await service.handleEvent(event(2, "add", { playlistId: 42, artist: "B", title: "Two" }));
    await service.drainQueue();

    const featLoved = {
      getLovedTracks: async () => ({
        tracks: [
          { artist: "A", title: "One" },
          { artist: "B feat. X", title: "Two" },
        ],
        truncated: false,
      }),
    };
    for (const now of [100, 200, 300, 400]) {
      removeCalls.length = 0;
      const r = await service.reconcileFavorites({
        scrobbler: featLoved,
        username: "u",
        hardCap: 1000,
        now,
      });
      expect(r.ok).toBe(true);
      expect(removeCalls.some((c) => c.includes(2))).toBe(false);
      expect(playlistSongs).toContain(2);
      expect(r.snapshot?.favoriteIds).toContain(2);
    }
  });

  it("keeps favorite after unlove→unsafe→love when next complete Loved lags (P1-新 1a N4)", async () => {
    const favoritesId = 42;
    const library = [song(1, "A", "One"), song(2, "B", "Two"), song(3, "C", "Three")];
    const playlistSongs = [1, 2];
    const removeCalls: number[][] = [];
    let snapshot: WritebackSnapshot = {
      ts: 1,
      lovedKeys: ["at:a\u0000one", "at:b\u0000two"],
      favoriteIds: [1, 2],
      songKeys: { "1": "at:a\u0000one", "2": "at:b\u0000two" },
    };
    const playlists = {
      async list(): Promise<Playlist[]> {
        return [
          {
            id: favoritesId,
            type: "normal",
            name: "收藏",
            description: "",
            cover_url: "",
            labels: ["built_in"],
            song_count: playlistSongs.length,
            created_at: "",
            updated_at: "",
            sort_by: "position",
            sort_order: "asc",
          },
        ];
      },
      async getSongs(
        _playlistId: number,
        opts?: { limit?: number; offset?: number }
      ): Promise<Song[]> {
        const offset = opts?.offset ?? 0;
        const limit = opts?.limit ?? 500;
        return playlistSongs
          .slice(offset, offset + limit)
          .map((id) => library.find((s) => s.id === id)!);
      },
      async addSongs(_playlistId: number, ids: number[]) {
        for (const id of ids) if (!playlistSongs.includes(id)) playlistSongs.push(id);
        return { added: ids.length, skipped: 0 };
      },
      async removeSongs(_playlistId: number, ids: number[]) {
        removeCalls.push([...ids]);
        for (const id of ids) {
          const i = playlistSongs.indexOf(id);
          if (i >= 0) playlistSongs.splice(i, 1);
        }
      },
    };
    const service = new WritebackService({
      playlists: playlists as never,
      library: {
        list: async () => library,
        getById: async (id: number) => library.find((s) => s.id === id) ?? null,
      },
      store: {
        load: async () => snapshot,
        save: async (s) => {
          snapshot = s;
        },
      },
      getWriteApi: async () => ({
        love: async () => {},
        unlove: async () => {},
      }),
      withLock: async (fn) => ({ skipped: false as const, result: await fn() }),
      sleep: async () => {},
      echoDrainMs: 0,
    });

    const i = playlistSongs.indexOf(2);
    if (i >= 0) playlistSongs.splice(i, 1);
    await service.handleEvent(event(2, "remove", { playlistId: 42, artist: "B", title: "Two" }));
    await service.drainQueue();

    const unsafe = await service.reconcileFavorites({
      scrobbler: {
        getLovedTracks: async () => ({
          tracks: [{ artist: "A", title: "One" }],
          truncated: true,
        }),
      },
      username: "u",
      hardCap: 1000,
      now: 50,
    });
    expect(unsafe.ok).toBe(true);
    expect(unsafe.removalsSuppressed).toBe(true);

    playlistSongs.push(2);
    await service.handleEvent(event(2, "add", { playlistId: 42, artist: "B", title: "Two" }));
    await service.drainQueue();
    expect(snapshot.lovedKeys || []).not.toContain("at:b\u0000two");

    removeCalls.length = 0;
    const r = await service.reconcileFavorites({
      scrobbler: {
        getLovedTracks: async () => ({
          tracks: [{ artist: "A", title: "One" }],
          truncated: false,
        }),
      },
      username: "u",
      hardCap: 1000,
      now: 100,
    });
    expect(r.ok).toBe(true);
    expect(removeCalls.some((c) => c.includes(2))).toBe(false);
    expect(playlistSongs).toContain(2);
    expect(r.snapshot?.favoriteIds).toContain(2);
  });

  it("still unloves after re-love then cancel again (P1-新 1a N5)", async () => {
    const favoritesId = 42;
    const library = [song(1, "A", "One"), song(2, "B", "Two")];
    const playlistSongs = [1, 2];
    const calls: Array<{ kind: string; title: string }> = [];
    let snapshot: WritebackSnapshot = {
      ts: 1,
      lovedKeys: ["at:a\u0000one", "at:b\u0000two"],
      favoriteIds: [1, 2],
      songKeys: { "1": "at:a\u0000one", "2": "at:b\u0000two" },
    };
    const playlists = {
      async list(): Promise<Playlist[]> {
        return [
          {
            id: favoritesId,
            type: "normal",
            name: "收藏",
            description: "",
            cover_url: "",
            labels: ["built_in"],
            song_count: playlistSongs.length,
            created_at: "",
            updated_at: "",
            sort_by: "position",
            sort_order: "asc",
          },
        ];
      },
      async getSongs(
        _playlistId: number,
        opts?: { limit?: number; offset?: number }
      ): Promise<Song[]> {
        const offset = opts?.offset ?? 0;
        const limit = opts?.limit ?? 500;
        return playlistSongs
          .slice(offset, offset + limit)
          .map((id) => library.find((s) => s.id === id)!);
      },
      async addSongs(_playlistId: number, ids: number[]) {
        for (const id of ids) if (!playlistSongs.includes(id)) playlistSongs.push(id);
        return { added: ids.length, skipped: 0 };
      },
      async removeSongs(_playlistId: number, ids: number[]) {
        for (const id of ids) {
          const i = playlistSongs.indexOf(id);
          if (i >= 0) playlistSongs.splice(i, 1);
        }
      },
    };
    const service = new WritebackService({
      playlists: playlists as never,
      library: {
        list: async () => library,
        getById: async (id: number) => library.find((s) => s.id === id) ?? null,
      },
      store: {
        load: async () => snapshot,
        save: async (s) => {
          snapshot = s;
        },
      },
      getWriteApi: async () => ({
        love: async (artist: string, title: string) => {
          calls.push({ kind: "love", title });
          void artist;
        },
        unlove: async (artist: string, title: string) => {
          calls.push({ kind: "unlove", title });
          void artist;
        },
      }),
      withLock: async (fn) => ({ skipped: false as const, result: await fn() }),
      sleep: async () => {},
      echoDrainMs: 0,
    });

    const i = playlistSongs.indexOf(2);
    if (i >= 0) playlistSongs.splice(i, 1);
    await service.handleEvent(event(2, "remove", { playlistId: 42, artist: "B", title: "Two" }));
    await service.drainQueue();
    playlistSongs.push(2);
    await service.handleEvent(event(2, "add", { playlistId: 42, artist: "B", title: "Two" }));
    await service.drainQueue();
    expect(calls.filter((c) => c.kind === "unlove" && c.title === "Two").length).toBe(1);
    expect(calls.filter((c) => c.kind === "love" && c.title === "Two").length).toBe(1);

    const j = playlistSongs.indexOf(2);
    if (j >= 0) playlistSongs.splice(j, 1);
    await service.handleEvent(event(2, "remove", { playlistId: 42, artist: "B", title: "Two" }));
    await service.drainQueue();
    expect(calls.filter((c) => c.kind === "unlove" && c.title === "Two").length).toBe(2);
  });

  it("keeps lovedKeys on duplicate add when already in favorites (P1-新 1a N7)", async () => {
    const favoritesId = 42;
    const library = [song(1, "A", "One"), song(2, "B", "Two")];
    const playlistSongs = [1, 2];
    let snapshot: WritebackSnapshot = {
      ts: 1,
      lovedKeys: ["at:a\u0000one", "at:b\u0000two"],
      favoriteIds: [1, 2],
      songKeys: { "1": "at:a\u0000one", "2": "at:b\u0000two" },
    };
    const playlists = {
      async list(): Promise<Playlist[]> {
        return [
          {
            id: favoritesId,
            type: "normal",
            name: "收藏",
            description: "",
            cover_url: "",
            labels: ["built_in"],
            song_count: playlistSongs.length,
            created_at: "",
            updated_at: "",
            sort_by: "position",
            sort_order: "asc",
          },
        ];
      },
      async getSongs(
        _playlistId: number,
        opts?: { limit?: number; offset?: number }
      ): Promise<Song[]> {
        const offset = opts?.offset ?? 0;
        const limit = opts?.limit ?? 500;
        return playlistSongs
          .slice(offset, offset + limit)
          .map((id) => library.find((s) => s.id === id)!);
      },
      async addSongs(_playlistId: number, ids: number[]) {
        for (const id of ids) if (!playlistSongs.includes(id)) playlistSongs.push(id);
        return { added: ids.length, skipped: 0 };
      },
      async removeSongs(_playlistId: number, ids: number[]) {
        for (const id of ids) {
          const i = playlistSongs.indexOf(id);
          if (i >= 0) playlistSongs.splice(i, 1);
        }
      },
    };
    const service = new WritebackService({
      playlists: playlists as never,
      library: {
        list: async () => library,
        getById: async (id: number) => library.find((s) => s.id === id) ?? null,
      },
      store: {
        load: async () => snapshot,
        save: async (s) => {
          snapshot = s;
        },
      },
      getWriteApi: async () => ({
        love: async () => {},
        unlove: async () => {},
      }),
      withLock: async (fn) => ({ skipped: false as const, result: await fn() }),
      sleep: async () => {},
      echoDrainMs: 0,
    });

    await service.handleEvent(event(2, "add", { playlistId: 42, artist: "B", title: "Two" }));
    await service.drainQueue();
    expect(snapshot.lovedKeys || []).toContain("at:b\u0000two");
    expect(snapshot.favoriteIds).toContain(2);
    expect(snapshot.songKeys?.["2"]).toBe("at:b\u0000two");
  });

  it("still removes favorite when Last.fm alone cancels love (P1-新 1a N11)", async () => {
    // 用户只在 Last.fm 取消红心、本地仍在收藏 → 完整轮仍应 removeSongs（正确行为，不能被修法破坏）。
    const favoritesId = 42;
    const library = [song(1, "A", "One"), song(2, "B", "Two")];
    const playlistSongs = [1, 2];
    const removeCalls: number[][] = [];
    let snapshot: WritebackSnapshot = {
      ts: 1,
      lovedKeys: ["at:a\u0000one", "at:b\u0000two"],
      favoriteIds: [1, 2],
      songKeys: { "1": "at:a\u0000one", "2": "at:b\u0000two" },
    };
    const playlists = {
      async list(): Promise<Playlist[]> {
        return [
          {
            id: favoritesId,
            type: "normal",
            name: "收藏",
            description: "",
            cover_url: "",
            labels: ["built_in"],
            song_count: playlistSongs.length,
            created_at: "",
            updated_at: "",
            sort_by: "position",
            sort_order: "asc",
          },
        ];
      },
      async getSongs(
        _playlistId: number,
        opts?: { limit?: number; offset?: number }
      ): Promise<Song[]> {
        const offset = opts?.offset ?? 0;
        const limit = opts?.limit ?? 500;
        return playlistSongs
          .slice(offset, offset + limit)
          .map((id) => library.find((s) => s.id === id)!);
      },
      async addSongs(_playlistId: number, ids: number[]) {
        for (const id of ids) if (!playlistSongs.includes(id)) playlistSongs.push(id);
        return { added: ids.length, skipped: 0 };
      },
      async removeSongs(_playlistId: number, ids: number[]) {
        removeCalls.push([...ids]);
        for (const id of ids) {
          const i = playlistSongs.indexOf(id);
          if (i >= 0) playlistSongs.splice(i, 1);
        }
      },
    };
    const service = new WritebackService({
      playlists: playlists as never,
      library: {
        list: async () => library,
        getById: async (id: number) => library.find((s) => s.id === id) ?? null,
      },
      store: {
        load: async () => snapshot,
        save: async (s) => {
          snapshot = s;
        },
      },
      getWriteApi: async () => ({
        love: async () => {},
        unlove: async () => {},
      }),
      withLock: async (fn) => ({ skipped: false as const, result: await fn() }),
      sleep: async () => {},
      echoDrainMs: 0,
    });

    const r = await service.reconcileFavorites({
      scrobbler: {
        getLovedTracks: async () => ({
          tracks: [{ artist: "A", title: "One" }],
          truncated: false,
        }),
      },
      username: "u",
      hardCap: 1000,
      now: 100,
    });
    expect(r.ok).toBe(true);
    expect(removeCalls.some((c) => c.includes(2))).toBe(true);
    expect(playlistSongs).not.toContain(2);
    expect(r.snapshot?.favoriteIds).not.toContain(2);
  });

  it("removes both same-name favorite copies when Last.fm alone cancels (N11 duplicates)", async () => {
    // 两份同名同艺人都在收藏、只在 Last.fm 取消红心 → 两份都要从收藏移除；多轮不得加回、不得卡死。
    const favoritesId = 42;
    const library = [song(1, "A", "One"), song(2, "B", "Two"), song(5, "B", "Two")];
    const playlistSongs = [1, 2, 5];
    const removeCalls: number[][] = [];
    const addCalls: number[][] = [];
    let snapshot: WritebackSnapshot = {
      ts: 1,
      lovedKeys: ["at:a\u0000one", "at:b\u0000two"],
      favoriteIds: [1, 2, 5],
      songKeys: { "1": "at:a\u0000one", "2": "at:b\u0000two" },
    };
    const playlists = {
      async list(): Promise<Playlist[]> {
        return [
          {
            id: favoritesId,
            type: "normal",
            name: "收藏",
            description: "",
            cover_url: "",
            labels: ["built_in"],
            song_count: playlistSongs.length,
            created_at: "",
            updated_at: "",
            sort_by: "position",
            sort_order: "asc",
          },
        ];
      },
      async getSongs(
        _playlistId: number,
        opts?: { limit?: number; offset?: number }
      ): Promise<Song[]> {
        const offset = opts?.offset ?? 0;
        const limit = opts?.limit ?? 500;
        return playlistSongs
          .slice(offset, offset + limit)
          .map((id) => library.find((s) => s.id === id)!);
      },
      async addSongs(_playlistId: number, ids: number[]) {
        addCalls.push([...ids]);
        for (const id of ids) if (!playlistSongs.includes(id)) playlistSongs.push(id);
        return { added: ids.length, skipped: 0 };
      },
      async removeSongs(_playlistId: number, ids: number[]) {
        removeCalls.push([...ids]);
        for (const id of ids) {
          const i = playlistSongs.indexOf(id);
          if (i >= 0) playlistSongs.splice(i, 1);
        }
      },
    };
    const service = new WritebackService({
      playlists: playlists as never,
      library: {
        list: async () => library,
        getById: async (id: number) => library.find((s) => s.id === id) ?? null,
      },
      store: {
        load: async () => snapshot,
        save: async (s) => {
          snapshot = s;
        },
      },
      getWriteApi: async () => ({
        love: async () => {},
        unlove: async () => {},
      }),
      withLock: async (fn) => ({ skipped: false as const, result: await fn() }),
      sleep: async () => {},
      echoDrainMs: 0,
    });

    const lovedOnlyOne = {
      getLovedTracks: async () => ({
        tracks: [{ artist: "A", title: "One" }],
        truncated: false,
      }),
    };
    const r1 = await service.reconcileFavorites({
      scrobbler: lovedOnlyOne,
      username: "u",
      hardCap: 1000,
      now: 100,
    });
    expect(r1.ok).toBe(true);
    expect(removeCalls.some((c) => c.includes(2) && c.includes(5))).toBe(true);
    expect(playlistSongs).toEqual([1]);
    expect(r1.snapshot?.favoriteIds).toEqual([1]);

    removeCalls.length = 0;
    addCalls.length = 0;
    const r2 = await service.reconcileFavorites({
      scrobbler: lovedOnlyOne,
      username: "u",
      hardCap: 1000,
      now: 200,
    });
    expect(r2.ok).toBe(true);
    expect(removeCalls).toEqual([]);
    expect(addCalls).toEqual([]);
    expect(playlistSongs).toEqual([1]);
    expect(r2.snapshot?.favoriteIds).toEqual([1]);
  });

  it("keeps lovedKeys when skippedAddIds sibling lacks artist/title (D1)", async () => {
    // 兄弟行存在但缺 artist/title（未解析标签）+ 收藏分页不完整 → 起点键必须保住；
    // 下一完整轮不得 addSongs 把同歌另一份加进收藏。
    const favoritesId = 42;
    const library = [
      song(1, "A", "One"),
      song(2, "B", "Two"),
      { ...song(5, "", ""), artist: "", title: "" },
    ];
    const playlistSongs = [1, 5];
    const addCalls: number[][] = [];
    let forceIncomplete = true;
    let snapshot: WritebackSnapshot = {
      ts: 1,
      lovedKeys: ["at:a\u0000one"],
      favoriteIds: [1, 5],
      songKeys: { "1": "at:a\u0000one", "5": "at:b\u0000two" },
    };
    const playlists = {
      async list(): Promise<Playlist[]> {
        return [
          {
            id: favoritesId,
            type: "normal",
            name: "收藏",
            description: "",
            cover_url: "",
            labels: ["built_in"],
            song_count: playlistSongs.length,
            created_at: "",
            updated_at: "",
            sort_by: "position",
            sort_order: "asc",
          },
        ];
      },
      async getSongs(
        _playlistId: number,
        opts?: { limit?: number; offset?: number }
      ): Promise<Song[]> {
        const limit = opts?.limit ?? 500;
        const offset = opts?.offset ?? 0;
        if (forceIncomplete) {
          // 宿主忽略 offset：永远返回满页 → complete=false
          const page = playlistSongs.map((id) => library.find((s) => s.id === id)!);
          while (page.length < 500) page.push(song(page[0]?.id ?? 1, "", ""));
          return page;
        }
        return playlistSongs
          .slice(offset, offset + limit)
          .map((id) => library.find((s) => s.id === id)!);
      },
      async addSongs(_playlistId: number, ids: number[]) {
        addCalls.push([...ids]);
        for (const id of ids) if (!playlistSongs.includes(id)) playlistSongs.push(id);
        return { added: ids.length, skipped: 0 };
      },
      async removeSongs(_playlistId: number, ids: number[]) {
        for (const id of ids) {
          const i = playlistSongs.indexOf(id);
          if (i >= 0) playlistSongs.splice(i, 1);
        }
      },
    };
    const service = new WritebackService({
      playlists: playlists as never,
      library: {
        list: async () => library,
        getById: async (id: number) => library.find((s) => s.id === id) ?? null,
      },
      store: {
        load: async () => snapshot,
        save: async (s) => {
          snapshot = s;
        },
      },
      getWriteApi: async () => ({
        love: async () => {},
        unlove: async () => {},
      }),
      withLock: async (fn) => ({ skipped: false as const, result: await fn() }),
      sleep: async () => {},
      echoDrainMs: 0,
    });

    const lovedBoth = {
      getLovedTracks: async () => ({
        tracks: [
          { artist: "A", title: "One" },
          { artist: "B", title: "Two" },
        ],
        truncated: false,
      }),
    };
    const r1 = await service.reconcileFavorites({
      scrobbler: lovedBoth,
      username: "u",
      hardCap: 1000,
      now: 100,
    });
    expect(r1.ok).toBe(true);
    expect(r1.added).toBe(0);
    expect(addCalls).toEqual([]);
    expect(snapshot.lovedKeys || []).toContain("at:b\u0000two");
    expect(playlistSongs).toEqual([1, 5]);

    forceIncomplete = false;
    addCalls.length = 0;
    const r2 = await service.reconcileFavorites({
      scrobbler: lovedBoth,
      username: "u",
      hardCap: 1000,
      now: 200,
    });
    expect(r2.ok).toBe(true);
    expect(addCalls).toEqual([]);
    expect(playlistSongs).toEqual([1, 5]);
    expect(r2.snapshot?.favoriteIds?.sort((a, b) => a - b)).toEqual([1, 5]);
  });

  it("keeps lovedKeys when skippedAddIds sibling has full metadata (D2)", async () => {
    // 对照：兄弟行有完整 artist/title 时，不完整轮同样保住键、下一完整轮不得加副本。
    const favoritesId = 42;
    const library = [song(1, "A", "One"), song(2, "B", "Two"), song(5, "B", "Two")];
    const playlistSongs = [1, 5];
    const addCalls: number[][] = [];
    let forceIncomplete = true;
    let snapshot: WritebackSnapshot = {
      ts: 1,
      lovedKeys: ["at:a\u0000one"],
      favoriteIds: [1, 5],
      songKeys: { "1": "at:a\u0000one", "5": "at:b\u0000two" },
    };
    const playlists = {
      async list(): Promise<Playlist[]> {
        return [
          {
            id: favoritesId,
            type: "normal",
            name: "收藏",
            description: "",
            cover_url: "",
            labels: ["built_in"],
            song_count: playlistSongs.length,
            created_at: "",
            updated_at: "",
            sort_by: "position",
            sort_order: "asc",
          },
        ];
      },
      async getSongs(
        _playlistId: number,
        opts?: { limit?: number; offset?: number }
      ): Promise<Song[]> {
        const limit = opts?.limit ?? 500;
        const offset = opts?.offset ?? 0;
        if (forceIncomplete) {
          const page = playlistSongs.map((id) => library.find((s) => s.id === id)!);
          while (page.length < 500) page.push(song(page[0]?.id ?? 1, "", ""));
          return page;
        }
        return playlistSongs
          .slice(offset, offset + limit)
          .map((id) => library.find((s) => s.id === id)!);
      },
      async addSongs(_playlistId: number, ids: number[]) {
        addCalls.push([...ids]);
        for (const id of ids) if (!playlistSongs.includes(id)) playlistSongs.push(id);
        return { added: ids.length, skipped: 0 };
      },
      async removeSongs(_playlistId: number, ids: number[]) {
        for (const id of ids) {
          const i = playlistSongs.indexOf(id);
          if (i >= 0) playlistSongs.splice(i, 1);
        }
      },
    };
    const service = new WritebackService({
      playlists: playlists as never,
      library: {
        list: async () => library,
        getById: async (id: number) => library.find((s) => s.id === id) ?? null,
      },
      store: {
        load: async () => snapshot,
        save: async (s) => {
          snapshot = s;
        },
      },
      getWriteApi: async () => ({
        love: async () => {},
        unlove: async () => {},
      }),
      withLock: async (fn) => ({ skipped: false as const, result: await fn() }),
      sleep: async () => {},
      echoDrainMs: 0,
    });

    const lovedBoth = {
      getLovedTracks: async () => ({
        tracks: [
          { artist: "A", title: "One" },
          { artist: "B", title: "Two" },
        ],
        truncated: false,
      }),
    };
    const r1 = await service.reconcileFavorites({
      scrobbler: lovedBoth,
      username: "u",
      hardCap: 1000,
      now: 100,
    });
    expect(r1.ok).toBe(true);
    expect(r1.added).toBe(0);
    expect(addCalls).toEqual([]);
    expect(snapshot.lovedKeys || []).toContain("at:b\u0000two");
    expect(playlistSongs).toEqual([1, 5]);

    forceIncomplete = false;
    addCalls.length = 0;
    const r2 = await service.reconcileFavorites({
      scrobbler: lovedBoth,
      username: "u",
      hardCap: 1000,
      now: 200,
    });
    expect(r2.ok).toBe(true);
    expect(addCalls).toEqual([]);
    expect(playlistSongs).toEqual([1, 5]);
    expect(r2.snapshot?.favoriteIds?.sort((a, b) => a - b)).toEqual([1, 5]);
  });
});
