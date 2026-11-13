import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import LastfmSettingsUi from "../static/js/settings-ui.js";

const {
  formatDateTime,
  sourceLabel,
  pathLabel,
  friendlyLogMessage,
  isHumanizedMessage,
  formatLovedStatsLine,
  formatLovedOutcome,
  formatStatsStatsLine,
  formatStatsOutcome,
  isLovedTargetValid,
  canRunLovedSync,
  canRunStatsSync,
  lovedModeHint,
  formatWritebackStatus,
  scheduleNextLine,
  formatRecentTitle,
  formatRecentMeta,
  selectRecentRecords,
  formatLovedCurrentTarget,
  PREVIEW_COUNT,
  TEXT_WRAP_STYLE,
  LASTFM_BRAND,
} = LastfmSettingsUi;

describe("formatDateTime", () => {
  it("formats host-local 24-hour time without AM/PM or a hard-coded zone label", () => {
    const text = formatDateTime(new Date(2026, 10, 13, 7, 45, 30));
    expect(text).toBe("2026-11-13 07:45");
    expect(text).not.toMatch(/AM|PM|上午|下午|北京时间/i);
  });

  it("can include seconds for detailed logs", () => {
    expect(formatDateTime(new Date(2026, 10, 13, 13, 5, 9), true)).toBe("2026-11-13 13:05:09");
  });

  it("returns a dash for invalid values", () => {
    expect(formatDateTime(null)).toBe("—");
    expect(formatDateTime("not-a-date")).toBe("—");
  });
});

describe("labels", () => {
  it("translates English source tags used in records", () => {
    expect(sourceLabel("manual")).toBe("手动");
    expect(sourceLabel("scheduled")).toBe("定时");
    expect(sourceLabel("songloft-player")).toBe("播放触发");
    expect(sourceLabel("miot")).toBe("小爱音箱");
  });

  it("omits the redundant writeback source tag", () => {
    expect(sourceLabel("writeback")).toBe("");
  });

  it("uses 喜欢 / 收藏 terminology in path labels", () => {
    expect(pathLabel("love")).toBe("喜欢");
    expect(pathLabel("unlove")).toBe("取消喜欢");
    expect(pathLabel("loved_playlist_sync")).toBe("喜欢同步");
    expect(pathLabel("loved_writeback")).toBe("收藏写回");
    expect(pathLabel("stats_sync")).toBe("播放统计同步");
  });
});

describe("friendlyLogMessage", () => {
  it("keeps the existing invalid-session wording", () => {
    expect(friendlyLogMessage("Invalid session key - error 9")).toBe("连接已失效，请重新连接账号");
  });

  it("turns network stack traces into short Chinese reasons", () => {
    const dial =
      'Error: Post "https://ws.audioscrobbler.com/2.0/": dial tcp: lookup ws.audioscrobbler.com: i/o timeout';
    expect(friendlyLogMessage(dial)).toBe("连接 Last.fm 超时");
    expect(isHumanizedMessage(dial)).toBe(true);
    expect(friendlyLogMessage("dial tcp 1.2.3.4:443: connect: connection refused")).toBe(
      "无法连接 Last.fm，请检查网络"
    );
    expect(friendlyLogMessage("no such host")).toBe("无法解析 Last.fm 地址，请检查网络");
  });
});

describe("loved / stats result display", () => {
  it("lists likes, matches and unmatched separately, and does not call unmatched a failure", () => {
    const last = { ts: new Date(2026, 10, 13, 7, 45).getTime(), ok: true, loved: 251, matched: 194, unmatched: 57 };
    const stats = formatLovedStatsLine(last);
    expect(stats).toBe("喜欢 251 首 · 已匹配 194 首 · 未匹配 57 首");
    expect(stats).not.toMatch(/失败/);
    expect(formatLovedOutcome(last)).toMatchObject({
      time: "2026-11-13 07:45",
      outcome: "成功",
      stats,
      ok: true,
    });
  });

  it("lists operation failure separately from unmatched counts", () => {
    const last = {
      ts: new Date(2026, 10, 13, 7, 45).getTime(),
      ok: false,
      loved: 10,
      matched: 8,
      unmatched: 2,
      reason: "dial tcp: i/o timeout",
    };
    const view = formatLovedOutcome(last);
    expect(view.outcome).toBe("失败：连接 Last.fm 超时");
    expect(view.stats).toBe("喜欢 10 首 · 已匹配 8 首 · 未匹配 2 首");
  });

  it("does not treat stats matches as writes", () => {
    const last = {
      ts: new Date(2026, 10, 13, 8, 0).getTime(),
      ok: true,
      fetched: 500,
      matched: 120,
      imported: 40,
      skippedNear: 80,
      skippedExact: 0,
      unmatched: 30,
    };
    const line = formatStatsStatsLine(last);
    expect(line).toContain("已匹配 120 首");
    expect(line).toContain("写入 40 条");
    expect(line).toContain("未匹配 30 首");
    expect(formatStatsOutcome(last).outcome).toBe("成功");
  });
});

