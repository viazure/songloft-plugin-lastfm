/**
 * 收藏 ↔ Last.fm 写回编排：事件订阅、起点维护、三路合并落盘。
 * 事件/曲库/歌单/Last.fm 全部可注入，测试不依赖宿主。
 */

import type { LibrarySongRef } from "./match";
import { artistTitleKey, matchLovedTracks, normalizeText } from "./match";
import {
  buildWritebackSnapshot,
  isLovedListUnsafe,
  lovedKeyOf,
  planWritebackMerge,
  songMatchKeyOf,
  type TrackIdentity,
  type WritebackSnapshot,
} from "./writeback-merge";
import {
  HOST_EVENT_SUPPORT_HINT,
  isPlaylistSongsChangeSupported,
  isRetryableWritebackError,
  LovedWritebackQueue,
  subscribePlaylistSongsChange,
  unsubscribePlaylistSongsChange,
  type PlaylistSongsChangeEvent,
  type WritebackJob,
  type WritebackQueueDeferReason,
} from "./writeback";
import { EchoSuppressor } from "./echo";
import {
  findBuiltInFavorites,
  listAllLibrarySongs,
  listAllPlaylistSongsDetailed,
  type PlaylistsApi,
} from "./loved-playlist";

/** 只依赖实际用到的字段，避免绑定 SDK 全局 Song 类型。 */
export interface WritebackSongLike {
  id: number;
  type?: string;
  title?: string;
  artist?: string;
}

export interface WritebackLibraryApi {
  list(options?: { limit?: number; offset?: number }): Promise<WritebackSongLike[]>;
  getById(id: number): Promise<WritebackSongLike | null>;
}

export interface WritebackSnapshotStore {
  load(): Promise<WritebackSnapshot | null>;
  save(snapshot: WritebackSnapshot): Promise<void>;
}

export interface WritebackLovedSource {
  getLovedTracks(opts?: {
    username?: string;
    hardCap?: number;
  }): Promise<{ tracks: Array<{ artist: string; title: string; mbid?: string }>; truncated: boolean }>;
}

export interface WritebackWriteApi {
  love(artist: string, title: string): Promise<void>;
  unlove(artist: string, title: string): Promise<void>;
}

export interface WritebackDeps {
  events?: unknown;
  playlists: PlaylistsApi;
  library: WritebackLibraryApi;
  store: WritebackSnapshotStore;
  getWriteApi: () => Promise<WritebackWriteApi | null>;
  withLock<T>(fn: () => Promise<T>): Promise<{ skipped: true } | { skipped: false; result: T }>;
  onInvalidSession?: () => Promise<void> | void;
  log?: (level: "info" | "warn" | "error", message: string) => void;
  /** 单曲写回成功后追加到「最近记录」的机会（可选）。 */
  onWritebackRecord?: (job: WritebackJob, ok: boolean, reason?: string) => Promise<void> | void;
  suppressor?: EchoSuppressor;
  /** 退避用，测试注入以免等待真实时间。 */
  sleep?: (ms: number) => Promise<void>;
  maxAttempts?: number;
  baseDelayMs?: number;
  /** 写入收藏后短 drain 等待（默认 50ms）。 */
  echoDrainMs?: number;
}

/** 事件曲种判定：只有确定是电台才拒绝；查询失败不丢用户点击。 */
export type SongTypeVerdict = "allow" | "reject_radio" | "reject_unknown";

export async function classifyEventSong(
  songs: WritebackLibraryApi | null | undefined,
  event: PlaylistSongsChangeEvent
): Promise<{ verdict: SongTypeVerdict; artist: string; title: string }> {
  const fallbackArtist = String(event?.song?.artist || "").trim();
  const fallbackTitle = String(event?.song?.title || "").trim();
  let song: WritebackSongLike | null = null;
  try {
    song = (await songs?.getById(event.songId)) ?? null;
  } catch {
    song = null;
  }
  if (song) {
    if (song.type === "radio") {
      return { verdict: "reject_radio", artist: "", title: "" };
    }
    const artist = String(song.artist || fallbackArtist).trim();
    const title = String(song.title || fallbackTitle).trim();
    return { verdict: artist && title ? "allow" : "reject_unknown", artist, title };
  }
  return fallbackArtist && fallbackTitle
    ? { verdict: "allow", artist: fallbackArtist, title: fallbackTitle }
    : { verdict: "reject_unknown", artist: "", title: "" };
}

