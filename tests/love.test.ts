import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LastFmScrobbler } from "../src/scrobbler/lastfm";
import { md5 } from "../src/md5";

function expectedSig(params: Record<string, string>, secret: string): string {
  const keys = Object.keys(params)
    .filter((k) => k !== "format" && k !== "callback")
    .sort();
  let raw = "";
  for (const k of keys) raw += k + params[k];
  raw += secret;
  return md5(raw);
}

describe("LastFmScrobbler love/unlove", () => {
  const creds = {
    apiKey: "k".repeat(32),
    apiSecret: "s".repeat(32),
    sessionKey: "sess".repeat(8),
    username: "tester",
  };

  const posts: Array<{ url: string; body: string }> = [];
  let fetchImpl: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

  beforeEach(() => {
    posts.length = 0;
    fetchImpl = async () =>
      ({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ status: "ok" }),
      }) as Response;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      posts.push({
        url: String(input),
        body: typeof init?.body === "string" ? init.body : "",
      });
      return fetchImpl(input, init);
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function parseForm(body: string): Record<string, string> {
    const out: Record<string, string> = {};
    for (const part of body.split("&")) {
      const [k, v] = part.split("=");
      out[decodeURIComponent(k)] = decodeURIComponent(v || "");
    }
    return out;
  }

  it("love posts track.love with signed params (no password/secret in clear beyond sig)", async () => {
    const client = new LastFmScrobbler(creds);
    await client.love("Artist X", "Track Y");
    expect(posts).toHaveLength(1);
    const form = parseForm(posts[0].body);
    expect(form.method).toBe("track.love");
    expect(form.artist).toBe("Artist X");
    expect(form.track).toBe("Track Y");
    expect(form.api_key).toBe(creds.apiKey);
    expect(form.sk).toBe(creds.sessionKey);
    expect(form.format).toBe("json");
    expect(form.password).toBeUndefined();
    expect(form.api_secret).toBeUndefined();
    const { api_sig, format, ...signed } = form;
    expect(api_sig).toBe(expectedSig(signed, creds.apiSecret));
    // Body must not contain the raw shared secret as a value field.
    expect(posts[0].body).not.toContain(creds.apiSecret);
  });

  it("unlove posts track.unlove with matching signature", async () => {
    const client = new LastFmScrobbler(creds);
    await client.unlove("Artist X", "Track Y");
    expect(posts).toHaveLength(1);
    const form = parseForm(posts[0].body);
    expect(form.method).toBe("track.unlove");
    expect(form.artist).toBe("Artist X");
    expect(form.track).toBe("Track Y");
    const { api_sig, format, ...signed } = form;
    expect(api_sig).toBe(expectedSig(signed, creds.apiSecret));
    expect(posts[0].body).not.toContain(creds.apiSecret);
  });

  it("love rejects when not authorized", async () => {
    const client = new LastFmScrobbler({ apiKey: "k", apiSecret: "s" });
    await expect(client.love("A", "T")).rejects.toThrow(/not authorized/i);
    expect(posts).toHaveLength(0);
  });
});