describe("save model / sync gating", () => {
  it("accepts favorites or a custom playlist as a valid target", () => {
    expect(isLovedTargetValid({ target: "favorites" })).toBe(true);
    expect(isLovedTargetValid({ target: "playlist", name: "" })).toBe(true);
    expect(isLovedTargetValid({ target: "" })).toBe(false);
  });

  it("disables immediate loved sync when settings are unsaved, and does not imply a silent save", () => {
    expect(
      canRunLovedSync({ connected: true, dirty: true, form: { target: "favorites" } })
    ).toEqual({ ok: false, reason: "请先保存同步设置" });
    expect(
      canRunLovedSync({ connected: true, dirty: false, form: { target: "favorites" } })
    ).toEqual({ ok: true, reason: "" });
    expect(
      canRunLovedSync({ connected: false, dirty: false, form: { target: "favorites" } })
    ).toEqual({ ok: false, reason: "请先连接账号" });
  });

  it("disables stats sync when cap/schedule changes are unsaved", () => {
    expect(canRunStatsSync({ available: true, connected: true, dirty: true })).toEqual({
      ok: false,
      reason: "请先保存统计设置",
    });
    expect(canRunStatsSync({ available: true, connected: true, dirty: false }).ok).toBe(true);
  });
});

describe("loved mode hint", () => {
  it("shows the bidirectional rule only when saved write-back is on and the saved target is 收藏", () => {
    expect(
      lovedModeHint({
        savedWritebackEnabled: true,
        savedTarget: "favorites",
        formTarget: "favorites",
        hostSupported: true,
      })
    ).toContain("双向同步已开启");
    expect(
      lovedModeHint({
        savedWritebackEnabled: false,
        savedTarget: "favorites",
        formTarget: "favorites",
        hostSupported: true,
      })
    ).toContain("不会把目标中的改动写回 Last.fm");
    expect(
      lovedModeHint({
        savedWritebackEnabled: true,
        savedTarget: "favorites",
        formTarget: "playlist",
        hostSupported: true,
      })
    ).toBe("仅单向同步；该歌单的改动不会写回 Last.fm。");
  });

  it("does not treat an unsaved write-back checkbox as already bidirectional", () => {
    const hint = lovedModeHint({
      savedWritebackEnabled: false,
      savedTarget: "favorites",
      formTarget: "favorites",
      hostSupported: true,
    });
    expect(hint).not.toContain("双向同步已开启");
  });
});

describe("writeback status", () => {
  it("uses the upgrade copy and disables enabling when the host has no interface", () => {
    const view = formatWritebackStatus({ supported: false, enabled: false });
    expect(view.line).toBe("当前 Songloft 版本不支持收藏写回，请升级后开启。");
    expect(view.canEnable).toBe(false);
  });

  it("shows 未开启 or a 24-hour starting point without saying 默认关闭", () => {
    expect(formatWritebackStatus({ supported: true, enabled: false }).line).toBe("未开启");
    const on = formatWritebackStatus({
      supported: true,
      enabled: true,
      baselineAt: new Date(2026, 10, 13, 7, 44).getTime(),
    });
    expect(on.line).toBe("已开启 · 同步起点：2026-11-13 07:44");
    expect(on.line).not.toMatch(/默认关闭/);
  });

  it("points to 立即同步喜欢 when a write-back is deferred because another sync is running", () => {
    const view = formatWritebackStatus({
      supported: true,
      enabled: true,
      baselineAt: new Date(2026, 10, 13, 7, 44).getTime(),
      deferBusy: true,
    });
    expect(view.line).toContain("立即同步喜欢");
    expect(view.line).not.toMatch(/「立即同步」/);
  });
});