export interface MergeRunResult {
  ok: boolean;
  /** 首次开启/无起点：只记起点，没有应用任何差量。 */
  initializedSnapshot: boolean;
  snapshot: WritebackSnapshot | null;
  loved: number;
  matched: number;
  unmatched: number;
  truncated: boolean;
  unmatchedSamples: Array<{ artist: string; title: string }>;
  added: number;
  removed: number;
  lovedCount: number;
  unlovedCount: number;
  conflicts: number;
  removalsSuppressed?: boolean;
  /** 起点本身不完整（起点生成时 Loved 已截断）：后续完整拉取可能表现为分批补齐历史。 */
  baselineIncomplete?: boolean;
  reason?: string;
  /** 解析到的内置收藏 playlistId（不写死为 1）。 */
  playlistId?: number;
}

export interface WritebackRuntimeStatus {
  queueSize: number;
  queuePaused: boolean;
  deferReason: WritebackQueueDeferReason;
  lastError: string;
}

export class WritebackService {
  private deps: WritebackDeps;
  readonly suppressor: EchoSuppressor;
  private queue: LovedWritebackQueue;
  private favoritesPlaylistId: number | null = null;

  constructor(deps: WritebackDeps) {
    this.deps = deps;
    this.suppressor = deps.suppressor ?? new EchoSuppressor();
    this.queue = this.createQueue();
  }

  private createQueue(): LovedWritebackQueue {
    return new LovedWritebackQueue({
      love: async (artist, title) => {
        const api = await this.deps.getWriteApi();
        if (!api) throw new Error("尚未连接账号");
        await api.love(artist, title);
      },
      unlove: async (artist, title) => {
        const api = await this.deps.getWriteApi();
        if (!api) throw new Error("尚未连接账号");
        await api.unlove(artist, title);
      },
      withLock: this.deps.withLock,
      onInvalidSession: this.deps.onInvalidSession,
      onApplied: async (job) => {
        await this.recordApplied(job);
      },
      log: this.deps.log,
      sleep: this.deps.sleep,
      maxAttempts: this.deps.maxAttempts,
      baseDelayMs: this.deps.baseDelayMs,
    });
  }

  queueSize(): number {
    return this.queue.size();
  }

  isQueuePaused(): boolean {
    return this.queue.isPaused();
  }

  runtimeStatus(): WritebackRuntimeStatus {
    return {
      queueSize: this.queue.size(),
      queuePaused: this.queue.isPaused(),
      deferReason: this.queue.lastDefer(),
      lastError: this.queue.lastFailure(),
    };
  }

  resumeQueue(): void {
    this.queue.resume();
  }

  /** 旧宿主返回 false 并给出升级提示；不抛异常。 */
  async attachEvents(): Promise<boolean> {
    const ok = await subscribePlaylistSongsChange(this.deps.events, (event) =>
      this.handleEvent(event)
    );
    if (!ok) {
      this.deps.log?.("warn", HOST_EVENT_SUPPORT_HINT);
    } else {
      await this.refreshFavoritesPlaylistId();
    }
    return ok;
  }

  async detachEvents(): Promise<void> {
    await unsubscribePlaylistSongsChange(this.deps.events);
    this.favoritesPlaylistId = null;
  }

  private async refreshFavoritesPlaylistId(): Promise<number | null> {
    try {
      const favorites = await findBuiltInFavorites(this.deps.playlists);
      this.favoritesPlaylistId = favorites?.id ?? null;
      return this.favoritesPlaylistId;
    } catch {
      return this.favoritesPlaylistId;
    }
  }

  async handleEvent(event: PlaylistSongsChangeEvent): Promise<void> {
    if (!event || typeof event !== "object") return;
    const type = event.type === "add" ? "add" : event.type === "remove" ? "remove" : null;
    if (!type) return;
    if (typeof event.songId !== "number" || !Number.isFinite(event.songId)) return;

    let favoritesId = this.favoritesPlaylistId;
    if (favoritesId == null || event.playlistId !== favoritesId) {
      favoritesId = await this.refreshFavoritesPlaylistId();
    }
    if (favoritesId == null || event.playlistId !== favoritesId) return;

    if (this.suppressor.consume(event.playlistId, event.songId, type)) return;

    // 完整起点落地前不入队，避免 love 成功后拼出残缺 snapshot 触发历史追平。
    const baseline = await this.deps.store.load();
    if (!baseline) {
      this.deps.log?.("info", `[lastfm] 尚无写回起点，跳过收藏事件：songId=${event.songId}`);
      return;
    }

    const { verdict, artist, title } = await classifyEventSong(this.deps.library, event);
    if (verdict !== "allow") {
      if (verdict === "reject_radio") {
        this.deps.log?.("info", `[lastfm] 跳过电台收藏写回：songId=${event.songId}`);
      }
      return;
    }

    if (type === "remove") {
      const shouldUnlove = await this.shouldUnloveKey({ artist, title, songId: event.songId });
      if (!shouldUnlove) {
        this.deps.log?.(
          "info",
          `[lastfm] 跳过 unlove：同键仍有其它曲目在收藏（${artist} - ${title}）`
        );
        return;
      }
    }

    this.enqueue({
      songId: event.songId,
      artist,
      title,
      action: type === "add" ? "love" : "unlove",
    });
  }

