/**
 * 收藏 ↔ Last.fm 红心三路合并（纯函数，不做宿主 I/O）。
 * 起点 = 上次成功记下/对账时的 Last.fm Loved 键 + 已纳入同步的 songId。
 * 键与现有 match 逻辑一致：mbid 优先，否则规范化艺人 + 歌名。
 */

import {
  artistTitleKey,
  buildLibraryIndexes,
  normalizeMbid,
  normalizeText,
  resolveSongId,
  type LibrarySongRef,
  type LovedTrackRef,
} from "./match";

const SAMPLE_CAP = 10;

export interface WritebackSnapshot {
  /** 起点/上次成功对账时间（毫秒）。 */
  ts: number;
  /** 上次成功对账时 Last.fm Loved 的键集合。 */
  lovedKeys: string[];
  /** 上次成功对账时已纳入同步的 Songloft songId。 */
  favoriteIds: number[];
  /** songId → 键，用于后续单曲写回时定位 Last.fm 侧身份。 */
  songKeys?: Record<string, string>;
  /** 起点生成时 Last.fm 拉取已截断（>1000），Loved 侧不完全可信。 */
  truncated?: boolean;
}

export interface TrackIdentity {
  songId: number;
  artist: string;
  title: string;
  key?: string;
}

/** mbid 优先；缺艺人或歌名时无法定位，返回 null。 */
export function lovedKeyOf(track: {
  artist?: string | null;
  title?: string | null;
  mbid?: string | null;
}): string | null {
  const artist = normalizeText(track?.artist || "");
  const title = normalizeText(track?.title || "");
  if (!artist || !title) return null;
  const mbid = normalizeMbid(track?.mbid || undefined);
  if (mbid) return "mbid:" + mbid;
  return "at:" + artistTitleKey(artist, title);
}

/**
 * 「是否同一首歌」的归一键：忽略 mbid，只用规范化 artist+title。
 * 重复副本可能一份带 mbid、一份不带，且起点 songKeys 只为最小 id 记账；
 * 用 mbid 键去比会漏判 → 误 unlove。仅用于「同 key 是否仍有其它收藏」，不参与远端键生成。
 */
export function songMatchKeyOf(track: {
  artist?: string | null;
  title?: string | null;
}): string | null {
  return lovedKeyOf({ artist: track?.artist, title: track?.title });
}

type Indexes = ReturnType<typeof buildLibraryIndexes>;

/**
 * 写回/对账的歧义解析：重复命中视为歧义。
 * 正向「选哪首加入收藏」请用 match.resolveSongId（取最小 id）。
 */
export function resolveUniqueSongId(track: LovedTrackRef, indexes: Indexes): number | undefined {
  const mbid = normalizeMbid(track.mbid);
  if (mbid) {
    const hits = indexes.byMbid.get(mbid);
    if (hits && hits.length > 1) return undefined;
    if (hits && hits.length === 1) return hits[0];
  }
  const hits = indexes.byArtistTitle.get(artistTitleKey(track.artist, track.title));
  if (!hits || hits.length === 0) return undefined;
  return hits.length === 1 ? hits[0] : undefined;
}

function namesById(
  library: LibrarySongRef[]
): Map<number, { artist: string; title: string; mbid?: string }> {
  const out = new Map<number, { artist: string; title: string; mbid?: string }>();
  for (const s of library) {
    if (!Number.isFinite(s.id)) continue;
    if (!s.artist || !s.title) continue;
    out.set(s.id, { artist: s.artist, title: s.title, mbid: s.mbid });
  }
  return out;
}

function keyForSongId(
  id: number,
  songToKey: Map<number, string>,
  names: Map<number, { artist: string; title: string; mbid?: string }>
): string | null {
  const mapped = songToKey.get(id);
  if (mapped) return mapped;
  const name = names.get(id);
  if (!name) return null;
  return lovedKeyOf(name);
}

/** Loved / 列表不完整时：只允许正向加/love，禁止覆盖删除与 unlove。 */
export function isLovedListUnsafe(opts: {
  lovedCount: number;
  truncated: boolean;
  incomplete?: boolean;
}): boolean {
  if (opts.incomplete) return true;
  if (opts.truncated) return true;
  if (opts.lovedCount <= 0) return true;
  return false;
}

export interface SnapshotBuildInput {
  loved: LovedTrackRef[];
  library: LibrarySongRef[];
  favoriteIds: number[];
  truncated: boolean;
  now?: number;
}