describe("schedule next line", () => {
  it("states that scheduled sync is off instead of inventing a next run", () => {
    expect(scheduleNextLine({ enabled: false })).toBe("定时同步未开启");
    expect(scheduleNextLine({ enabled: true, nextDueAt: new Date(2026, 10, 13, 13, 45).getTime() })).toBe(
      "下次同步：2026-11-13 13:45"
    );
  });
});

describe("loved current target (no duplicated next-sync line)", () => {
  it("shows only the current target, not the next run time", () => {
    expect(formatLovedCurrentTarget({ target: "favorites" })).toBe("当前目标：Songloft 收藏");
    expect(formatLovedCurrentTarget({ target: "playlist", name: "我的喜欢" })).toBe(
      "当前目标：自定义歌单「我的喜欢」"
    );
    expect(formatLovedCurrentTarget({ target: "favorites", nextDueAt: Date.now() })).not.toMatch(/下次同步/);
  });
});

describe("recent record titles and meta", () => {
  it("renders loved sync as 喜欢同步 → 收藏 instead of playlist — 收藏", () => {
    const rec = {
      ts: new Date(2026, 10, 13, 7, 33, 0).getTime(),
      ok: false,
      path: "loved_playlist_sync",
      source: "manual",
      artist: "playlist",
      title: "收藏",
    };
    expect(formatRecentTitle(rec)).toBe("喜欢同步 → 收藏");
    expect(formatRecentTitle(rec)).not.toMatch(/playlist/i);
    const meta = formatRecentMeta(rec);
    expect(meta).toBe("2026-11-13 07:33:00 · 手动");
    expect(meta).not.toMatch(/playlist|writeback/i);
  });

  it("uses the custom playlist name in the loved-sync title", () => {
    expect(
      formatRecentTitle({ path: "loved_playlist_sync", artist: "playlist", title: "Last.fm Loved" })
    ).toBe("喜欢同步 → Last.fm Loved");
  });

  it("drops the writeback English source tag beside 收藏写回", () => {
    const rec = {
      ts: new Date(2026, 10, 13, 8, 0, 0).getTime(),
      ok: true,
      path: "loved_writeback",
      source: "writeback",
      artist: "周杰伦",
      title: "晴天",
    };
    expect(formatRecentTitle(rec)).toBe("周杰伦 — 晴天");
    expect(formatRecentMeta(rec)).toBe("2026-11-13 08:00:00 · 收藏写回");
    expect(formatRecentMeta(rec)).not.toMatch(/writeback/i);
  });

  it("does not show lastfm→stats as a track title", () => {
    const rec = {
      ts: new Date(2026, 10, 13, 9, 0, 0).getTime(),
      ok: true,
      path: "stats_sync",
      source: "scheduled",
      artist: "lastfm→stats",
      title: "播放统计同步",
    };
    expect(formatRecentTitle(rec)).toBe("播放统计同步");
    expect(formatRecentTitle(rec)).not.toMatch(/lastfm/i);
    expect(formatRecentMeta(rec)).toBe("2026-11-13 09:00:00 · 定时");
  });
});

describe("selectRecentRecords", () => {
  function rec(id: string, ok: boolean) {
    return { id, ok, path: "finish", title: id, artist: "A" };
  }

  it("defaults to five rows and pins the latest failure when it would otherwise be hidden", () => {
    expect(PREVIEW_COUNT).toBe(5);
    const fail = rec("fail", false);
    const all = [rec("s1", true), rec("s2", true), rec("s3", true), rec("s4", true), rec("s5", true), fail];
    const preview = selectRecentRecords(all, "preview");
    expect(preview).toHaveLength(5);
    expect(preview[0]).toBe(fail);
    expect(preview.slice(1).map((r: { id: string }) => r.id)).toEqual(["s1", "s2", "s3", "s4"]);
    expect(preview).not.toContainEqual(rec("s5", true));
  });

  it("does not re-pin or duplicate a failure already inside the default five", () => {
    const fail = rec("fail", false);
    const all = [rec("s1", true), rec("s2", true), fail, rec("s3", true), rec("s4", true), rec("s5", true)];
    const preview = selectRecentRecords(all, "preview");
    expect(preview).toEqual(all.slice(0, 5));
    expect(preview.filter((r: { id: string }) => r.id === "fail")).toHaveLength(1);
  });

  it("leaves all / failed views unpinned", () => {
    const fail = rec("fail", false);
    const all = [rec("s1", true), rec("s2", true), rec("s3", true), rec("s4", true), rec("s5", true), fail];
    expect(selectRecentRecords(all, "all")).toEqual(all);
    expect(selectRecentRecords(all, "failed")).toEqual([fail]);
  });
});