  /** unlove 仅当该 key 下已没有任何一首仍在内置收藏里。 */
  private async shouldUnloveKey(input: {
    artist: string;
    title: string;
    songId: number;
  }): Promise<boolean> {
    const favorites = await findBuiltInFavorites(this.deps.playlists);
    if (!favorites) return false;
    const listed = await listAllPlaylistSongsDetailed(this.deps.playlists, favorites.id);
    if (!listed.complete) {
      this.deps.log?.("warn", "[lastfm] 收藏列表不完整，跳过本次 unlove");
      return false;
    }
    const key =
      lovedKeyOf({ artist: input.artist, title: input.title }) ||
      "at:" + artistTitleKey(normalizeText(input.artist), normalizeText(input.title));
    for (const s of listed.songs) {
      if (!s || s.id === input.songId) continue;
      if (s.type === "radio") continue;
      const otherKey = lovedKeyOf({ artist: String(s.artist || ""), title: String(s.title || "") });
      if (otherKey && otherKey === key) return false;
    }
    return true;
  }

  enqueue(job: WritebackJob): void {
    this.queue.enqueue(job);
  }

  async drainQueue(): Promise<void> {
    await this.queue.waitForIdle();
  }

  /** 写入收藏前登记预期事件，压掉插件自己造成的回响。 */
  registerFavoritesWrite(playlistId: number, toAdd: number[], toRemove: number[]): void {
    this.suppressor.expectDiff(playlistId, toAdd, toRemove);
  }

  /**
   * 按本轮差量写收藏并登记抑制；返回实际写入的差量与内层当前集合。
   * 不再用「期望全集 − 内层当前」推删除：窗口内用户新加的歌不在 toRemove 里，
   * 用户刚删的歌不在 current 里（不会被加回）；unsafe 时 allowRemove=false 则 toRemove 恒空。
   * 读取不完整时跳过全部 toAdd（与 toRemove 一样保守），避免把未读区间里已有的歌再加一次。
   */
  async writeFavoritesDiff(
    diff: { toAdd: number[]; toRemove: number[] },
    playlistId: number,
    opts?: { allowRemove?: boolean }
  ): Promise<{
    toAdd: number[];
    toRemove: number[];
    removalsSuppressed: boolean;
    currentIds: number[];
    complete: boolean;
    addsSkipped: boolean;
  }> {
    // 新一轮写入：先清上一轮残留，再登记本轮；drain 后不 endRound，晚到回响仍靠 roundKeys。
    this.suppressor.beginRound();
    const listed = await listAllPlaylistSongsDetailed(this.deps.playlists, playlistId);
    const currentIds = listed.songs.map((s) => s.id).filter((id) => Number.isFinite(id));
    const current = new Set(currentIds);
    const requestedAdd = (diff.toAdd || []).filter((id) => Number.isFinite(id));
    const requestedRemove = (diff.toRemove || []).filter((id) => Number.isFinite(id));
    // 不完整时 current 只是窗口：未读区间里的 id 会被误判为「不在收藏」→ 宁可本轮不加。
    const wantedAdd = requestedAdd.filter((id) => !current.has(id));
    const toAdd = listed.complete ? wantedAdd : [];
    const addsSkipped = !listed.complete && wantedAdd.length > 0;
    const allowRemove = opts?.allowRemove !== false;
    const wantedRemove = requestedRemove.filter((id) => current.has(id));
    const toRemove = !allowRemove || !listed.complete ? [] : wantedRemove;
    const removalsSuppressed = (!allowRemove || !listed.complete) && wantedRemove.length > 0;
    this.suppressor.expectDiff(playlistId, toAdd, toRemove);
    if (toAdd.length) await addInChunks(this.deps.playlists, playlistId, toAdd);
    if (toRemove.length) await this.deps.playlists.removeSongs(playlistId, toRemove);
    const drainMs = this.deps.echoDrainMs ?? 50;
    if (drainMs > 0) await (this.deps.sleep || ((ms: number) => new Promise((r) => setTimeout(r, ms))))(drainMs);
    return {
      toAdd,
      toRemove,
      removalsSuppressed,
      currentIds: [...current],
      complete: listed.complete,
      addsSkipped,
    };
  }

