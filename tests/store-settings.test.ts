import { beforeEach, describe, expect, it } from "vitest";

const memory = new Map<string, unknown>();

(globalThis as unknown as { songloft: { storage: unknown } }).songloft = {
  storage: {
    async get(key: string) {
      return memory.get(key);
    },
    async set(key: string, value: unknown) {
      memory.set(key, value);
    },
  },
};

describe("loadSettings defaults", () => {
  beforeEach(() => {
    memory.clear();
  });

  it("treats missing scrobbleNetwork as true, keeps an explicit false, and keeps true", async () => {
    const { loadSettings } = await import("../src/store");
    expect((await loadSettings()).scrobbleNetwork).toBe(true);

    memory.set("settings", { scrobbleNetwork: false });
    expect((await loadSettings()).scrobbleNetwork).toBe(false);

    memory.set("settings", { scrobbleNetwork: true });
    expect((await loadSettings()).scrobbleNetwork).toBe(true);
  });

  it("lovedWritebackEnabled defaults to false and only enables on explicit true", async () => {
    const { loadSettings } = await import("../src/store");
    expect((await loadSettings()).lovedWritebackEnabled).toBe(false);
    memory.set("settings", { lovedWritebackEnabled: true });
    expect((await loadSettings()).lovedWritebackEnabled).toBe(true);
    memory.set("settings", { lovedWritebackEnabled: "yes" });
    expect((await loadSettings()).lovedWritebackEnabled).toBe(false);
  });

  it("lovedSyncTarget defaults to favorites; keeps playlist; invalid falls back", async () => {
    const { loadSettings, normalizeLovedSyncTarget } = await import("../src/store");
    expect(normalizeLovedSyncTarget(undefined)).toBe("favorites");
    expect(normalizeLovedSyncTarget("favorites")).toBe("favorites");
    expect(normalizeLovedSyncTarget("playlist")).toBe("playlist");
    expect(normalizeLovedSyncTarget("other")).toBe("favorites");
    expect(normalizeLovedSyncTarget("")).toBe("favorites");

    expect((await loadSettings()).lovedSyncTarget).toBe("favorites");

    memory.set("settings", { lovedSyncTarget: "playlist", lovedPlaylistName: "My Loved" });
    const loaded = await loadSettings();
    expect(loaded.lovedSyncTarget).toBe("playlist");
    expect(loaded.lovedPlaylistName).toBe("My Loved");

    memory.set("settings", { lovedSyncTarget: "nope" });
    expect((await loadSettings()).lovedSyncTarget).toBe("favorites");
  });
});
