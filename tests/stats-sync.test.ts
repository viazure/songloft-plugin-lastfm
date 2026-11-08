import { describe, expect, it } from "vitest";
import {
  matchRecentToCandidates,
  filterNearWindow,
  normalizeHardCap,
  formatStatsSyncSummary,
  NEAR_WINDOW_MS,
  NEAR_WINDOW_STRATEGY,
  STATS_SYNC_DEFAULT_HARD_CAP,
  STATS_SYNC_FULL_HARD_CAP,
  STATS_SYNC_MAX_HARD_CAP,
  resolvePersistWatermark,
} from "../src/stats-sync";
import { buildLibraryIndexes, resolveSongId } from "../src/match";
import { statsPluginUrl } from "../src/stats-client";

describe("normalizeHardCap", () => {
  it("defaults and clamps to max 5000", () => {
    expect(normalizeHardCap(undefined)).toBe(STATS_SYNC_DEFAULT_HARD_CAP);
    expect(STATS_SYNC_DEFAULT_HARD_CAP).toBe(500);
    expect(STATS_SYNC_FULL_HARD_CAP).toBe(5000);
    expect(STATS_SYNC_MAX_HARD_CAP).toBe(5000);
    expect(normalizeHardCap(0)).toBe(1);
    expect(normalizeHardCap(500)).toBe(500);
    expect(normalizeHardCap(1000)).toBe(1000);
    expect(normalizeHardCap(5000)).toBe(5000);
    expect(normalizeHardCap(99999)).toBe(STATS_SYNC_MAX_HARD_CAP);
    expect(normalizeHardCap("200")).toBe(200);
  });
});

describe("resolveSongId / matchRecentToCandidates", () => {
  const songs = [
    { id: 1, artist: "A", title: "T1" },
    { id: 2, artist: "B", title: "T2", mbid: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" },
  ];

  it("resolves by artist+title and mbid; never returns 0/fake", () => {
    const idx = buildLibraryIndexes(songs);
    expect(resolveSongId({ artist: " a ", title: "t1" }, idx)).toBe(1);
    expect(
      resolveSongId(
        { artist: "X", title: "Y", mbid: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" },
        idx
      )
    ).toBe(2);
    expect(resolveSongId({ artist: "no", title: "match" }, idx)).toBeUndefined();
  });

  it("keeps duplicate songIds across different uts (scrobble history)", () => {
    const r = matchRecentToCandidates(
      [
        { artist: "A", title: "T1", uts: 100 },
        { artist: "A", title: "T1", uts: 200 },
        { artist: "Z", title: "Nope", uts: 300 },
      ],
      songs
    );
    expect(r.matched).toBe(2);
    expect(r.unmatched).toBe(1);
    expect(r.candidates.map((c) => c.timestamp)).toEqual([100_000, 200_000]);
    expect(r.candidates.every((c) => c.source === "lastfm")).toBe(true);
    expect(r.candidates.every((c) => c.songId > 0)).toBe(true);
  });
});

describe("filterNearWindow", () => {
  it("skips same songId within 120s", () => {
    const candidates = [
      {
        songId: 1,
        title: "T",
        artist: "A",
        timestamp: 1_000_000,
        uts: 1000,
        source: "lastfm" as const,
      },
      {
        songId: 1,
        title: "T",
        artist: "A",
        timestamp: 1_000_000 + NEAR_WINDOW_MS + 10_000,
        uts: 1130,
        source: "lastfm" as const,
      },
      {
        songId: 2,
        title: "U",
        artist: "B",
        timestamp: 1_000_000,
        uts: 1000,
        source: "lastfm" as const,
      },
    ];
    const existing = [{ songId: 1, timestamp: 1_000_050 }];
    const { kept, skippedNear } = filterNearWindow(candidates, existing);
    expect(skippedNear).toBe(1);
    expect(kept.map((k) => k.songId + ":" + k.uts)).toEqual(["1:1130", "2:1000"]);
  });
});

describe("formatStatsSyncSummary", () => {
  it("renders counts and strategy", () => {
    expect(formatStatsSyncSummary(null)).toBe("尚未同步过");
    const s = formatStatsSyncSummary({
      ok: true,
      ts: Date.UTC(2026, 0, 1),
      fetched: 10,
      matched: 8,
      imported: 5,
      skippedNear: 2,
      skippedExact: 1,
      unmatched: 2,
      truncated: false,
      watermarkUts: 99,
      nearWindowStrategy: NEAR_WINDOW_STRATEGY,
    });
    expect(s).toContain("拉取 10");
    expect(s).toContain("命中 8");
    expect(s).toContain("导入 5");
    expect(s).toContain("跳过(近窗) 2");
    expect(s).toContain("未匹配 2");
    expect(s).toContain(NEAR_WINDOW_STRATEGY);
  });
});

describe("statsPluginUrl", () => {
  it("builds host-forward URL with access_token", () => {
    const u = statsPluginUrl("http://127.0.0.1:8080/", "tok", "/api/import");
    expect(u).toBe(
      "http://127.0.0.1:8080/api/v1/jsplugin/stats/api/import?access_token=tok"
    );
    const u2 = statsPluginUrl("http://h", "a b", "/api/history/raw?limit=1");
    expect(u2).toContain("access_token=a%20b");
    expect(u2).toContain("/api/v1/jsplugin/stats/api/history/raw?limit=1&");
  });
});


describe("resolvePersistWatermark", () => {
  it("keeps prev on full-mode fail/empty (result wm 0)", () => {
    expect(resolvePersistWatermark(12345, 0)).toBe(12345);
    expect(resolvePersistWatermark(12345, undefined)).toBe(12345);
    expect(resolvePersistWatermark(12345, null)).toBe(12345);
  });
  it("advances when result is higher; never regresses", () => {
    expect(resolvePersistWatermark(1000, 2000)).toBe(2000);
    expect(resolvePersistWatermark(2000, 500)).toBe(2000);
    expect(resolvePersistWatermark(0, 0)).toBe(0);
    expect(resolvePersistWatermark(undefined, 99)).toBe(99);
  });
});