  /** 首次开启写回：只记录现状，不追平、不预览。收藏不存在/列表不完整则失败、不落盘。 */
  async buildSnapshot(input: {
    loved: Array<{ artist: string; title: string; mbid?: string }>;
    library?: LibrarySongRef[];
    truncated: boolean;
    now?: number;
  }): Promise<{ matched: number; unmatched: number; snapshot: WritebackSnapshot }> {
    const library = input.library ?? (await listAllLibrarySongs(this.deps.library));
    const favorites = await findBuiltInFavorites(this.deps.playlists);
    // 找不到内置「收藏」时不得落盘空 favoriteIds：否则收藏重建后会被当成「本地新增」批量 love。
    if (!favorites) {
      throw new Error("未找到内置「收藏」歌单，请稍后重试记下起点");
    }
    const listed = await listAllPlaylistSongsDetailed(this.deps.playlists, favorites.id);
    if (!listed.complete) {
      throw new Error("收藏列表不完整，请稍后重试记下起点");
    }
    const favoriteIds = listed.songs.map((s) => s.id).filter((id) => Number.isFinite(id));
    const built = buildWritebackSnapshot({
      loved: input.loved,
      library,
      favoriteIds,
      truncated: input.truncated,
      now: input.now,
    });
    await this.deps.store.save(built.snapshot);
    return { matched: built.matched, unmatched: built.unmatched, snapshot: built.snapshot };
  }

