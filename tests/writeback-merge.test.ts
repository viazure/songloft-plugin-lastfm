import { describe, expect, it } from "vitest";
import {
  buildWritebackSnapshot,
  isLovedListUnsafe,
  lovedKeyOf,
  planWritebackMerge,
  songMatchKeyOf,
  type WritebackSnapshot,
} from "../src/writeback-merge";
import type { LibrarySongRef } from "../src/match";

const library: LibrarySongRef[] = [
  { id: 1, artist: "A", title: "One" },
  { id: 2, artist: "B", title: "Two" },
  { id: 3, artist: "C", title: "Three" },
  { id: 4, artist: "D", title: "Four" },
];

function snap(partial: Partial<WritebackSnapshot>): WritebackSnapshot {
  return { ts: 1, lovedKeys: [], favoriteIds: [], ...partial };
}

describe("lovedKeyOf", () => {
  it("prefers mbid and normalizes artist+title otherwise", () => {
    expect(lovedKeyOf({ artist: "A", title: "One", mbid: "ABC-1" })).toBe("mbid:abc-1");
    expect(lovedKeyOf({ artist: " A ", title: "ONE " })).toBe("at:a\u0000one");
    expect(lovedKeyOf({ artist: "00000000-0000-0000-0000-000000000000", title: "x" })).toBe(
      "at:00000000-0000-0000-0000-000000000000\u0000x"
    );
    expect(lovedKeyOf({ artist: "", title: "x" })).toBeNull();
    expect(lovedKeyOf({ artist: "a", title: "  " })).toBeNull();
  });
});

describe("isLovedListUnsafe", () => {
  it("treats empty / truncated / incomplete as unsafe", () => {
    expect(isLovedListUnsafe({ lovedCount: 0, truncated: false })).toBe(true);
    expect(isLovedListUnsafe({ lovedCount: 5, truncated: true })).toBe(true);
    expect(isLovedListUnsafe({ lovedCount: 5, truncated: false, incomplete: true })).toBe(true);
    expect(isLovedListUnsafe({ lovedCount: 5, truncated: false })).toBe(false);
  });
});

describe("buildWritebackSnapshot", () => {
  it("records current loved keys and favorites without any diff", () => {
    const built = buildWritebackSnapshot({
      loved: [
        { artist: "A", title: "One" },
        { artist: "Ghost", title: "Nope" },
      ],
      library,
      favoriteIds: [3],
      truncated: false,
      now: 42,
    });
    expect(built.snapshot.ts).toBe(42);
    expect(built.snapshot.favoriteIds).toEqual([3]);
    expect(built.snapshot.lovedKeys).toContain("at:a\u0000one");
    expect(built.snapshot.lovedKeys).toContain("at:ghost\u0000nope");
    expect(built.matched).toBe(1);
    expect(built.unmatched).toBe(1);
    expect(built.unmatchedSamples).toEqual([{ artist: "Ghost", title: "Nope" }]);
  });

  it("carries the truncated flag so a later merge knows the loved side is partial", () => {
    const built = buildWritebackSnapshot({
      loved: [{ artist: "A", title: "One" }],
      library,
      favoriteIds: [],
      truncated: true,
    });
    expect(built.snapshot.truncated).toBe(true);
  });
});

