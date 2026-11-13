/** Pure settings-page helpers. Also exposed as LastfmSettingsUi for the browser. */
(function (root) {
  "use strict";

  function pad2(n) {
    return String(n).padStart(2, "0");
  }

  /** Host-local 24-hour time, no zone label. */
  function formatDateTime(ts, withSeconds) {
    if (ts == null || ts === "") return "—";
    const d = ts instanceof Date ? ts : new Date(ts);
    if (Number.isNaN(d.getTime())) return "—";
    const out =
      d.getFullYear() +
      "-" +
      pad2(d.getMonth() + 1) +
      "-" +
      pad2(d.getDate()) +
      " " +
      pad2(d.getHours()) +
      ":" +
      pad2(d.getMinutes());
    return withSeconds ? out + ":" + pad2(d.getSeconds()) : out;
  }

  const PATH_LABEL = {
    "early-threshold": "提前达标",
    finish: "播完",
    skip: "跳过时达标",
    switch: "切歌时达标",
    replay: "重播前达标",
    nowplaying: "正在播放",
    test: "手动测试",
    love: "喜欢",
    unlove: "取消喜欢",
    loved_playlist_sync: "喜欢同步",
    loved_writeback: "收藏写回",
    stats_sync: "播放统计同步",
  };

  const SOURCE_LABEL = {
    manual: "手动",
    scheduled: "定时",
    "songloft-player": "播放触发",
    miot: "小爱音箱",
    writeback: "",
    test: "测试",
  };

  const PREVIEW_COUNT = 5;

  /** CSS wrap strategy for settings-page copy: keep CJK words intact, wrap only if needed. */
  const TEXT_WRAP_STYLE = {
    wordBreak: "keep-all",
    overflowWrap: "anywhere",
  };

  /**
   * Live last.fm brand colors from www.last.fm CSS, fetched 2026-11-13:
   * /static/styles/build/app-reduced-13dae47e6d.6c38daa23752.css
   * .btn-primary rest/active = --clr-postbox #d92323; hover = --clr-habanero #f71414.
   * Classic logo red #D51007 is not in that current stylesheet.
   * Danger/error stays a distinct warning red, not the solid primary fill.
   */
  const LASTFM_BRAND = {
    primary: "#d92323",
    primaryHover: "#f71414",
    primaryText: "#ffffff",
    danger: "#b00020",
  };

  function pathLabel(path) {
    if (!path) return "";
    return PATH_LABEL[path] || path;
  }

  function sourceLabel(source) {
    if (!source) return "";
    if (Object.prototype.hasOwnProperty.call(SOURCE_LABEL, source)) {
      return SOURCE_LABEL[source];
    }
    return source;
  }

  function isLovedSyncRecord(r) {
    return !!(r && (r.path === "loved_playlist_sync" || r.artist === "playlist"));
  }

  function isStatsSyncRecord(r) {
    return !!(r && (r.path === "stats_sync" || r.artist === "lastfm→stats" || r.artist === "lastfm->stats"));
  }

  function formatRecentTitle(record) {
    const r = record || {};
    if (isLovedSyncRecord(r)) {
      const target = r.title && r.title !== "Unknown" ? r.title : "收藏";
      return "喜欢同步 → " + target;
    }
    if (isStatsSyncRecord(r)) {
      return "播放统计同步";
    }
    if (r.artist || r.title) {
      return (r.artist || "未知艺人") + " — " + (r.title || "未知曲名");
    }
    return pathLabel(r.path) || "记录";
  }

  function formatRecentMeta(record) {
    const r = record || {};
    const time = formatDateTime(r.ts, true);
    const path = pathLabel(r.path);
    const src = sourceLabel(r.source);
    const operationInTitle = isLovedSyncRecord(r) || isStatsSyncRecord(r);
    const hasTrack = !!(r.artist || r.title) && !operationInTitle;
    const parts = [time];
    if (hasTrack && path) parts.push(path);
    if (src && src !== path) parts.push(src);
    return parts.filter(Boolean).join(" · ");
  }

  /**
   * Default preview pins the latest failure at the top when it is not already
   * among the first `previewCount` rows. Already-visible failures are left in place.
   */
  function selectRecentRecords(records, mode, previewCount) {
    const all = Array.isArray(records) ? records : [];
    const count = previewCount == null ? PREVIEW_COUNT : previewCount;
    if (mode === "failed") return all.filter((r) => !r.ok);
    if (mode === "all") return all.slice();
    const preview = all.slice(0, count);
    const latestFail = all.find((r) => !r.ok);
    if (!latestFail) return preview;
    if (preview.indexOf(latestFail) !== -1) return preview;
    return [latestFail].concat(preview.slice(0, Math.max(0, count - 1)));
  }

  function stripSecrets(raw) {
    let s = String(raw ?? "");
    s = s.replace(/[a-fA-F0-9]{32,}/g, "[已隐藏]");
    s = s.replace(
      /\b(api[_-]?key|api[_-]?secret|shared[_-]?secret|session[_-]?key|password|token|sk)\b\s*[:=]\s*\S+/gi,
      "$1=[已隐藏]"
    );
    return s;
  }

  function friendlyLogMessage(msg) {
    const s = stripSecrets(String(msg || ""));
    if (!s) return "";
    if (/Invalid session key|error\s*9\b|连接已失效/i.test(s)) {
      return "连接已失效，请重新连接账号";
    }
    if (/timeout|timed out|i\/o timeout|context deadline|ETIMEDOUT|deadline exceeded/i.test(s)) {
      return "连接 Last.fm 超时";
    }
    if (/no such host|getaddrinfo|ENOTFOUND|DNS|Temporary failure in name resolution/i.test(s)) {
      return "无法解析 Last.fm 地址，请检查网络";
    }
    if (
      /network is unreachable|no route to host|EHOSTUNREACH|ENETUNREACH|Failed to connect|network error/i.test(s)
    ) {
      return "无法连接 Last.fm，请检查网络";
    }
    if (/dial tcp|connection refused|ECONNREFUSED/i.test(s)) {
      return "无法连接 Last.fm，请检查网络";
    }
    if (/EOF|ECONNRESET|connection reset|wsarecv|wsasend|connection was aborted/i.test(s)) {
      return "与 Last.fm 的连接已中断";
    }
    if (/certificate|x509|TLS handshake|SSL/i.test(s)) {
      return "连接 Last.fm 的安全证书异常";
    }
    return s;
  }

  function isHumanizedMessage(msg) {
    const raw = stripSecrets(String(msg || ""));
    const friendly = friendlyLogMessage(raw);
    return !!(friendly && raw && friendly !== raw);
  }

  function formatLovedStatsLine(last) {
    if (!last || typeof last !== "object") return "";
    const loved = Number(last.loved) || 0;
    const matched = Number(last.matched) || 0;
    const unmatched = Number(last.unmatched) || 0;
    if (!last.ok && loved <= 0 && matched <= 0 && unmatched <= 0) return "";
    let line = "喜欢 " + loved + " 首 · 已匹配 " + matched + " 首 · 未匹配 " + unmatched + " 首";
    if (last.truncated) line += " · 已截断";
    return line;
  }

  function formatLovedOutcome(last) {
    if (!last) return { time: "", outcome: "尚未同步过", stats: "", ok: null };
    const time = formatDateTime(last.ts);
    const stats = formatLovedStatsLine(last);
    if (last.ok) return { time: time, outcome: "成功", stats: stats, ok: true };
    const reason = friendlyLogMessage(last.reason || "同步失败");
    return { time: time, outcome: "失败：" + reason, stats: stats, ok: false };
  }

  function formatStatsStatsLine(last) {
    if (!last || typeof last !== "object") return "";
    if (
      last.fetched == null &&
      last.matched == null &&
      last.imported == null &&
      last.unmatched == null
    ) {
      return "";
    }
    let line =
      "拉取 " +
      (Number(last.fetched) || 0) +
      " 条 · 已匹配 " +
      (Number(last.matched) || 0) +
      " 首 · 写入 " +
      (Number(last.imported) || 0) +
      " 条 · 跳过（防重复） " +
      (Number(last.skippedNear) || 0);
    if (last.skippedExact) line += " · 跳过（已存在） " + (Number(last.skippedExact) || 0);
    line += " · 未匹配 " + (Number(last.unmatched) || 0) + " 首";
    if (last.truncated) line += " · 已截断";
    return line;
  }

  function formatStatsOutcome(last) {
    if (!last) return { time: "", outcome: "尚未同步过", stats: "", ok: null };
    const time = formatDateTime(last.ts);
    const stats = formatStatsStatsLine(last);
    if (last.ok) return { time: time, outcome: "成功", stats: stats, ok: true };
    const reason = friendlyLogMessage(last.reason || "同步失败");
    return { time: time, outcome: "失败：" + reason, stats: stats, ok: false };
  }

  function isLovedTargetValid(form) {
    const src = form || {};
    const target = src.target === "playlist" ? "playlist" : src.target === "favorites" ? "favorites" : "";
    if (!target) return false;
    return true;
  }

  function canRunLovedSync(state) {
    const s = state || {};
    if (!s.connected) return { ok: false, reason: "请先连接账号" };
    if (!isLovedTargetValid(s.form || s)) return { ok: false, reason: "请选择有效的同步目标" };
    if (s.dirty) return { ok: false, reason: "请先保存同步设置" };
    return { ok: true, reason: "" };
  }

  function canRunStatsSync(state) {
    const s = state || {};
    if (!s.available) return { ok: false, reason: "需先安装并启用官方「播放统计」插件" };
    if (!s.connected) return { ok: false, reason: "请先连接账号" };
    if (s.dirty) return { ok: false, reason: "请先保存统计设置" };
    return { ok: true, reason: "" };
  }

  /**
   * Bidirectional rule follows saved write-back + saved target.
   * Custom-playlist tip follows the form target so the control help stays accurate while editing.
   */
  function lovedModeHint(state) {
    const s = state || {};
    const formTarget = s.formTarget === "playlist" ? "playlist" : "favorites";
    const savedTarget = s.savedTarget === "playlist" ? "playlist" : "favorites";
    const supported = s.hostSupported !== false;
    const merge = !!s.savedWritebackEnabled && savedTarget === "favorites" && supported;
    if (formTarget === "playlist") {
      return "仅单向同步；该歌单的改动不会写回 Last.fm。";
    }
    if (merge) {
      return "双向同步已开启：同步会互相补上起点之后两边新增和取消的喜欢，不再整单覆盖收藏。";
    }
    return "同步会用 Last.fm 的喜欢列表覆盖所选目标，不会把目标中的改动写回 Last.fm。";
  }

  function formatWritebackStatus(state) {
    const s = state || {};
    if (!s.supported) {
      return {
        line: "当前 Songloft 版本不支持收藏写回，请升级后开启。",
        canEnable: false,
        canDisable: !!s.enabled,
      };
    }
    if (!s.enabled) {
      return { line: "未开启", canEnable: true, canDisable: true };
    }
    if (s.needsReconnect || s.paused) {
      return {
        line: "写回已暂停：连接已失效，请重新连接账号。重连后会继续未完成的写回，操作不会丢掉。",
        canEnable: true,
        canDisable: true,
      };
    }
    if (!s.baselineAt) {
      return {
        line:
          "已开启，但还没记下当前喜欢：" +
          (s.snapshotError || "请先连接账号，否则无法记下起点，也不会写回"),
        canEnable: true,
        canDisable: true,
      };
    }
    if (s.deferBusy) {
      return {
        line: "这次没写上：正在同步其它任务，稍后会再试；也可点上方「立即同步喜欢」。不要因此关掉开关。",
        canEnable: true,
        canDisable: true,
      };
    }
    if (s.deferRetry) {
      return { line: "刚才有改动没写上，正在稍后重试", canEnable: true, canDisable: true };
    }
    if (s.lastResultOk === false && s.lastError) {
      return { line: "写回失败：" + s.lastError, canEnable: true, canDisable: true };
    }
    let line = "已开启 · 同步起点：" + formatDateTime(s.baselineAt);
    if (s.truncated) line += " · 起点不完整（记录时 Last.fm 喜欢已截断），可能分批补齐历史";
    return { line: line, canEnable: true, canDisable: true };
  }

  function scheduleNextLine(schedule, disabledText) {
    if (!schedule || !schedule.enabled) return disabledText || "定时同步未开启";
    if (!schedule.nextDueAt) return "下次同步：等待安排";
    return "下次同步：" + formatDateTime(schedule.nextDueAt);
  }

  /** Status row under the save button: current target only (next run lives in the result block). */
  function formatLovedCurrentTarget(saved) {
    const s = saved || {};
    const targetText =
      s.target === "playlist" ? "自定义歌单「" + (s.name || "Last.fm Loved") + "」" : "Songloft 收藏";
    return "当前目标：" + targetText;
  }

  function sameSnapshot(a, b) {
    return JSON.stringify(a) === JSON.stringify(b);
  }

  const api = {
    formatDateTime: formatDateTime,
    pathLabel: pathLabel,
    sourceLabel: sourceLabel,
    formatRecentTitle: formatRecentTitle,
    formatRecentMeta: formatRecentMeta,
    selectRecentRecords: selectRecentRecords,
    stripSecrets: stripSecrets,
    friendlyLogMessage: friendlyLogMessage,
    isHumanizedMessage: isHumanizedMessage,
    formatLovedStatsLine: formatLovedStatsLine,
    formatLovedOutcome: formatLovedOutcome,
    formatStatsStatsLine: formatStatsStatsLine,
    formatStatsOutcome: formatStatsOutcome,
    isLovedTargetValid: isLovedTargetValid,
    canRunLovedSync: canRunLovedSync,
    canRunStatsSync: canRunStatsSync,
    lovedModeHint: lovedModeHint,
    formatWritebackStatus: formatWritebackStatus,
    scheduleNextLine: scheduleNextLine,
    formatLovedCurrentTarget: formatLovedCurrentTarget,
    sameSnapshot: sameSnapshot,
    PATH_LABEL: PATH_LABEL,
    SOURCE_LABEL: SOURCE_LABEL,
    PREVIEW_COUNT: PREVIEW_COUNT,
    TEXT_WRAP_STYLE: TEXT_WRAP_STYLE,
    LASTFM_BRAND: LASTFM_BRAND,
  };

  root.LastfmSettingsUi = api;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
