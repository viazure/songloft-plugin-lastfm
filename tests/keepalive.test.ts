import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ensureHostKeepAlive, withKeepAliveEntry } from "../src/keepalive";

describe("withKeepAliveEntry", () => {
  it("adds lastfm when empty", () => {
    expect(withKeepAliveEntry({})).toEqual({
      plugins: ["lastfm"],
      changed: true,
    });
  });

  it("is idempotent when already present", () => {
    expect(withKeepAliveEntry({ plugins: ["miot", "lastfm"] })).toEqual({
      plugins: ["miot", "lastfm"],
      changed: false,
    });
  });

  it("preserves other entries and appends", () => {
    expect(withKeepAliveEntry({ plugins: ["miot"] })).toEqual({
      plugins: ["miot", "lastfm"],
      changed: true,
    });
  });

  it("filters empty / non-string junk", () => {
    expect(
      withKeepAliveEntry({ plugins: ["miot", "", null as unknown as string] })
    ).toEqual({ plugins: ["miot", "lastfm"], changed: true });
  });
});

function jsonResp(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as Response;
}

describe("ensureHostKeepAlive network path", () => {
  const fetches: Array<{
    url: string;
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  }> = [];
  let fetchImpl: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

  beforeEach(() => {
    fetches.length = 0;
    (globalThis as any).songloft = {
      plugin: {
        getToken: vi.fn(async () => "tok-test"),
        getHostUrl: vi.fn(async () => "http://127.0.0.1:58091/"),
      },
    };
    fetchImpl = async () => jsonResp(500, {});
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      fetches.push({
        url: String(input),
        method: init?.method ?? "GET",
        headers: init?.headers as Record<string, string> | undefined,
        body: typeof init?.body === "string" ? init.body : undefined,
      });
      return fetchImpl(input, init);
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("GET already listed → no PUT, already=true", async () => {
    fetchImpl = async () => jsonResp(200, { plugins: ["miot", "lastfm"] });
    const r = await ensureHostKeepAlive();
    expect(r).toEqual({
      ok: true,
      already: true,
      plugins: ["miot", "lastfm"],
    });
    expect(fetches).toHaveLength(1);
    expect(fetches[0]).toMatchObject({
      url: "http://127.0.0.1:58091/api/v1/settings/plugin-keep-alive",
      method: "GET",
    });
    expect(fetches[0].headers?.Authorization).toBe("Bearer tok-test");
  });

  it("GET missing → PUT appends lastfm", async () => {
    fetchImpl = async (_input, init) => {
      if ((init?.method ?? "GET") === "GET") {
        return jsonResp(200, { plugins: ["miot"] });
      }
      return jsonResp(200, { plugins: ["miot", "lastfm"] });
    };
    const r = await ensureHostKeepAlive();
    expect(r).toEqual({
      ok: true,
      already: false,
      plugins: ["miot", "lastfm"],
    });
    expect(fetches).toHaveLength(2);
    expect(fetches[1]).toMatchObject({
      method: "PUT",
      body: JSON.stringify({ plugins: ["miot", "lastfm"] }),
    });
    expect(fetches[1].headers?.["Content-Type"]).toBe("application/json");
  });

  it("GET HTTP error → ok:false with status", async () => {
    fetchImpl = async () => jsonResp(403, { error: "forbidden" });
    const r = await ensureHostKeepAlive();
    expect(r).toEqual({
      ok: false,
      reason: "GET keep-alive HTTP 403",
      status: 403,
    });
    expect(fetches).toHaveLength(1);
  });

  it("PUT HTTP error → ok:false with status", async () => {
    fetchImpl = async (_input, init) => {
      if ((init?.method ?? "GET") === "GET") {
        return jsonResp(200, { plugins: [] });
      }
      return jsonResp(500, { error: "boom" });
    };
    const r = await ensureHostKeepAlive();
    expect(r).toEqual({
      ok: false,
      reason: "PUT keep-alive HTTP 500",
      status: 500,
    });
    expect(fetches).toHaveLength(2);
  });

  it("fetch throw → ok:false reason string", async () => {
    fetchImpl = async () => {
      throw new Error("network down");
    };
    const r = await ensureHostKeepAlive();
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toContain("network down");
    }
  });
});
