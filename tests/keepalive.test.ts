import { describe, expect, it } from "vitest";
import { withKeepAliveEntry } from "../src/keepalive";

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