  /**
   * 写回开启 + 目的地为收藏时的手动/定时对账：按起点三路合并。
   * 无起点只记起点（本次不产生任何差量）。先写收藏，再写 Last.fm，全部成功才落盘。
   */
  async reconcileFavorites(input: {
    scrobbler: WritebackLovedSource;
    username: string;
    hardCap: number;
    now?: number;
  }): Promise<MergeRunResult> {
    const ts = input.now ?? Date.now();
    const empty = {
      initializedSnapshot: false,
      snapshot: null as WritebackSnapshot | null,
      loved: 0,
      matched: 0,
      unmatched: 0,
      truncated: false,
      unmatchedSamples: [] as Array<{ artist: string; title: string }>,
      added: 0,
      removed: 0,
      lovedCount: 0,
      unlovedCount: 0,
      conflicts: 0,
    };
    try {
      const loved = await input.scrobbler.getLovedTracks({
        username: input.username,
        hardCap: input.hardCap,
      });
      const library = await listAllLibrarySongs(this.deps.library);
      const favorites = await findBuiltInFavorites(this.deps.playlists);
      if (!favorites) {
        return { ...empty, ok: false, loved: loved.tracks.length, reason: "未找到内置「收藏」歌单" };
      }
      this.favoritesPlaylistId = favorites.id;
      const listed = await listAllPlaylistSongsDetailed(this.deps.playlists, favorites.id);
      const favoriteIds = listed.songs.map((s) => s.id).filter((id) => Number.isFinite(id));
      const incomplete = !listed.complete;
      const prev = await this.deps.store.load();

      // 无完整起点：只记起点、不 merge；收藏分页不完整则失败不落盘。
      if (!prev) {
        if (incomplete) {
          return {
            ...empty,
            ok: false,
            loved: loved.tracks.length,
            truncated: loved.truncated,
            playlistId: favorites.id,
            reason: "收藏列表不完整，请稍后重试记下起点",
          };
        }
        const built = buildWritebackSnapshot({
          loved: loved.tracks,
          library,
          favoriteIds,
          truncated: loved.truncated,
          now: ts,
        });
        await this.deps.store.save(built.snapshot);
        this.deps.log?.(
          "info",
          `[lastfm] 写回起点已建立：loved=${built.snapshot.lovedKeys.length} 收藏=${built.snapshot.favoriteIds.length}`
        );
        const match = matchLovedTracks(loved.tracks, library);
        return {
          ...empty,
          ok: true,
          initializedSnapshot: true,
          snapshot: built.snapshot,
          loved: loved.tracks.length,
          matched: match.matched,
          unmatched: match.unmatched,
          truncated: loved.truncated,
          unmatchedSamples: match.unmatchedSamples,
          playlistId: favorites.id,
          removalsSuppressed: isLovedListUnsafe({
            lovedCount: loved.tracks.length,
            truncated: loved.truncated,
            incomplete: false,
          }),
        };
      }

      const plan = planWritebackMerge({
        prev,
        loved: loved.tracks,
        truncated: loved.truncated,
        incomplete,
        library,
        favoriteIds,
        now: ts,
      });

      // 按本轮差量写收藏；快照簿记（prevFav/deferred）与 favoritesDesired 不参与写入。
      // 有 love/unlove 时也走内层读取，用完整 current 过滤远端写入（P2-新 3）。
      let written = {
        toAdd: [] as number[],
        toRemove: [] as number[],
        removalsSuppressed: false,
        currentIds: null as number[] | null,
        complete: true,
        addsSkipped: false,
      };
      if (
        plan.addToFavorites.length ||
        plan.removeFromFavorites.length ||
        plan.love.length ||
        plan.unlove.length
      ) {
        written = await this.writeFavoritesDiff(
          { toAdd: plan.addToFavorites, toRemove: plan.removeFromFavorites },
          favorites.id,
          { allowRemove: !plan.removalsSuppressed }
        );
      }
      const favoriteRemovalsSuppressed = written.removalsSuppressed;
      const removalsSuppressed = plan.removalsSuppressed || favoriteRemovalsSuppressed;

      // 内层完整时：love 只保留仍在收藏的，unlove 只保留已不在收藏的（窗口内用户操作优先）。
      // current 基底会吸收窗口内用户双向改动，必须补写对应的远端 love/unlove，否则永久不再重试。
      let love = plan.love;
      let unlove = plan.unlove;
      if (written.currentIds != null && written.complete) {
        const current = new Set(written.currentIds);
        love = plan.love.filter((t) => current.has(t.songId));
        unlove = plan.unlove.filter((t) => !current.has(t.songId));
        // P2-新 5：窗口内用户加进收藏的歌会被 current 基底吸收进起点，必须本轮补 love。
        for (const id of current) {
          if (written.toAdd.includes(id)) continue;
          if (prev.favoriteIds.includes(id)) continue;
          if (love.some((t) => t.songId === id)) continue;
          const meta = library.find((x) => x.id === id);
          if (!meta?.artist || !meta?.title) continue;
          const k = lovedKeyOf({ artist: meta.artist, title: meta.title });
          if (k && (prev.lovedKeys || []).includes(k)) continue;
          love.push({ songId: id, artist: meta.artist, title: meta.title, key: k || undefined });
        }
        // P2-新 6：窗口内用户删掉的歌会被摘出起点，必须补 unlove；Loved 不安全时严禁补写。
        if (!plan.removalsSuppressed) {
          for (const id of prev.favoriteIds) {
            if (current.has(id)) continue;
            if (written.toRemove.includes(id)) continue;
            if (unlove.some((t) => t.songId === id)) continue;
            const meta = library.find((x) => x.id === id);
            if (!meta?.artist || !meta?.title) continue;
            // P2-a：优先 songKeys（可能是 mbid:），勿只用 lovedKeyOf 的 at: 键，否则带 mbid 的曲永不补 unlove。
            const k =
              plan.next.songKeys?.[String(id)] ||
              prev.songKeys?.[String(id)] ||
              lovedKeyOf({ artist: meta.artist, title: meta.title });
            if (!k || !(plan.next.lovedKeys || []).includes(k)) continue;
            // P2-新 1：同歌判定用 mbid 无关归一键（兄弟常无 songKeys，库 Song 也无 mbid）。
            const stillInFav = [...current].some((other) => {
              if (other === id) return false;
              const otherMeta = library.find((x) => x.id === other);
              if (!otherMeta?.artist || !otherMeta?.title) return false;
              const otherKey = songMatchKeyOf(otherMeta);
              return otherKey != null && otherKey === songMatchKeyOf(meta);
            });
            if (stillInFav) continue;
            unlove.push({ songId: id, artist: meta.artist, title: meta.title, key: k });
          }
        }
      }

      const writeApi = await this.deps.getWriteApi();
      if ((love.length || unlove.length) && !writeApi) {
        return {
          ...empty,
          ok: false,
          loved: loved.tracks.length,
          matched: plan.matched,
          unmatched: plan.unmatched,
          truncated: loved.truncated,
          playlistId: favorites.id,
          reason: "尚未连接账号",
        };
      }
      for (const track of love) {
        await this.applyWrite(writeApi!, "love", track);
      }
      for (const track of unlove) {
        await this.applyWrite(writeApi!, "unlove", track);
      }

      // 被抑制的删除不要从起点推进掉；lovedKeys/songKeys 也要回填，否则两边都「无变化」永久卡死。
      let next = plan.next;
      const actuallyRemoved = new Set(written.toRemove);
      const suppressedRemoves = plan.removeFromFavorites.filter((id) => !actuallyRemoved.has(id));
      const skippedLove = plan.love.filter((t) => !love.some((x) => x.songId === t.songId));
      const skippedUnlove = plan.unlove.filter((t) => !unlove.some((x) => x.songId === t.songId));
      const innerCurrent =
        written.currentIds != null && written.complete ? new Set(written.currentIds) : null;

      let favIds: Set<number>;
      if (innerCurrent) {
        // 完整内层：favoriteIds 以实际当前为基底，再叠本轮实际写入；保留簿记-only id（unsafe/deferred）。
        favIds = new Set(written.currentIds!);
        for (const id of written.toAdd) favIds.add(id);
        for (const id of written.toRemove) favIds.delete(id);
        const desired = new Set(plan.favoritesDesired);
        for (const id of plan.next.favoriteIds) {
          if (!desired.has(id)) favIds.add(id);
        }
      } else {
        favIds = new Set(next.favoriteIds);
        // 跳过的 add 不得当成「已在收藏」推进起点，否则下一轮两边无变化、永久不重试。
        if (written.addsSkipped) {
          for (const id of plan.addToFavorites) {
            if (!written.toAdd.includes(id)) favIds.delete(id);
          }
        }
      }
      // P2-新 8：完整内层时，用户已经移出收藏的 id 不要再塞回 favoriteIds；
      // 内层不完整时仍回填三集合，保证下一轮能重试删除（P2-新 1）。
      const keptSuppressedRemoves: number[] = [];
      for (const id of suppressedRemoves) {
        if (innerCurrent && !innerCurrent.has(id) && !written.toAdd.includes(id)) continue;
        favIds.add(id);
        keptSuppressedRemoves.push(id);
      }

      let lovedKeys = new Set(next.lovedKeys);
      let songKeys: Record<string, string> = { ...(next.songKeys || {}) };
      for (const id of keptSuppressedRemoves) {
        const k = next.songKeys?.[String(id)] ?? prev.songKeys?.[String(id)];
        if (k) {
          lovedKeys.add(k);
          songKeys = { ...songKeys, [String(id)]: k };
        }
      }
      for (const t of skippedUnlove) {
        const k =
          t.key ||
          next.songKeys?.[String(t.songId)] ||
          prev.songKeys?.[String(t.songId)] ||
          lovedKeyOf({ artist: t.artist, title: t.title });
        if (k) {
          lovedKeys.add(k);
          songKeys = { ...songKeys, [String(t.songId)]: k };
        }
      }
      // P1-新 1：跳过的 add 既不能留在 favoriteIds，也不能把 Last.fm 的键留在 lovedKeys，
      // 否则下一轮 favDelta=0 且 lfmDelta=0，这首永远不再写进收藏。
      const skippedAddIds = plan.addToFavorites.filter(
        (id) => !written.toAdd.includes(id) && !favIds.has(id)
      );
      for (const id of skippedAddIds) {
        const k = songKeys[String(id)] ?? next.songKeys?.[String(id)] ?? prev.songKeys?.[String(id)];
        if (!k) continue;
        const selfMeta = library.find((x) => x.id === id);
        const selfMatch = selfMeta ? songMatchKeyOf(selfMeta) : null;
        const stillPresent = [...favIds].some((other) => {
          if (other === id) return false;
          const otherMeta = library.find((x) => x.id === other);
          if (selfMatch && otherMeta?.artist && otherMeta?.title) {
            const otherMatch = songMatchKeyOf(otherMeta);
            return otherMatch != null && otherMatch === selfMatch;
          }
          return songKeys[String(other)] === k;
        });
        if (!stillPresent) lovedKeys.delete(k);
        delete songKeys[String(id)];
      }
      for (const t of skippedLove) {
        const k = t.key || next.songKeys?.[String(t.songId)] || lovedKeyOf({ artist: t.artist, title: t.title });
        if (k) {
          const selfMatch = songMatchKeyOf({ artist: t.artist, title: t.title }) || k;
          const stillPresent = [...favIds].some((id) => {
            if (id === t.songId) return false;
            const otherMeta = library.find((x) => x.id === id);
            if (otherMeta?.artist && otherMeta?.title) {
              const otherMatch = songMatchKeyOf(otherMeta);
              return otherMatch != null && otherMatch === selfMatch;
            }
            return songKeys[String(id)] === k;
          });
          if (!stillPresent) lovedKeys.delete(k);
          delete songKeys[String(t.songId)];
        }
      }
      // 本轮实际执行的 love/unlove（含窗口补写）须记 songKeys；lovedKeys 只在「本轮 Loved 读取」已承认时改，
      // 不读 next.lovedKeys（曾含乐观写入，会让守卫失效 → P1-新 1）。
      const lovedNow = new Set(plan.lovedNowKeys || []);
      for (const t of love) {
        const k =
          t.key ||
          songKeys[String(t.songId)] ||
          next.songKeys?.[String(t.songId)] ||
          lovedKeyOf({ artist: t.artist, title: t.title });
        if (k) {
          // 只有本轮 Loved 读取已有该键才写入 lovedKeys（不并 prev：冲突重 love 时 prev 有键会再次乐观写入 → P1-新 1）。
          if (lovedNow.has(k)) lovedKeys.add(k);
          // 本轮未确认且这首歌原本不在收藏：prev 的陈旧键不得留在起点，
          // 否则下一完整轮会把它当成「远端取消」→ 删掉用户刚收藏的歌。
          else if (!prev.favoriteIds.includes(t.songId)) lovedKeys.delete(k);
          songKeys = { ...songKeys, [String(t.songId)]: k };
        }
      }
      for (const t of unlove) {
        const k =
          t.key ||
          songKeys[String(t.songId)] ||
          next.songKeys?.[String(t.songId)] ||
          prev.songKeys?.[String(t.songId)] ||
          lovedKeyOf({ artist: t.artist, title: t.title });
        if (k) {
          const stillPresent = [...favIds].some(
            (id) => id !== t.songId && songKeys[String(id)] === k
          );
          // 只有本轮 Loved 读取已无该键时才从三集合删除；否则等确认。
          if (!stillPresent && lovedNow.has(k)) continue;
          if (!stillPresent) lovedKeys.delete(k);
          delete songKeys[String(t.songId)];
        }
      }

      // P2-b：外层 unsafe 时窗口内删掉的歌会被完整内层 current 从起点摘掉，而本轮禁止 unlove
      // → 两侧都「无变化」，之后永不补 unlove。只把「Last.fm 仍爱且同 key 已无其它收藏」的 id 留在起点。
      if (innerCurrent && plan.removalsSuppressed) {
        for (const id of prev.favoriteIds) {
          if (innerCurrent.has(id)) continue;
          if (written.toAdd.includes(id) || written.toRemove.includes(id)) continue;
          const meta = library.find((x) => x.id === id);
          if (!meta?.artist || !meta?.title) continue;
          const k =
            songKeys[String(id)] ||
            next.songKeys?.[String(id)] ||
            prev.songKeys?.[String(id)] ||
            lovedKeyOf({ artist: meta.artist, title: meta.title });
          if (!k || !(plan.next.lovedKeys || []).includes(k)) continue;
          // P2-新 1：同歌判定用 mbid 无关归一键（兄弟常无 songKeys，库 Song 也无 mbid）。
          const stillInFav = [...innerCurrent].some((other) => {
            if (other === id) return false;
            const om = library.find((x) => x.id === other);
            if (!om?.artist || !om?.title) return false;
            const otherKey = songMatchKeyOf(om);
            return otherKey != null && otherKey === songMatchKeyOf(meta);
          });
          if (stillInFav) continue;
          favIds.add(id);
          lovedKeys.add(k);
          songKeys = { ...songKeys, [String(id)]: k };
        }
      }

      next = {
        ...next,
        favoriteIds: [...favIds],
        lovedKeys: [...lovedKeys],
        songKeys,
      };

      await this.deps.store.save(next);
      return {
        ok: true,
        initializedSnapshot: false,
        snapshot: next,
        loved: loved.tracks.length,
        matched: plan.matched,
        unmatched: plan.unmatched,
        truncated: loved.truncated,
        unmatchedSamples: plan.unmatchedSamples,
        added: written.toAdd.length,
        removed: written.toRemove.length,
        lovedCount: love.length,
        unlovedCount: unlove.length,
        conflicts: plan.conflicts,
        removalsSuppressed,
        baselineIncomplete: plan.baselineIncomplete,
        playlistId: favorites.id,
        reason: [
          plan.removalsSuppressed
            ? written.addsSkipped || written.toAdd.length === 0
              ? "Loved/收藏列表不完整，已跳过删除与 unlove"
              : "Loved/收藏列表不完整，已跳过删除与 unlove，仅做正向补齐"
            : "",
          favoriteRemovalsSuppressed && !plan.removalsSuppressed
            ? "收藏列表读取不完整，已跳过从收藏删除"
            : "",
          written.addsSkipped
            ? "收藏列表读取不完整，已跳过部分写入"
            : "",
          plan.baselineIncomplete ? "起点不完整（记录时 Last.fm 喜欢已截断），可能分批补齐历史" : "",
        ]
          .filter(Boolean)
          .join(" · ") || undefined,
      };
    } catch (e) {
      return { ...empty, ok: false, reason: String(e ?? "未知错误") };
    }
  }

