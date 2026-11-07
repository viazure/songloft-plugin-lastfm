import { describe, expect, it } from "vitest";
import {
  MAX_SCROBBLE_RECORDS,
  friendlyLastFmError,
  pushScrobbleRecord,
  sanitizeReason,
  stripSecrets,
  type ScrobbleRecord,
} from "../src/store";

describe("pushScrobbleRecord ring buffer", () => {
  const base = (i: number): ScrobbleRecord => ({
    ts: 1_700_000_000_000 + i,
    title: `T${i}`,
    artist: `A${i}`,
    ok: i % 2 === 0,
  });

  it("appends and keeps order", () => {
    let list: ScrobbleRecord[] = [];
    list = pushScrobbleRecord(list, base(1));
    list = pushScrobbleRecord(list, base(2));
    expect(list.map((r) => r.title)).toEqual(["T1", "T2"]);
  });

  it(`truncates to ${MAX_SCROBBLE_RECORDS}`, () => {
    let list: ScrobbleRecord[] = [];
    for (let i = 0; i < MAX_SCROBBLE_RECORDS + 5; i++) {
      list = pushScrobbleRecord(list, base(i));
    }
    expect(list).toHaveLength(MAX_SCROBBLE_RECORDS);
    expect(list[0].title).toBe(`T5`);
    expect(list[list.length - 1].title).toBe(`T${MAX_SCROBBLE_RECORDS + 4}`);
  });

  it("respects custom max", () => {
    let list: ScrobbleRecord[] = [];
    for (let i = 0; i < 5; i++) list = pushScrobbleRecord(list, base(i), 3);
    expect(list).toHaveLength(3);
    expect(list.map((r) => r.title)).toEqual(["T2", "T3", "T4"]);
  });
});

describe("stripSecrets / sanitizeReason", () => {
  it("redacts long hex blobs that look like keys", () => {
    const hex = "a".repeat(32);
    expect(stripSecrets(`session=${hex}`)).toContain("[已隐藏]");
    expect(stripSecrets(`session=${hex}`)).not.toContain(hex);
  });

  it("redacts labeled secrets", () => {
    const out = stripSecrets("api_key=dc96f72091d3dfdf8b4fb0424aa7d7e6 leaked");
    expect(out).toMatch(/api_key=\[已隐藏\]/i);
    expect(out).not.toContain("dc96f720");
  });

  it("maps session error to Chinese without raw dump", () => {
    expect(sanitizeReason("Last.FM error 9: Invalid session key - Please re-authenticate")).toBe(
      "连接已失效，请重新连接账号"
    );
  });

  it("maps network failures", () => {
    expect(friendlyLastFmError(new Error("fetch failed"))).toBe("网络错误，请检查网络后重试");
  });

  it("maps rate limit", () => {
    expect(sanitizeReason("Last.FM error 29: Rate limit exceeded")).toBe("Last.fm 限流，请稍后再试");
  });
});
