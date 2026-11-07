import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LastFmScrobbler } from "../src/scrobbler/lastfm";

describe("LastFmScrobbler getLovedTracks", () => {
  const creds = {
    apiKey: "k".repeat(32),
    apiSecret: "s".repeat(32),
    sessionKey: "sess".repeat(8),
    username: "tester",
  };
  const posts: Array<{ body: string }> = [];

  beforeEach(() => {
    posts.length = 0;
    vi.stubGlobal("fetch", async (_input: RequestInfo | URL, init?: RequestInit) => {
      posts.push({ body: typeof init?.body === "string" ? init.body : "" });
      const page = decodeURIComponent((posts[posts.length - 1].body.match(/page=([^&]+)/) || [])[1] || "1");
      if (page === "1") {
        return {
          ok: true,
          status: 200,
          text: async () =>
            JSON.stringify({
              lovedtracks: {
                track: [
                  { name: "T1", artist: { name: "A1" }, mbid: "m1" },
                  { name: "T2", artist: { "#text": "A2" }, mbid: "" },
                ],
                "@attr": { page: "1", totalPages: "2", total: "3", perPage: "2", user: "tester" },
              },
            }),
        } as Response;
      }
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            lovedtracks: {
              track: { name: "T3", artist: { name: "A3" } },
              "@attr": { page: "2", totalPages: "2", total: "3", perPage: "2", user: "tester" },
            },
          }),
      } as Response;
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("pages until done and normalizes artist shapes", async () => {
    const client = new LastFmScrobbler(creds);
    const r = await client.getLovedTracks({ hardCap: 1000 });
    expect(posts.length).toBe(2);
    expect(r.truncated).toBe(false);
    expect(r.tracks).toEqual([
      { artist: "A1", title: "T1", mbid: "m1" },
      { artist: "A2", title: "T2" },
      { artist: "A3", title: "T3" },
    ]);
    expect(posts[0].body).toContain("user.getLovedTracks");
    expect(posts[0].body).not.toContain(creds.apiSecret);
  });

  it("respects hardCap and marks truncated", async () => {
    const client = new LastFmScrobbler(creds);
    const r = await client.getLovedTracks({ hardCap: 2 });
    expect(r.tracks).toHaveLength(2);
    expect(r.truncated).toBe(true);
  });

  it("requires username", async () => {
    const client = new LastFmScrobbler({ apiKey: "k", apiSecret: "s" });
    await expect(client.getLovedTracks()).rejects.toThrow(/username/i);
  });
});
