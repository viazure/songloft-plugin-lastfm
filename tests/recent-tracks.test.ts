import { describe, expect, it, vi } from "vitest";
import { LastFmScrobbler } from "../src/scrobbler/lastfm";

describe("LastFmScrobbler getRecentTracks", () => {
  it("skips nowplaying and respects fromUts + hardCap", async () => {
    const posts: Array<{ body: string }> = [];
    const pages = [
      {
        recenttracks: {
          "@attr": { totalPages: "2", total: "4" },
          track: [
            {
              name: "Now",
              artist: { "#text": "Art" },
              "@attr": { nowplaying: "true" },
            },
            {
              name: "T1",
              artist: { name: "A" },
              date: { uts: "300" },
              mbid: "m1",
            },
            {
              name: "T0",
              artist: "B",
              date: { uts: "200" },
            },
          ],
        },
      },
      {
        recenttracks: {
          "@attr": { totalPages: "2", total: "4" },
          track: [
            {
              name: "Old",
              artist: "C",
              date: { uts: "50" },
            },
          ],
        },
      },
    ];
    let call = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: { body?: string }) => {
        posts.push({ body: String(init?.body || "") });
        const data = pages[call++] || pages[pages.length - 1];
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify(data),
        };
      })
    );

    const client = new LastFmScrobbler({
      apiKey: "k".repeat(32),
      apiSecret: "s".repeat(32),
      username: "u",
    });
    const r = await client.getRecentTracks({ hardCap: 10, fromUts: 100 });
    expect(r.tracks.map((t) => t.title)).toEqual(["T1", "T0"]);
    expect(r.tracks[0].mbid).toBe("m1");
    expect(r.tracks.every((t) => t.uts > 100)).toBe(true);
    expect(posts[0].body).toContain("user.getRecentTracks");
    // hitFloor on second page (uts 50 <= 100) — should not include Old
    expect(r.tracks.find((t) => t.title === "Old")).toBeUndefined();
  });

  it("requires username", async () => {
    const client = new LastFmScrobbler({
      apiKey: "k".repeat(32),
      apiSecret: "s".repeat(32),
    });
    await expect(client.getRecentTracks()).rejects.toThrow(/username/i);
  });
});
