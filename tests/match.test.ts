import { describe, expect, it } from "vitest";
import {
  artistTitleKey,
  buildLibraryIndexes,
  matchLovedTracks,
  normalizeMbid,
  normalizeText,
} from "../src/match";
import { formatLovedSyncSummary, LOVED_PLAYLIST_NAME } from "../src/loved-playlist";

describe("normalize / keys", () => {
  it("trims, lowercases, collapses whitespace", () => {
    expect(normalizeText("  Foo   BAR ")).toBe("foo bar");
    expect(artistTitleKey("Radwimps", "前前前世")).toBe(artistTitleKey("  radwimps ", "  前前前世  "));
  });

  it("drops empty / nil mbid", () => {
    expect(normalizeMbid("")).toBeUndefined();
    expect(normalizeMbid("  ")).toBeUndefined();
    expect(normalizeMbid("00000000-0000-0000-0000-000000000000")).toBeUndefined();
    expect(normalizeMbid("AbC")).toBe("abc");
  });
});

describe("matchLovedTracks", () => {
  const songs = [
    { id: 3, artist: "A", title: "T" },
    { id: 1, artist: "A", title: "T" }, // lower id wins on one-to-many
    { id: 2, artist: "B", title: "X", mbid: "mb-1" },
    { id: 9, artist: "C", title: "Y" },
  ];

  it("matches normalized artist+title; one-to-many takes lowest songId", () => {
    const r = matchLovedTracks([{ artist: " a ", title: "  t" }], songs);
    expect(r.matched).toBe(1);
    expect(r.matchedIds).toEqual([1]);
    expect(r.unmatched).toBe(0);
  });

  it("prefers mbid when both sides have it", () => {
    const r = matchLovedTracks(
      [{ artist: "Other", title: "Name", mbid: "MB-1" }],
      songs
    );
    expect(r.matchedIds).toEqual([2]);
  });

  it("falls back to artist+title when mbid misses", () => {
    const r = matchLovedTracks(
      [{ artist: "C", title: "Y", mbid: "no-such" }],
      songs
    );
    expect(r.matchedIds).toEqual([9]);
  });

  it("empty loved → empty match, zero unmatched", () => {
    const r = matchLovedTracks([], songs);
    expect(r.matchedIds).toEqual([]);
    expect(r.matched).toBe(0);
    expect(r.unmatched).toBe(0);
  });

  it("all unmatched → empty ids, samples capped", () => {
    const loved = [
      { artist: "Z1", title: "Q1" },
      { artist: "Z2", title: "Q2" },
      { artist: "Z3", title: "Q3" },
    ];
    const r = matchLovedTracks(loved, songs, 2);
    expect(r.matched).toBe(0);
    expect(r.matchedIds).toEqual([]);
    expect(r.unmatched).toBe(3);
    expect(r.unmatchedSamples).toHaveLength(2);
  });

  it("dedupes same library song matched twice", () => {
    const r = matchLovedTracks(
      [
        { artist: "A", title: "T" },
        { artist: "a", title: "t" },
      ],
      songs
    );
    expect(r.matchedIds).toEqual([1]);
    expect(r.matched).toBe(1);
  });

  it("buildLibraryIndexes sorts ids ascending", () => {
    const { byArtistTitle } = buildLibraryIndexes(songs);
    expect(byArtistTitle.get(artistTitleKey("A", "T"))).toEqual([1, 3]);
  });
});

describe("formatLovedSyncSummary", () => {
  it("handles null and failure", () => {
    expect(formatLovedSyncSummary(null)).toBe("尚未同步过");
    const fail = formatLovedSyncSummary({
      ok: false,
      ts: 0,
      loved: 0,
      matched: 0,
      unmatched: 0,
      reason: "网络错误",
    });
    expect(fail).toContain("失败");
    expect(fail).toContain("网络错误");
    expect(fail).not.toContain("已拉到");
  });

  it("failure with partial counts keeps readable progress", () => {
    const fail = formatLovedSyncSummary({
      ok: false,
      ts: 0,
      loved: 12,
      matched: 5,
      unmatched: 7,
      reason: "playlist write failed",
    });
    expect(fail).toContain("失败");
    expect(fail).toContain("playlist write failed");
    expect(fail).toContain("loved 12");
    expect(fail).toContain("命中 5");
    expect(fail).toContain("未命中 7");
  });

  it("formats success N/M/K", () => {
    const s = formatLovedSyncSummary({
      ok: true,
      ts: Date.UTC(2026, 0, 1),
      loved: 10,
      matched: 7,
      unmatched: 3,
      truncated: false,
      playlistId: 1,
      playlistIdChanged: false,
      created: false,
      unmatchedSamples: [],
    });
    expect(s).toContain("loved 10");
    expect(s).toContain("命中 7");
    expect(s).toContain("未命中 3");
  });

  it("playlist name constant", () => {
    expect(LOVED_PLAYLIST_NAME).toBe("Last.fm Loved");
  });
});