describe("planWritebackMerge", () => {
  it("pushes a Last.fm addition into favorites", () => {
    const plan = planWritebackMerge({
      prev: snap({ lovedKeys: ["at:a\u0000one"], favoriteIds: [1] }),
      loved: [
        { artist: "A", title: "One" },
        { artist: "B", title: "Two" },
      ],
      truncated: false,
      library,
      favoriteIds: [1],
    });
    expect(plan.addToFavorites).toEqual([2]);
    expect(plan.removeFromFavorites).toEqual([]);
    expect(plan.love).toEqual([]);
    expect(plan.unlove).toEqual([]);
    expect(plan.next.favoriteIds.sort()).toEqual([1, 2]);
  });

  it("removes a favorites song when Last.fm dropped it", () => {
    const plan = planWritebackMerge({
      prev: snap({
        lovedKeys: ["at:a\u0000one", "at:b\u0000two"],
        favoriteIds: [1, 2],
        songKeys: { "1": "at:a\u0000one", "2": "at:b\u0000two" },
      }),
      loved: [{ artist: "A", title: "One" }],
      truncated: false,
      library,
      favoriteIds: [1, 2],
    });
    expect(plan.removeFromFavorites).toEqual([2]);
    expect(plan.unlove).toEqual([]);
    expect(plan.next.favoriteIds).toEqual([1]);
  });

  it("loves a song the user added to favorites", () => {
    const plan = planWritebackMerge({
      prev: snap({ lovedKeys: ["at:a\u0000one"], favoriteIds: [1] }),
      loved: [{ artist: "A", title: "One" }],
      truncated: false,
      library,
      favoriteIds: [1, 3],
    });
    expect(plan.love.map((t) => t.songId)).toEqual([3]);
    expect(plan.love[0]?.key).toBe("at:c\u0000three");
    // P1-新 1：next.lovedKeys 等远端确认，不因已计划 love 而乐观写入。
    expect(plan.next.lovedKeys).not.toContain("at:c\u0000three");
    expect(plan.lovedNowKeys).toEqual(["at:a\u0000one"]);
    expect(plan.next.songKeys?.["3"]).toBe("at:c\u0000three");
  });

  it("unloves a song the user removed from favorites", () => {
    const plan = planWritebackMerge({
      prev: snap({
        lovedKeys: ["at:a\u0000one", "at:b\u0000two"],
        favoriteIds: [1, 2],
        songKeys: { "1": "at:a\u0000one", "2": "at:b\u0000two" },
      }),
      loved: [
        { artist: "A", title: "One" },
        { artist: "B", title: "Two" },
      ],
      truncated: false,
      library,
      favoriteIds: [1],
    });
    expect(plan.unlove.map((t) => t.songId)).toEqual([2]);
    expect(plan.unlove[0]?.key).toBe("at:b\u0000two");
    // P1-新 1：本轮 Loved 仍含该键 → next.lovedKeys 保留，等读取确认后再摘。
    expect(plan.next.lovedKeys.sort()).toEqual(["at:a\u0000one", "at:b\u0000two"].sort());
    expect(plan.lovedNowKeys.sort()).toEqual(["at:a\u0000one", "at:b\u0000two"].sort());
    expect(plan.next.favoriteIds).toEqual([1]);
  });

  it("does not unlove when another song with the same key remains in favorites", () => {
    const dupLibrary: LibrarySongRef[] = [
      { id: 11, artist: "A", title: "One" },
      { id: 12, artist: "a", title: "ONE" },
    ];
    const plan = planWritebackMerge({
      prev: snap({
        lovedKeys: ["at:a\u0000one"],
        favoriteIds: [11, 12],
        songKeys: { "11": "at:a\u0000one", "12": "at:a\u0000one" },
      }),
      loved: [{ artist: "A", title: "One" }],
      truncated: false,
      library: dupLibrary,
      favoriteIds: [12],
    });
    expect(plan.unlove).toEqual([]);
  });

  it("does not unlove mbid duplicate when sibling remains in favorites (P2-新 1 merge)", () => {
    const mbidTwo = "11111111-1111-1111-1111-111111111111";
    const mbidKey = `mbid:${mbidTwo}`;
    const dupLibrary: LibrarySongRef[] = [
      { id: 1, artist: "A", title: "One" },
      { id: 2, artist: "B", title: "Two" },
      { id: 5, artist: "B", title: "Two" },
    ];
    const plan = planWritebackMerge({
      prev: snap({
        lovedKeys: ["at:a\u0000one", mbidKey],
        favoriteIds: [1, 2, 5],
        songKeys: { "1": "at:a\u0000one", "2": mbidKey, "5": mbidKey },
      }),
      loved: [
        { artist: "A", title: "One" },
        { artist: "B", title: "Two", mbid: mbidTwo },
      ],
      truncated: false,
      library: dupLibrary,
      favoriteIds: [1, 5],
    });
    expect(plan.unlove).toEqual([]);
  });

  it("does not unlove mbid track when sibling has no songKeys (P2-新 1 natural merge)", () => {
    // 真实快照只为最小 id 记键；兄弟 5 无 songKeys，库 Song 无 mbid → 仍不得 unlove。
    const mbidTwo = "11111111-1111-1111-1111-111111111111";
    const mbidKey = `mbid:${mbidTwo}`;
    const dupLibrary: LibrarySongRef[] = [
      { id: 1, artist: "A", title: "One" },
      { id: 2, artist: "B", title: "Two" },
      { id: 5, artist: "B", title: "Two" },
    ];
    const plan = planWritebackMerge({
      prev: snap({
        lovedKeys: ["at:a\u0000one", mbidKey],
        favoriteIds: [1, 2, 5],
        songKeys: { "1": "at:a\u0000one", "2": mbidKey },
      }),
      loved: [
        { artist: "A", title: "One" },
        { artist: "B", title: "Two", mbid: mbidTwo },
      ],
      truncated: false,
      library: dupLibrary,
      favoriteIds: [1, 5],
    });
    expect(plan.unlove).toEqual([]);
  });

  it("does not unlove when songKeys empty and library has mbid (P2-新 1 namesById)", () => {
    // namesById 带 mbid 的守护：songKeys 空时仍靠库元数据识别同歌。
    const mbidTwo = "11111111-1111-1111-1111-111111111111";
    const mbidKey = `mbid:${mbidTwo}`;
    const dupLibrary: LibrarySongRef[] = [
      { id: 1, artist: "A", title: "One" },
      { id: 2, artist: "B", title: "Two", mbid: mbidTwo },
      { id: 5, artist: "B", title: "Two", mbid: mbidTwo },
    ];
    const plan = planWritebackMerge({
      prev: snap({
        lovedKeys: ["at:a\u0000one", mbidKey],
        favoriteIds: [1, 2, 5],
      }),
      loved: [
        { artist: "A", title: "One" },
        { artist: "B", title: "Two", mbid: mbidTwo },
      ],
      truncated: false,
      library: dupLibrary,
      favoriteIds: [1, 5],
    });
    expect(plan.unlove).toEqual([]);
  });

  it("does not unlove mixed mbid/at sibling keys either direction (P2-新 1 mixed)", () => {
    const mbidTwo = "11111111-1111-1111-1111-111111111111";
    const mbidKey = `mbid:${mbidTwo}`;
    const atKey = "at:b\u0000two";
    const dupLibrary: LibrarySongRef[] = [
      { id: 1, artist: "A", title: "One" },
      { id: 2, artist: "B", title: "Two" },
      { id: 5, artist: "B", title: "Two" },
    ];
    const mbidThenAt = planWritebackMerge({
      prev: snap({
        lovedKeys: ["at:a\u0000one", mbidKey],
        favoriteIds: [1, 2, 5],
        songKeys: { "1": "at:a\u0000one", "2": mbidKey, "5": atKey },
      }),
      loved: [
        { artist: "A", title: "One" },
        { artist: "B", title: "Two", mbid: mbidTwo },
      ],
      truncated: false,
      library: dupLibrary,
      favoriteIds: [1, 5],
    });
    expect(mbidThenAt.unlove).toEqual([]);

    const atThenMbid = planWritebackMerge({
      prev: snap({
        lovedKeys: ["at:a\u0000one", atKey],
        favoriteIds: [1, 2, 5],
        songKeys: { "1": "at:a\u0000one", "2": atKey, "5": mbidKey },
      }),
      loved: [
        { artist: "A", title: "One" },
        { artist: "B", title: "Two" },
      ],
      truncated: false,
      library: dupLibrary,
      favoriteIds: [1, 5],
    });
    expect(atThenMbid.unlove).toEqual([]);
  });

  it("still unloves sole mbid copy when no sibling remains (P2-a / K3)", () => {
    const mbidTwo = "11111111-1111-1111-1111-111111111111";
    const mbidKey = `mbid:${mbidTwo}`;
    const plan = planWritebackMerge({
      prev: snap({
        lovedKeys: ["at:a\u0000one", mbidKey],
        favoriteIds: [1, 2],
        songKeys: { "1": "at:a\u0000one", "2": mbidKey },
      }),
      loved: [
        { artist: "A", title: "One" },
        { artist: "B", title: "Two", mbid: mbidTwo },
      ],
      truncated: false,
      library: [
        { id: 1, artist: "A", title: "One" },
        { id: 2, artist: "B", title: "Two" },
      ],
      favoriteIds: [1],
    });
    expect(plan.unlove.map((t) => t.songId)).toEqual([2]);
  });

  it("does not remove favorite when Loved still reports same song after mbid→at drift (K2)", () => {
    // 曲库无 mbid、起点只为 5 记 mbid: 键；Last.fm 改报 at: 但仍是同一首 → 不得踢掉仍在收藏的 5。
    // 判据是「本轮 Loved 仍报同一首歌」，不是「收藏里还有同歌副本」。
    const mbidTwo = "11111111-1111-1111-1111-111111111111";
    const mbidKey = `mbid:${mbidTwo}`;
    const dupLibrary: LibrarySongRef[] = [
      { id: 1, artist: "A", title: "One" },
      { id: 2, artist: "B", title: "Two" },
      { id: 5, artist: "B", title: "Two" },
    ];
    const plan = planWritebackMerge({
      prev: snap({
        lovedKeys: ["at:a\u0000one", mbidKey],
        favoriteIds: [1, 2, 5],
        songKeys: { "1": "at:a\u0000one", "5": mbidKey },
      }),
      loved: [
        { artist: "A", title: "One" },
        { artist: "B", title: "Two" },
      ],
      truncated: false,
      library: dupLibrary,
      favoriteIds: [1, 2, 5],
    });
    expect(plan.removeFromFavorites).toEqual([]);
  });

  it("still removes sole favorite when Loved key drops with no sibling (K3 remove)", () => {
    // 单份无副本：远端键消失仍应 removeFromFavorites，不得被 K2 修法放宽成该删不删。
    const mbidTwo = "11111111-1111-1111-1111-111111111111";
    const mbidKey = `mbid:${mbidTwo}`;
    const plan = planWritebackMerge({
      prev: snap({
        lovedKeys: ["at:a\u0000one", mbidKey],
        favoriteIds: [1, 2],
        songKeys: { "1": "at:a\u0000one", "2": mbidKey },
      }),
      loved: [{ artist: "A", title: "One" }],
      truncated: false,
      library: [
        { id: 1, artist: "A", title: "One" },
        { id: 2, artist: "B", title: "Two" },
      ],
      favoriteIds: [1, 2],
    });
    expect(plan.removeFromFavorites).toEqual([2]);
  });

  it("does not remove at-key favorite when Loved still reports same song with sibling (K4)", () => {
    // at: 键 + 同名副本都在收藏；Loved 仍报该歌 → 不得移除。
    const dupLibrary: LibrarySongRef[] = [
      { id: 1, artist: "A", title: "One" },
      { id: 2, artist: "B", title: "Two" },
      { id: 5, artist: "B", title: "Two" },
    ];
    const plan = planWritebackMerge({
      prev: snap({
        lovedKeys: ["at:a\u0000one", "at:b\u0000two"],
        favoriteIds: [1, 2, 5],
        songKeys: { "1": "at:a\u0000one", "2": "at:b\u0000two" },
      }),
      loved: [
        { artist: "A", title: "One" },
        { artist: "B", title: "Two" },
      ],
      truncated: false,
      library: dupLibrary,
      favoriteIds: [1, 2, 5],
    });
    expect(plan.removeFromFavorites).toEqual([]);
  });

  it("removes both same-name favorite copies when Loved truly cancels (K9)", () => {
    // 两份同名同艺人都在收藏、Loved 真取消该歌 → 两份都要从收藏移除（不得互相保护）。
    const dupLibrary: LibrarySongRef[] = [
      { id: 1, artist: "A", title: "One" },
      { id: 2, artist: "B", title: "Two" },
      { id: 5, artist: "B", title: "Two" },
    ];
    const plan = planWritebackMerge({
      prev: snap({
        lovedKeys: ["at:a\u0000one", "at:b\u0000two"],
        favoriteIds: [1, 2, 5],
        songKeys: { "1": "at:a\u0000one", "2": "at:b\u0000two" },
      }),
      loved: [{ artist: "A", title: "One" }],
      truncated: false,
      library: dupLibrary,
      favoriteIds: [1, 2, 5],
    });
    expect(plan.removeFromFavorites.sort((a, b) => a - b)).toEqual([2, 5]);
  });

  it("songMatchKeyOf ignores mbid and normalizes artist+title", () => {
    expect(songMatchKeyOf({ artist: "B", title: "Two" })).toBe("at:b\u0000two");
    expect(songMatchKeyOf({ artist: " B ", title: "TWO " })).toBe("at:b\u0000two");
    expect(songMatchKeyOf({ artist: "", title: "Two" })).toBeNull();
  });

  it("only refreshes the snapshot when both sides already agree", () => {
    const plan = planWritebackMerge({
      prev: snap({ lovedKeys: ["at:a\u0000one"], favoriteIds: [1] }),
      loved: [{ artist: "A", title: "One" }],
      truncated: false,
      library,
      favoriteIds: [1],
      now: 777,
    });
    expect(plan.love).toEqual([]);
    expect(plan.unlove).toEqual([]);
    expect(plan.addToFavorites).toEqual([]);
    expect(plan.removeFromFavorites).toEqual([]);
    expect(plan.next.ts).toBe(777);
  });

  it("prefers local favorites on a real conflict in both directions", () => {
    const addedLocally = planWritebackMerge({
      prev: snap({
        lovedKeys: ["at:a\u0000one"],
        favoriteIds: [],
        songKeys: { "1": "at:a\u0000one" },
      }),
      loved: [],
      truncated: false,
      library,
      favoriteIds: [1],
    });
    // Loved 为空 → 不安全：不 unlove，但本地新增仍可 love
    expect(addedLocally.removalsSuppressed).toBe(true);
    expect(addedLocally.love.map((t) => t.songId)).toEqual([1]);
    expect(addedLocally.removeFromFavorites).toEqual([]);

    const removedLocally = planWritebackMerge({
      prev: snap({
        lovedKeys: [],
        favoriteIds: [1],
        songKeys: { "1": "at:a\u0000one" },
      }),
      loved: [{ artist: "A", title: "One" }],
      truncated: false,
      library,
      favoriteIds: [],
    });
    expect(removedLocally.conflicts).toBe(1);
    expect(removedLocally.unlove.map((t) => t.songId)).toEqual([1]);
    expect(removedLocally.addToFavorites).toEqual([]);
  });

  it("never treats a truncated pull as removals", () => {
    const plan = planWritebackMerge({
      prev: snap({
        lovedKeys: ["at:a\u0000one", "at:b\u0000two", "at:c\u0000three"],
        favoriteIds: [1, 2, 3],
        songKeys: { "1": "at:a\u0000one", "2": "at:b\u0000two", "3": "at:c\u0000three" },
      }),
      loved: [{ artist: "A", title: "One" }],
      truncated: true,
      library,
      favoriteIds: [1, 2, 3],
    });
    expect(plan.removeFromFavorites).toEqual([]);
    expect(plan.unlove).toEqual([]);
    expect(plan.removalsSuppressed).toBe(true);
    expect(plan.next.favoriteIds.sort()).toEqual([1, 2, 3]);
    expect(plan.next.lovedKeys.sort()).toEqual(
      ["at:a\u0000one", "at:b\u0000two", "at:c\u0000three"].sort()
    );
  });

  it("never treats an empty loved pull as removals", () => {
    const plan = planWritebackMerge({
      prev: snap({
        lovedKeys: ["at:a\u0000one", "at:b\u0000two"],
        favoriteIds: [1, 2],
        songKeys: { "1": "at:a\u0000one", "2": "at:b\u0000two" },
      }),
      loved: [],
      truncated: false,
      library,
      favoriteIds: [1, 2],
    });
    expect(plan.removeFromFavorites).toEqual([]);
    expect(plan.unlove).toEqual([]);
    expect(plan.removalsSuppressed).toBe(true);
    expect(plan.next.favoriteIds.sort()).toEqual([1, 2]);
  });

  it("still applies local additions while truncated", () => {
    const plan = planWritebackMerge({
      prev: snap({ lovedKeys: ["at:a\u0000one"], favoriteIds: [1] }),
      loved: [{ artist: "A", title: "One" }],
      truncated: true,
      library,
      favoriteIds: [1, 4],
    });
    expect(plan.love.map((t) => t.songId)).toEqual([4]);
    expect(plan.removeFromFavorites).toEqual([]);
  });

  it("forward-adds the lowest songId for ambiguous library matches", () => {
    const dupLibrary: LibrarySongRef[] = [
      { id: 11, artist: "A", title: "One" },
      { id: 12, artist: "a", title: "ONE" },
    ];
    const plan = planWritebackMerge({
      prev: snap({ lovedKeys: [], favoriteIds: [] }),
      loved: [{ artist: "A", title: "One" }],
      truncated: false,
      library: dupLibrary,
      favoriteIds: [],
    });
    expect(plan.addToFavorites).toEqual([11]);
    expect(plan.matched).toBe(1);
  });

  it("does not unlove when the artist/title pair is unknown for a removed favorite", () => {
    const plan = planWritebackMerge({
      prev: snap({ lovedKeys: ["at:a\u0000one"], favoriteIds: [1, 99] }),
      loved: [{ artist: "A", title: "One" }],
      truncated: false,
      library,
      favoriteIds: [1],
    });
    expect(plan.unlove).toEqual([]);
    // 99 已不在曲库里、也拿不到元数据：无法 unlove，从起点簿记里淘汰（不再每轮 deferred）。
    expect(plan.next.favoriteIds).toEqual([1]);
    expect(plan.favoritesDesired).toEqual([1]);
  });

  it("never writes back a favorite the user deleted during an unsafe round (P1-1)", () => {
    // 起点 [1,2]，用户已把 2 移出收藏（当前 [1]）；Loved 截断且有一条新的喜欢 Three。
    const plan = planWritebackMerge({
      prev: snap({
        lovedKeys: ["at:a\u0000one", "at:b\u0000two"],
        favoriteIds: [1, 2],
        songKeys: { "1": "at:a\u0000one", "2": "at:b\u0000two" },
      }),
      loved: [
        { artist: "A", title: "One" },
        { artist: "C", title: "Three" },
      ],
      truncated: true,
      library,
      favoriteIds: [1],
    });
    expect(plan.addToFavorites).toEqual([3]);
    expect(plan.removeFromFavorites).toEqual([]);
    // 期望集合只由「当前收藏 ∪ 本轮新增」决定，不含被用户删掉的 2。
    expect(plan.favoritesDesired).toEqual([1, 3]);
    expect(plan.favoritesDesired).not.toContain(2);
    // 快照簿记仍保留 2（等完整拉取后再决定 unlove），但绝不参与写入。
    expect(plan.next.favoriteIds).toContain(2);
  });

  it("keeps favorites untouched when an unsafe round has no new love (P1-1)", () => {
    const plan = planWritebackMerge({
      prev: snap({
        lovedKeys: ["at:a\u0000one", "at:b\u0000two"],
        favoriteIds: [1, 2],
        songKeys: { "1": "at:a\u0000one", "2": "at:b\u0000two" },
      }),
      loved: [],
      truncated: false,
      library,
      favoriteIds: [1],
    });
    expect(plan.addToFavorites).toEqual([]);
    expect(plan.favoritesDesired).toEqual([1]);
  });

  it("never adds a stale library-missing songId into favorites (P1-2)", () => {
    // 起点残留 99（曲库已无此曲），本轮 Last.fm 多出一首 Two → 只写 2。
    const plan = planWritebackMerge({
      prev: snap({
        lovedKeys: ["at:a\u0000one"],
        favoriteIds: [1, 99],
        songKeys: { "1": "at:a\u0000one", "99": "at:gone\u0000away" },
      }),
      loved: [
        { artist: "A", title: "One" },
        { artist: "B", title: "Two" },
      ],
      truncated: false,
      library,
      favoriteIds: [1],
    });
    expect(plan.addToFavorites).toEqual([2]);
    expect(plan.favoritesDesired).toEqual([1, 2]);
    expect(plan.favoritesDesired).not.toContain(99);
    // 连续多轮都拿不到元数据的 99 从起点簿记里淘汰，不再每轮 deferred。
    expect(plan.next.favoriteIds).toEqual([1, 2]);
  });

  it("flags an incomplete baseline instead of silently catch-up writing (P2-1)", () => {
    const plan = planWritebackMerge({
      prev: snap({
        truncated: true,
        lovedKeys: ["at:a\u0000one"],
        favoriteIds: [1],
        songKeys: { "1": "at:a\u0000one" },
      }),
      loved: [
        { artist: "A", title: "One" },
        { artist: "B", title: "Two" },
      ],
      truncated: false,
      library,
      favoriteIds: [1],
    });
    expect(plan.baselineIncomplete).toBe(true);
    // 已拍板语义不变：只做正向加，不做删除/unlove。
    expect(plan.addToFavorites).toEqual([2]);
    expect(plan.removeFromFavorites).toEqual([]);
  });

  it("does not flag baselineIncomplete for a complete baseline (P2-1)", () => {
    const plan = planWritebackMerge({
      prev: snap({ lovedKeys: ["at:a\u0000one"], favoriteIds: [1] }),
      loved: [{ artist: "A", title: "One" }],
      truncated: false,
      library,
      favoriteIds: [1],
    });
    expect(plan.baselineIncomplete).toBe(false);
  });

  it("does not mark next.truncated from favorites incomplete alone (P2)", () => {
    const plan = planWritebackMerge({
      prev: snap({ lovedKeys: ["at:a\u0000one"], favoriteIds: [1] }),
      loved: [
        { artist: "A", title: "One" },
        { artist: "B", title: "Two" },
      ],
      truncated: false,
      incomplete: true,
      library,
      favoriteIds: [1],
    });
    expect(plan.removalsSuppressed).toBe(true);
    expect(plan.next.truncated).toBeUndefined();
    expect(plan.baselineIncomplete).toBe(false);
    expect(plan.addToFavorites).toEqual([2]);
  });
});