  /**
   * 诊断「红心当前曲 / 取消红心」：只改 Last.fm，绝不改 Songloft「收藏」，也不改写回起点。
   * 产品意图：下次对账/覆盖才把这次 Last.fm 变化视为对端变更（那时才可能写进「收藏」）。
   * 若改 lovedKeys，三路合并会看不见这次 LFM 变化。
   */
  async noteManualLove(_input: {
    kind: "love" | "unlove";
    artist: string;
    title: string;
  }): Promise<{ snapshotUpdated: boolean; reason?: string }> {
    return {
      snapshotUpdated: false,
      reason: "诊断红心不改起点；下次对账才会把这次 Last.fm 变化视为对端变更",
    };
  }

  private async applyWrite(
    api: WritebackWriteApi,
    kind: "love" | "unlove",
    track: TrackIdentity
  ): Promise<void> {
    try {
      if (kind === "love") await api.love(track.artist, track.title);
      else await api.unlove(track.artist, track.title);
    } catch (e) {
      try {
        await this.deps.onWritebackRecord?.(
          { songId: track.songId, artist: track.artist, title: track.title, action: kind },
          false,
          String(e ?? "未知错误")
        );
      } catch {
        /* 观测失败不影响主流程 */
      }
      throw e;
    }
    try {
      await this.deps.onWritebackRecord?.(
        { songId: track.songId, artist: track.artist, title: track.title, action: kind },
        true
      );
    } catch {
      /* 观测失败不影响主流程 */
    }
  }