export interface SnapshotBuildResult {
  snapshot: WritebackSnapshot;
  matched: number;
  unmatched: number;
  unmatchedSamples: Array<{ artist: string; title: string }>;
}

/** 首次开启写回：只记录现状，不产生任何 love / unlove 差量。 */
export function buildWritebackSnapshot(input: SnapshotBuildInput): SnapshotBuildResult {
  const indexes = buildLibraryIndexes(input.library);
  const lovedKeys = new Set<string>();
  const songKeys: Record<string, string> = {};
  const unmatchedSamples: Array<{ artist: string; title: string }> = [];
  let matched = 0;
  let unmatched = 0;
  for (const t of input.loved) {
    const key = lovedKeyOf(t);
    // 起点记录用最小 id 映射即可；unlove 时再按 key 组判断。
    const id = key ? resolveSongId(t, indexes) : undefined;
    if (!key || id == null) {
      unmatched += 1;
      if (unmatchedSamples.length < SAMPLE_CAP) {
        unmatchedSamples.push({ artist: t.artist || "", title: t.title || "" });
      }
      if (key) lovedKeys.add(key);
      continue;
    }
    matched += 1;
    lovedKeys.add(key);
    if (!songKeys[String(id)]) songKeys[String(id)] = key;
  }
  const snapshot: WritebackSnapshot = {
    ts: input.now ?? Date.now(),
    lovedKeys: [...lovedKeys],
    favoriteIds: [...new Set(input.favoriteIds.filter((n) => Number.isFinite(n)))],
    songKeys,
  };
  if (input.truncated) snapshot.truncated = true;
  return { snapshot, matched, unmatched, unmatchedSamples };
}

export interface MergeInput {
  prev: WritebackSnapshot;
  loved: LovedTrackRef[];
  truncated: boolean;
  /** 分页未完成 / 拉取残缺等，与 truncated、空列表一样禁止删除与 unlove。 */
  incomplete?: boolean;
  library: LibrarySongRef[];
  favoriteIds: number[];
  now?: number;
}

export interface MergePlan {
  /** 因为 Last.fm 侧新增而写入收藏。 */
  addToFavorites: number[];
  /** 因为 Last.fm 侧减少而从收藏移除（不完整列表时恒为空）。 */
  removeFromFavorites: number[];
  /**
   * 外层快照推算的「当前收藏 ∪ 本轮差量」集合（仅供断言/诊断）。
   * 实际写收藏必须用 addToFavorites / removeFromFavorites 差量，不得把本字段当期望全集。
   */
  favoritesDesired: number[];
  /** 因为收藏侧新增而 love。 */
  love: TrackIdentity[];
  /** 因为收藏侧减少而 unlove（同 key 仍有本地收藏时跳过）。 */
  unlove: TrackIdentity[];
  /** 只有在写入全部成功后才可落盘。 */
  next: WritebackSnapshot;
  /** 同一首自起点以来两边改向相反的次数（结果取本地收藏）。 */
  conflicts: number;
  matched: number;
  unmatched: number;
  unmatchedSamples: Array<{ artist: string; title: string }>;
  /** 本次因列表不完整而跳过了删除/unlove。 */
  removalsSuppressed: boolean;
  /**
   * 起点本身不完整（起点生成时 Loved 已截断）。
   * 只用于提示：后续完整拉取里多出来的键会按「正向加」写进收藏，可能看起来像分批补齐历史。
   */
  baselineIncomplete: boolean;
  /**
   * 本轮 Loved 实际读到的键集合（不含 plan.love / plan.unlove 的乐观写入）。
   * 写回起点 lovedKeys 时以此为准，避免把「已调用 API」当成「远端已达一致」。
   */
  lovedNowKeys: string[];
}

/**
 * 三路合并（起点 / Last.fm 现状 / 收藏现状）。
 * 空/截断/不完整：本次没拉全的键不能当作「已取消」，
 * 因此既不删收藏也不 unlove；只允许正向加/love。
 */
