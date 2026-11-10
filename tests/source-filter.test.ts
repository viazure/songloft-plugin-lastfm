import { describe, expect, it } from "vitest";
import {
  deriveOnlyMiot,
  getScrobbleSkipReason,
  normalizeScrobbleSources,
  shouldSkipScrobble,
  sourcesFromLegacyOnlyMiot,
} from "../src/source-filter";

const bothSources = ["miot", "songloft-player"] as const;

describe("shouldSkipScrobble / getScrobbleSkipReason", () => {
  it("local on records local; local off skips local", () => {
    expect(
      shouldSkipScrobble({
        scrobbleLocal: true,
        scrobbleNetwork: false,
        scrobbleSources: [...bothSources],
        songType: "local",
        playSource: "miot",
      })
    ).toBe(false);

    expect(
      getScrobbleSkipReason({
        scrobbleLocal: false,
        scrobbleNetwork: false,
        scrobbleSources: [...bothSources],
        songType: "local",
        playSource: "miot",
      })
    ).toBe("未勾选记录本地音乐");
  });

  it("network off skips remote AND radio", () => {
    expect(
      getScrobbleSkipReason({
        scrobbleLocal: true,
        scrobbleNetwork: false,
        scrobbleSources: [...bothSources],
        songType: "remote",
        playSource: "miot",
      })
    ).toBe("未勾选记录网络音乐");

    expect(
      getScrobbleSkipReason({
        scrobbleLocal: true,
        scrobbleNetwork: false,
        scrobbleSources: [...bothSources],
        songType: "radio",
        playSource: "songloft-player",
      })
    ).toBe("未勾选记录网络音乐");
  });

  it("network on records remote and radio", () => {
    expect(
      shouldSkipScrobble({
        scrobbleLocal: true,
        scrobbleNetwork: true,
        scrobbleSources: [...bothSources],
        songType: "remote",
        playSource: "miot",
      })
    ).toBe(false);
    expect(
      shouldSkipScrobble({
        scrobbleLocal: true,
        scrobbleNetwork: true,
        scrobbleSources: [...bothSources],
        songType: "radio",
        playSource: "songloft-player",
      })
    ).toBe(false);
  });

  it("unidentified / missing songType does not skip on content axis", () => {
    for (const songType of [undefined, null, ""]) {
      expect(
        shouldSkipScrobble({
          scrobbleLocal: false,
          scrobbleNetwork: false,
          scrobbleSources: [...bothSources],
          songType,
          playSource: "miot",
        })
      ).toBe(false);
    }
  });

  it("playback source filter skips unchecked sources", () => {
    expect(
      getScrobbleSkipReason({
        scrobbleLocal: true,
        scrobbleNetwork: true,
        scrobbleSources: ["miot"],
        songType: "local",
        playSource: "songloft-player",
      })
    ).toBe("未勾选该播放方式");

    expect(
      shouldSkipScrobble({
        scrobbleLocal: true,
        scrobbleNetwork: true,
        scrobbleSources: ["miot"],
        songType: "local",
        playSource: "miot",
      })
    ).toBe(false);
  });

  it("missing playSource does not skip on playback axis", () => {
    expect(
      shouldSkipScrobble({
        scrobbleLocal: true,
        scrobbleNetwork: false,
        scrobbleSources: ["miot"],
        songType: "local",
        playSource: undefined,
      })
    ).toBe(false);
    expect(
      shouldSkipScrobble({
        scrobbleLocal: true,
        scrobbleNetwork: false,
        scrobbleSources: ["miot"],
        songType: "local",
        playSource: "",
      })
    ).toBe(false);
  });

  it("AND: network off skips even when playback source is allowed", () => {
    expect(
      getScrobbleSkipReason({
        scrobbleLocal: true,
        scrobbleNetwork: false,
        scrobbleSources: [...bothSources],
        songType: "remote",
        playSource: "miot",
      })
    ).toBe("未勾选记录网络音乐");
  });

  it("AND: content allowed but playback source unchecked still skips", () => {
    expect(
      getScrobbleSkipReason({
        scrobbleLocal: true,
        scrobbleNetwork: true,
        scrobbleSources: ["songloft-player"],
        songType: "local",
        playSource: "miot",
      })
    ).toBe("未勾选该播放方式");
  });
});

describe("sources helpers", () => {
  it("normalizeScrobbleSources filters unknowns and dedupes", () => {
    expect(normalizeScrobbleSources(["miot", "x", "songloft-player", "miot"])).toEqual([
      "miot",
      "songloft-player",
    ]);
    expect(normalizeScrobbleSources(undefined)).toEqual(["miot", "songloft-player"]);
    expect(normalizeScrobbleSources([])).toEqual([]);
  });

  it("legacy onlyMiot → sources and deriveOnlyMiot round-trip", () => {
    expect(sourcesFromLegacyOnlyMiot(true)).toEqual(["miot"]);
    expect(sourcesFromLegacyOnlyMiot(false)).toEqual(["miot", "songloft-player"]);
    expect(deriveOnlyMiot(["miot"])).toBe(true);
    expect(deriveOnlyMiot(["miot", "songloft-player"])).toBe(false);
    expect(deriveOnlyMiot(["songloft-player"])).toBe(false);
    expect(deriveOnlyMiot([])).toBe(false);
  });
});