describe("text wrap strategy", () => {
  it("keeps CJK words intact and only wraps when needed", () => {
    expect(TEXT_WRAP_STYLE).toEqual({ wordBreak: "keep-all", overflowWrap: "anywhere" });
    expect(TEXT_WRAP_STYLE.wordBreak).not.toBe("break-all");
  });
});

describe("Last.fm brand colors", () => {
  it("uses the live last.fm primary button red, not CanvasText or Songloft blue", () => {
    expect(LASTFM_BRAND.primary).toBe("#d92323");
    expect(LASTFM_BRAND.primaryHover).toBe("#f71414");
    expect(LASTFM_BRAND.primaryText).toBe("#ffffff");
    expect(LASTFM_BRAND.danger).toBe("#b00020");
    expect(LASTFM_BRAND.danger).not.toBe(LASTFM_BRAND.primary);
  });

  it("keeps settings CSS in sync: primary is solid Last.fm red + white, secondary is outline, danger is outline warning red", () => {
    const html = readFileSync(resolve(process.cwd(), "static/index.html"), "utf8");
    expect(html).toContain("--lastfm-primary: " + LASTFM_BRAND.primary);
    expect(html).toContain("--lastfm-primary-hover: " + LASTFM_BRAND.primaryHover);
    const primaryBlock = html.split("button.primary {")[1].split("button.danger")[0];
    expect(primaryBlock).toContain("background: var(--lastfm-primary)");
    expect(primaryBlock).toContain("color: var(--lastfm-primary-text)");
    expect(primaryBlock).toContain("background: var(--lastfm-primary-hover)");
    expect(primaryBlock).not.toMatch(/background:\s*CanvasText/);
    expect(html).toContain("accent-color: var(--lastfm-primary)");
    expect(html).not.toMatch(/accent-color:\s*CanvasText/);
    const secondaryBlock = html.split("button.secondary")[1].split("button.primary")[0];
    expect(secondaryBlock).toContain("background: Canvas");
    expect(secondaryBlock).not.toContain("var(--lastfm-primary)");
    const dangerBlock = html.split("button.danger {")[1].split("button:disabled")[0];
    expect(dangerBlock).toContain("#b00020");
    expect(dangerBlock).toContain("background: Canvas");
    expect(dangerBlock).not.toContain("var(--lastfm-primary)");
  });
});

describe("status bar does not show a leftover 最近失败 banner", () => {
  it("removes the account-bar alert while keeping recent-record failure pinning", () => {
    const html = readFileSync(resolve(process.cwd(), "static/index.html"), "utf8");
    const app = readFileSync(resolve(process.cwd(), "static/js/app.js"), "utf8");
    expect(html).not.toMatch(/statusAlert|status-alert|最近失败/);
    expect(app).not.toMatch(/updateStatusAlert|statusAlert|最近失败/);
    expect(PREVIEW_COUNT).toBe(5);
    const fail = { id: "fail", ok: false, path: "finish", title: "fail", artist: "A" };
    const all = [
      { id: "s1", ok: true, path: "finish", title: "s1", artist: "A" },
      { id: "s2", ok: true, path: "finish", title: "s2", artist: "A" },
      { id: "s3", ok: true, path: "finish", title: "s3", artist: "A" },
      { id: "s4", ok: true, path: "finish", title: "s4", artist: "A" },
      { id: "s5", ok: true, path: "finish", title: "s5", artist: "A" },
      fail,
    ];
    expect(selectRecentRecords(all, "preview")[0]).toBe(fail);
  });
});