export function planWritebackMerge(input: MergeInput): MergePlan {
  const unsafe = isLovedListUnsafe({
    lovedCount: input.loved.length,
    truncated: input.truncated,
    incomplete: input.incomplete,
  });
  const prevLoved = new Set(input.prev.lovedKeys || []);
  const prevFav = new Set((input.prev.favoriteIds || []).filter((n) => Number.isFinite(n)));
  const curFav = new Set(input.favoriteIds.filter((n) => Number.isFinite(n)));
  const indexes = buildLibraryIndexes(input.library);
  const names = namesById(input.library);

  const curKeys = new Set<string>();
  /** 本轮 Loved 归一键（忽略 mbid），用于「远端是否仍报同一首歌」。 */
  const curMatchKeys = new Set<string>();
  const songToKey = new Map<number, string>();
  const unmatchedSamples: Array<{ artist: string; title: string }> = [];
  let matched = 0;
  let unmatched = 0;

  for (const t of input.loved) {
    const key = lovedKeyOf(t);
    // 正向写入收藏取最小 songId；不因歧义丢正向补齐。
    const id = key ? resolveSongId(t, indexes) : undefined;
    if (key) curKeys.add(key);
    const mk = songMatchKeyOf(t);
    if (mk) curMatchKeys.add(mk);
    if (!key || id == null) {
      unmatched += 1;
      if (unmatchedSamples.length < SAMPLE_CAP) {
        unmatchedSamples.push({ artist: t.artist || "", title: t.title || "" });
      }
      continue;
    }
    matched += 1;
    if (!songToKey.has(id)) songToKey.set(id, key);
  }
  for (const [sid, key] of Object.entries(input.prev.songKeys || {})) {
    const id = Number(sid);
    if (!Number.isFinite(id) || typeof key !== "string" || !key) continue;
    if (!songToKey.has(id)) songToKey.set(id, key);
  }

  const ids = new Set<number>();
  for (const id of prevFav) ids.add(id);
  for (const id of curFav) ids.add(id);
  for (const id of songToKey.keys()) ids.add(id);

  /** 曲库里仍存在的 songId；不在其中的 id 只可能来自陈旧起点。 */
  const libraryIds = new Set<number>();
  for (const s of input.library) {
    if (Number.isFinite(s.id)) libraryIds.add(s.id);
  }

  const addToFavorites: number[] = [];
  const removeFromFavorites: number[] = [];
  const love: TrackIdentity[] = [];
  const unlove: TrackIdentity[] = [];
  /** 想 unlove 但拿不到艺人/歌名：留到下次，不推进起点。 */
  const deferred: number[] = [];
  let conflicts = 0;
  /** 同 key 已计划过 unlove，避免重复调用。 */
  const unloveKeys = new Set<string>();

  for (const id of ids) {
    const key = keyForSongId(id, songToKey, names);
    const favPrev = prevFav.has(id);
    const favNow = curFav.has(id);
    const favDelta = favNow === favPrev ? 0 : favNow ? 1 : -1;

    const lfmPrev = !!(key && prevLoved.has(key));
    const inCurrent = !!(key && curKeys.has(key));
    // 不完整时，未出现在本次结果的键状态未知，不能推成「已取消」。
    const lfmKnown = !!key && (inCurrent || !unsafe);
    const lfmNow = !!key && inCurrent;
    const lfmDelta = !lfmKnown || lfmNow === lfmPrev ? 0 : lfmNow ? 1 : -1;

    if (favDelta === 0 && lfmDelta === 0) continue;

    const name = names.get(id);

    if (favDelta > 0 && lfmDelta < 0) {
      conflicts += 1; // 本地新增、远端取消 → 听本地
      if (name) love.push({ songId: id, artist: name.artist, title: name.title, key: key || undefined });
      continue;
    }
    if (favDelta < 0 && lfmDelta > 0) {
      conflicts += 1; // 本地取消、远端新增 → 听本地
      if (unsafe) {
        deferred.push(id);
        continue;
      }
      if (
        key &&
        [...curFav].some((other) => {
          if (other === id) return false;
          const otherName = names.get(other);
          const otherMatch = otherName
            ? songMatchKeyOf(otherName)
            : keyForSongId(other, songToKey, names);
          const selfMatch = name ? songMatchKeyOf(name) : key;
          return otherMatch != null && otherMatch === selfMatch;
        })
      ) {
        continue; // 同 key 仍有本地收藏，跳过 unlove
      }
      if (name && key && !unloveKeys.has(key)) {
        unloveKeys.add(key);
        unlove.push({ songId: id, artist: name.artist, title: name.title, key });
      } else if (!name) deferred.push(id);
      continue;
    }
    if (favDelta > 0) {
      // 本地新增：远端已知已红心就不必重复调用。
      if (!(lfmKnown && lfmNow) && name) {
        love.push({ songId: id, artist: name.artist, title: name.title, key: key || undefined });
      }
      continue;
    }
    if (favDelta < 0) {
      if (unsafe || !lfmKnown) {
        deferred.push(id);
        continue;
      }
      if (!lfmNow) continue; // 远端确实没有红心，无需 unlove
      if (
        key &&
        [...curFav].some((other) => {
          if (other === id) return false;
          const otherName = names.get(other);
          const otherMatch = otherName
            ? songMatchKeyOf(otherName)
            : keyForSongId(other, songToKey, names);
          const selfMatch = name ? songMatchKeyOf(name) : key;
          return otherMatch != null && otherMatch === selfMatch;
        })
      ) {
        continue;
      }
      if (name && key && !unloveKeys.has(key)) {
        unloveKeys.add(key);
        unlove.push({ songId: id, artist: name.artist, title: name.title, key });
      } else if (!name) deferred.push(id);
      continue;
    }
    if (lfmDelta > 0) {
      // 只有曲库里真实存在的 songId 才写进收藏：起点 songKeys 里可能残留已删除的 id，
      // 那种 id 进 addSongs 会让宿主报 song not found，整轮写回失败。
      if (!favNow && libraryIds.has(id)) addToFavorites.push(id);
      continue;
    }
    if (lfmDelta < 0 && favNow) {
      if (unsafe) continue;
      // 键制式漂移（mbid:↔at:）：起点只记了一种键，本轮 Loved 可能换成另一种形式报同一首。
      // 判据用「本轮 Loved 是否仍报同一首歌」，而不是「收藏里是否还有同歌副本」——
      // 后者会让两份副本互相保护，远端真取消后永不收敛（K8/K9）。
      if (key && name) {
        const selfMatch = songMatchKeyOf(name);
        if (selfMatch && curMatchKeys.has(selfMatch)) continue;
      }
      removeFromFavorites.push(id);
    }
  }

  // lovedKeys 只反映本轮实际读到的 Loved（unsafe 时并上起点）；
  // 不把 plan.love / plan.unlove 乐观写进 next——否则 run 侧 P2-c 守卫恒真，读滞后会误删收藏（P1-新 1）。
  const nextLoved = new Set<string>(unsafe ? [...prevLoved, ...curKeys] : [...curKeys]);
  const lovedNowKeys = [...curKeys];

  const nextFav = new Set<number>(curFav);
  for (const id of addToFavorites) nextFav.add(id);
  for (const id of removeFromFavorites) nextFav.delete(id);
  if (unsafe) for (const id of prevFav) nextFav.add(id);
  for (const id of deferred) nextFav.add(id);
  // 曲库里已经没有、又拿不到元数据的 id：不再留在起点簿记里，避免每轮重复 deferred。
  for (const id of deferred) {
    if (!libraryIds.has(id) && !curFav.has(id)) nextFav.delete(id);
  }

  // 真正写「收藏」用的期望集合：只认「当前收藏 ∪ 本轮新增 − 本轮移除」。
  // 快照簿记（unsafe 补回的 prevFav、deferred）只用于落盘，绝不参与写入。
  const desiredFav = new Set<number>(curFav);
  for (const id of addToFavorites) desiredFav.add(id);
  for (const id of removeFromFavorites) desiredFav.delete(id);

  const nextSongKeys: Record<string, string> = {};
  for (const [id, k] of songToKey) {
    if (nextFav.has(id) || nextLoved.has(k)) nextSongKeys[String(id)] = k;
  }
  for (const t of love) {
    const k = t.key || songToKey.get(t.songId) || lovedKeyOf({ artist: t.artist, title: t.title });
    if (k) nextSongKeys[String(t.songId)] = k;
  }
  for (const t of unlove) delete nextSongKeys[String(t.songId)];

  const next: WritebackSnapshot = {
    ts: input.now ?? Date.now(),
    lovedKeys: [...nextLoved],
    favoriteIds: [...nextFav],
    songKeys: nextSongKeys,
  };
  // truncated 只反映 Last.fm Loved 截断；收藏分页 incomplete 不得写入，否则状态行永久误报「起点不完整」。
  if (input.truncated) next.truncated = true;

  return {
    addToFavorites,
    removeFromFavorites,
    favoritesDesired: [...desiredFav],
    love,
    unlove,
    next,
    conflicts,
    matched,
    unmatched,
    unmatchedSamples,
    removalsSuppressed: unsafe,
    baselineIncomplete: input.prev.truncated === true,
    lovedNowKeys,
  };
}