  private async recordApplied(job: WritebackJob): Promise<void> {
    await this.updateSnapshotForJob(job);
    try {
      await this.deps.onWritebackRecord?.(job, true);
    } catch {
      /* 观测失败不影响主流程 */
    }
  }

  private async updateSnapshotForJob(job: WritebackJob): Promise<void> {
    const prev = await this.deps.store.load();
    // 没有完整起点时绝不拼残缺 snapshot（否则后续 merge 会当成历史追平）。
    if (!prev) return;
    const now = Date.now();
    const key =
      prev.songKeys?.[String(job.songId)] ||
      lovedKeyOf({ artist: job.artist, title: job.title }) ||
      undefined;
    const lovedKeys = new Set(prev.lovedKeys || []);
    const favoriteIds = new Set(prev.favoriteIds || []);
    const songKeys: Record<string, string> = { ...(prev.songKeys || {}) };
    if (job.action === "love") {
      favoriteIds.add(job.songId);
      // 不把「已调 love」写成「远端已红心」，等下一次 Loved 读取确认。
      if (key) {
        songKeys[String(job.songId)] = key;
        // 该曲原本不在收藏（新收藏 / 取消后又收藏）：起点里的键可能是上一轮 unlove 留下的陈旧键，
        // 留着会让下一完整轮把它当成「远端取消」→ 删掉用户刚收藏的歌。
        if (!prev.favoriteIds.includes(job.songId)) lovedKeys.delete(key);
      }
    } else {
      favoriteIds.delete(job.songId);
      // 保留 lovedKeys，等 Loved 读取确认后再由 reconcile 摘掉。
      delete songKeys[String(job.songId)];
    }
    const next: WritebackSnapshot = {
      ts: now,
      lovedKeys: [...lovedKeys],
      favoriteIds: [...favoriteIds],
      songKeys,
    };
    if (prev.truncated) next.truncated = true;
    await this.deps.store.save(next);
  }
}

async function addInChunks(
  api: PlaylistsApi,
  playlistId: number,
  songIds: number[]
): Promise<void> {
  const CHUNK = 200;
  for (let i = 0; i < songIds.length; i += CHUNK) {
    await api.addSongs(playlistId, songIds.slice(i, i + CHUNK));
  }
}

export { isPlaylistSongsChangeSupported, isRetryableWritebackError };
