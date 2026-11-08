const { apiGet, apiPost } = SongloftPlugin;

function $(id) { return document.getElementById(id); }

/** Mirror store.stripSecrets — keep secrets out of flash even if API slips. */
function stripSecrets(raw) {
  let s = String(raw ?? "");
  s = s.replace(/[a-fA-F0-9]{32,}/g, "[已隐藏]");
  s = s.replace(
    /\b(api[_-]?key|api[_-]?secret|shared[_-]?secret|session[_-]?key|password|token|sk)\b\s*[:=]\s*\S+/gi,
    "$1=[已隐藏]"
  );
  return s;
}

function setFlash(text, cls) {
  const el = $("flash");
  el.className = cls || "muted";
  el.textContent = text ? stripSecrets(String(text)) : "";
}


const PATH_LABEL = {
  "early-threshold": "提前阈值",
  finish: "播完",
  skip: "跳过时达标",
  switch: "切歌时达标",
  replay: "重播前达标",
  nowplaying: "正在播放",
  test: "手动探测",
  love: "红心",
  unlove: "取消红心",
  loved_playlist_sync: "Loved歌单",
  stats_sync: "播放统计同步",
};

function pathLabel(path) {
  if (!path) return "";
  return PATH_LABEL[path] || path;
}

function renderScrobbles(records) {
  const box = $("scrobbleList");
  if (!box) return;
  const list = Array.isArray(records) ? records.slice().reverse() : [];
  if (!list.length) {
    box.innerHTML = '<div class="scrobble-empty">暂无记录。听几首歌或点「测 Scrobble」后会出现在这里。</div>';
    return;
  }
  box.innerHTML = list.map((r) => {
    const t = new Date(r.ts).toLocaleString();
    const ok = !!r.ok;
    const badge = ok
      ? '<span class="badge ok">成功</span>'
      : '<span class="badge err">失败</span>';
    const title = escapeHtml(r.title || "Unknown");
    const artist = escapeHtml(r.artist || "Unknown");
    const path = pathLabel(r.path);
    const src = r.source ? (" · " + escapeHtml(r.source)) : "";
    const meta = escapeHtml(t) + (path ? (" · " + path) : "") + src;
    const reason = !ok && r.reason
      ? '<div class="reason">' + escapeHtml(friendlyLogMessage(r.reason)) + '</div>'
      : "";
    return (
      '<div class="scrobble-row">' +
        '<div><strong>' + artist + '</strong> — ' + title +
          '<div class="meta">' + meta + '</div></div>' +
        '<div>' + badge + '</div>' +
        reason +
      '</div>'
    );
  }).join("");
}

function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}


function updateLoveCurrent(lastPlay) {
  const el = $("loveCurrent");
  if (!el) return;
  if (lastPlay && lastPlay.artist && lastPlay.title) {
    const when = lastPlay.atMs ? (" · " + new Date(lastPlay.atMs).toLocaleString()) : "";
    const src = lastPlay.source ? (" · " + lastPlay.source) : "";
    el.textContent = "当前曲：" + lastPlay.artist + " — " + lastPlay.title + when + src;
  } else {
    el.textContent = "当前曲：还没有播放记录。先听一首，或下面手动填。";
  }
}

async function doLove(kind, opts) {
  const options = opts || {};
  const body = {};
  if (options.artist) body.artist = options.artist;
  if (options.title) body.title = options.title;
  const pathApi = kind === "love" ? "/api/love" : "/api/unlove";
  const res = await apiPost(pathApi, body);
  if (!res.ok) throw new Error(res.error || "failed");
  return res;
}


function formatLovedNextDue(schedule) {
  if (!schedule || !schedule.enabled) return "下次：定时已关闭";
  if (!schedule.nextDueAt) return "下次：等待安排";
  try {
    return "下次：" + new Date(schedule.nextDueAt).toLocaleString();
  } catch (_) {
    return "下次：—";
  }
}

function applyLovedScheduleFields(settingsOrSchedule) {
  const enabledEl = $("lovedScheduleEnabled");
  const intervalEl = $("lovedScheduleIntervalHours");
  if (!enabledEl && !intervalEl) return;
  const src = settingsOrSchedule || {};
  const enabled =
    src.lovedScheduleEnabled !== undefined
      ? !!src.lovedScheduleEnabled
      : !!(src.enabled);
  const hours =
    src.lovedScheduleIntervalHours !== undefined
      ? src.lovedScheduleIntervalHours
      : src.intervalHours;
  if (enabledEl) enabledEl.checked = !!enabled;
  if (intervalEl) intervalEl.value = String(hours === 6 || hours === 12 || hours === 24 ? hours : 24);
}


function formatStatsNextDue(schedule) {
  if (!schedule || !schedule.enabled) return "下次：定时关闭";
  if (!schedule.nextDueAt) return "下次：待排期";
  return "下次：" + new Date(schedule.nextDueAt).toLocaleString();
}

function applyStatsScheduleFields(settingsOrSchedule) {
  const enabledEl = $("statsScheduleEnabled");
  const capEl = $("statsSyncHardCap");
  const src = settingsOrSchedule || {};
  if (enabledEl) {
    enabledEl.checked =
      src.statsScheduleEnabled !== undefined
        ? !!src.statsScheduleEnabled
        : !!src.enabled;
  }
  if (capEl && src.statsSyncHardCap !== undefined) {
    capEl.value = String(src.statsSyncHardCap);
  } else if (capEl && src.hardCap !== undefined) {
    capEl.value = String(src.hardCap);
  }
}



/** Official stats plugin (entry=stats) probe result + Last.fm connection for UI gates. */
let statsPluginAvailable = false;
let statsNeedConnection = true;

function applyStatsControls() {
  const available = !!statsPluginAvailable;
  const hint = $("statsPluginHint");
  if (hint) {
    if (available) hint.classList.add("hidden");
    else hint.classList.remove("hidden");
  }
  const canSync = available && !statsNeedConnection;
  if ($("btnSyncStats")) $("btnSyncStats").disabled = !canSync;
  if ($("btnSyncStatsFull")) $("btnSyncStatsFull").disabled = !canSync;
  ["statsSyncHardCap", "btnSaveStatsCap", "statsScheduleEnabled", "btnSaveStatsSchedule"].forEach((id) => {
    const el = $(id);
    if (el) el.disabled = !available;
  });
}

async function loadStatsSync() {
  const el = $("statsSyncLast");
  const nextEl = $("statsSyncNext");
  if (!el) return null;
  try {
    const res = await apiGet("/api/stats-sync");
    el.textContent = "上次：" + (res.summary || "尚未同步过");
    if (nextEl) nextEl.textContent = formatStatsNextDue(res.schedule);
    if (res.schedule) applyStatsScheduleFields({ ...res.schedule, hardCap: res.hardCap });
    if (typeof res.hardCap === "number" && $("statsSyncHardCap")) {
      $("statsSyncHardCap").value = String(res.hardCap);
    }
    statsPluginAvailable = typeof res.statsAvailable === "boolean" ? res.statsAvailable : false;
    applyStatsControls();
    return res;
  } catch (e) {
    el.textContent = "上次：无法读取（" + friendlyLogMessage(e.message) + "）";
    statsPluginAvailable = false;
    applyStatsControls();
    return null;
  }
}

async function loadLovedSync() {
  const el = $("lovedSyncLast");
  const nextEl = $("lovedSyncNext");
  if (!el) return null;
  try {
    const res = await apiGet("/api/loved-playlist");
    el.textContent = "上次：" + (res.summary || "尚未同步过");
    if (nextEl) nextEl.textContent = formatLovedNextDue(res.schedule);
    if (res.schedule) applyLovedScheduleFields(res.schedule);
    return res;
  } catch (e) {
    el.textContent = "上次：无法读取（" + friendlyLogMessage(e.message) + "）";
    if (nextEl) nextEl.textContent = "下次：—";
    return null;
  }
}
async function loadScrobbles() {
  const res = await apiGet("/api/scrobbles");
  renderScrobbles(res.records || []);
  return res;
}


function friendlyLogMessage(msg) {
  const s = stripSecrets(String(msg || ""));
  if (/Invalid session key|error\s*9\b|连接已失效/i.test(s)) {
    return "连接已失效，请重新连接账号";
  }
  return s;
}

/** @returns {"connected"|"needsReconnect"|"disconnected"} */
function connectionState(status) {
  const s = status || {};
  if (s.authorized) return "connected";
  if (s.needsReconnect) return "needsReconnect";
  return "disconnected";
}

let pollTimer = null;
let pollCount = 0;
let lastConfigured = false;
let authUrl = "";

function stopPolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  pollCount = 0;
}

function showWaiting(url) {
  authUrl = url || authUrl;
  const box = $("connectWaiting");
  box.classList.remove("hidden");
  const link = authUrl
    ? ` <a href="${authUrl}" target="_blank" rel="noreferrer">再次打开授权页</a>`
    : "";
  $("connectWaitingText").innerHTML =
    "已打开 Last.fm 授权页。请在网页点允许，然后回到这里——我们会自动完成连接。" + link;
  $("connectPanel").classList.remove("hidden");
  $("connectPanel").scrollIntoView({ behavior: "smooth", block: "nearest" });
}

function hideWaiting() {
  stopPolling();
  $("connectWaiting").classList.add("hidden");
  authUrl = "";
  $("authHint").textContent = "";
}

function applyConnectionUI(st, settings) {
  const s = (st && st.status) || {};
  const state = connectionState(s);
  const bar = $("statusBar");
  const main = $("statusMain");
  const sub = $("statusSub");
  const cta = $("btnConnectCta");
  const disc = $("btnDisconnect");
  const user = s.username || settings.username || "";
  lastConfigured = !!s.configured;

  bar.className = "status-bar";
  cta.classList.remove("cta-pulse");
  cta.hidden = false;
  cta.disabled = false;
  disc.hidden = true;

  if (state === "connected") {
    bar.classList.add("ok");
    main.textContent = user ? ("已连接 · @" + user) : "已连接";
    sub.textContent = st.message || "可同步播放记录";
    cta.hidden = true;
    disc.hidden = false;
    hideWaiting();
  } else if (state === "needsReconnect") {
    bar.classList.add("err");
    main.textContent = user ? ("需重新连接 · @" + user) : "需重新连接";
    sub.textContent = st.message || "连接已失效，请重新连接账号";
    cta.textContent = "重新连接账号";
    cta.classList.add("cta-pulse");
  } else {
    bar.classList.add(s.configured ? "warn" : "err");
    main.textContent = "未连接";
    sub.textContent = st.message || (s.configured ? "请连接 Last.fm 账号" : "请先填写应用凭证（高级）");
    cta.textContent = "连接账号";
    if (s.configured) cta.classList.add("cta-pulse");
  }

  const connected = state === "connected";
  $("enabled").disabled = !connected;
  $("enabledHint").textContent = connected ? "" : "（先连接账号）";
  $("onlyMiot").disabled = !connected;
  $("minDurationSec").disabled = !connected;
  $("delayPercent").disabled = !connected;
  $("delayMaxSec").disabled = !connected;
  $("btnSave").disabled = !connected;

  // 已连接：整块连接面板隐藏；未连接：显示在播放记录之上
  $("connectPanel").classList.toggle("hidden", connected);
}

async function refresh(opts) {
  const options = opts || {};
  const st = await apiGet("/api/status");
  const settings = await apiGet("/api/settings");
  $("apiKey").value = "";
  $("apiKey").placeholder = settings.apiKeySet ? "已保存（留空不改）" : "填入 Last.fm API Key";
  if ($("apiSecret")) $("apiSecret").placeholder = settings.apiSecretSet ? "已保存（留空不改）" : "填入 Shared Secret";
  if ($("username")) $("username").value = settings.username || "";
  $("onlyMiot").checked = !!settings.onlyMiot;
  $("enabled").checked = settings.enabled !== false;
  $("minDurationSec").value = settings.minDurationSec ?? 30;
  $("delayPercent").value = settings.delayPercent ?? 50;
  $("delayMaxSec").value = settings.delayMaxSec ?? 240;
  if ($("lovedPlaylistName")) {
    $("lovedPlaylistName").value = settings.lovedPlaylistName || "Last.fm Loved";
  }
  applyLovedScheduleFields(settings);

  applyConnectionUI(st, settings);
  updateLoveCurrent(st.lastPlay);

  const loveDisabled = connectionState((st && st.status) || {}) !== "connected";
  statsNeedConnection = loveDisabled;
  // P3: playlist name can be saved while disconnected; sync/love still need session.
  ["btnLove", "btnUnlove", "btnLoveProbe", "btnUnloveProbe", "btnLoveTest", "btnUnloveTest", "btnSyncLoved"].forEach((id) => {
    const b = $(id);
    if (b) b.disabled = loveDisabled;
  });
  if ($("lovedPlaylistName")) $("lovedPlaylistName").disabled = false;
  if ($("btnSaveLovedName")) $("btnSaveLovedName").disabled = false;
  // Schedule toggle/interval: not gated by connection / onlyMiot.
  if ($("lovedScheduleEnabled")) $("lovedScheduleEnabled").disabled = false;
  if ($("lovedScheduleIntervalHours")) $("lovedScheduleIntervalHours").disabled = false;
  if ($("btnSaveLovedSchedule")) $("btnSaveLovedSchedule").disabled = false;
  applyStatsScheduleFields(settings);
  applyStatsControls();

  if (options.flash) setFlash(options.flash, options.flashCls || "muted");
  else if (!options.keepFlash) setFlash("");

  const log = await apiGet("/api/log");
  $("logBox").textContent = (log.log || []).map((e) => {
    const t = new Date(e.ts).toLocaleString();
    return `[${t}] ${e.level}: ${friendlyLogMessage(e.message)}`;
  }).reverse().join("\n") || "(empty)";

  try {
    await loadScrobbles();
  await loadLovedSync();
  await loadStatsSync();
  } catch (_) {
    const box = $("scrobbleList");
    if (box) box.innerHTML = '<div class="scrobble-empty err">记录加载失败</div>';
  }

  return { st, settings };
}

async function saveAuth() {
  const body = {};
  const key = $("apiKey").value.trim();
  if (key) body.apiKey = key;
  if ($("username")) body.username = $("username").value.trim();
  const secret = $("apiSecret").value.trim();
  if (secret) body.apiSecret = secret;
  const sk = $("sessionKey").value.trim();
  if (sk) body.sessionKey = sk;
  const res = await apiPost("/api/settings", body);
  $("apiKey").value = "";
  $("apiSecret").value = "";
  $("sessionKey").value = "";
  return res;
}

async function saveScrobble() {
  const body = {
    onlyMiot: $("onlyMiot").checked,
    enabled: $("enabled").checked,
    minDurationSec: Number($("minDurationSec").value),
    delayPercent: Number($("delayPercent").value),
    delayMaxSec: Number($("delayMaxSec").value),
  };
  await apiPost("/api/settings", body);
}

async function tryFinishWeb() {
  const res = await apiPost("/api/auth/web/finish", {});
  if (!res.ok) throw new Error(res.error || "完成失败");
  hideWaiting();
  $("credsNextHint").classList.add("hidden");
  await refresh({ flash: "已连接 @" + (res.username || ""), flashCls: "ok" });
  return res;
}

function startPolling() {
  stopPolling();
  pollCount = 0;
  pollTimer = setInterval(async () => {
    pollCount += 1;
    if (pollCount > 40) {
      // ~2 min at 3s — stop to avoid rate limit; leave manual finish button
      stopPolling();
      setFlash("仍在等待网页允许。允许后点「我已允许，完成连接」。", "warn");
      return;
    }
    try {
      await tryFinishWeb();
    } catch (_) {
      // not authorized yet — keep waiting quietly
    }
  }, 3000);
}

/** 主 CTA：一键发起网页连接并引导完成 */
async function startWebConnectFlow() {
  if (!lastConfigured && !$("apiKey").value.trim()) {
    $("section-creds").open = true;
    $("section-creds").scrollIntoView({ behavior: "smooth", block: "nearest" });
    setFlash("请先在「应用凭证（高级）」保存 API Key / Secret，再连接账号。", "warn");
    return;
  }
  const cta = $("btnConnectCta");
  cta.disabled = true;
  try {
    const res = await apiPost("/api/auth/web/start", {});
    if (!res.ok) throw new Error(res.error || "启动失败");
    authUrl = res.url;
    // 尽量同手势打开新窗口，避免弹窗拦截
    const win = window.open(res.url, "_blank", "noopener,noreferrer");
    showWaiting(res.url);
    if (!win) {
      setFlash("浏览器拦截了弹窗：请点等待区里的「再次打开授权页」。", "warn");
    } else {
      setFlash("已打开 Last.fm。在网页点允许后，这里会自动连上。", "muted");
    }
    startPolling();
  } catch (e) {
    setFlash("启动连接失败: " + friendlyLogMessage(e.message), "err");
  } finally {
    cta.disabled = false;
  }
}

$("btnReload").onclick = () => refresh().catch((e) => setFlash(String(e), "err"));
$("btnReloadScrobbles").onclick = () => loadScrobbles().catch((e) => setFlash(String(e), "err"));
$("btnReload2").onclick = () => refresh().catch((e) => setFlash(String(e), "err"));

$("btnConnectCta").onclick = () => {
  startWebConnectFlow();
};

$("btnFinishNow").onclick = async () => {
  try {
    await tryFinishWeb();
  } catch (e) {
    setFlash("尚未完成：请确认已在 Last.fm 网页点过允许。(" + friendlyLogMessage(e.message) + ")", "warn");
  }
};

$("btnCancelWait").onclick = () => {
  hideWaiting();
  setFlash("已取消等待。需要时再点「连接账号」。", "muted");
};

$("btnSaveAuth").onclick = async () => {
  try {
    const res = await saveAuth();
    const hint = $("credsNextHint");
    hint.classList.remove("hidden");
    let flash = "应用凭证已保存。下一步：连接账号。";
    if (res && res.sessionInvalidated) {
      flash = "应用凭证已更新，旧连接已作废。请重新连接账号。";
    }
    await refresh({ flash, flashCls: "warn", keepFlash: true });
    $("btnConnectCta").classList.add("cta-pulse");
  } catch (e) {
    setFlash("保存凭证失败: " + e.message, "err");
  }
};

$("btnSave").onclick = async () => {
  try {
    await saveScrobble();
    await refresh({ flash: "播放记录设置已保存", flashCls: "ok" });
  } catch (e) {
    setFlash("保存失败: " + e.message, "err");
  }
};

$("btnLogin").onclick = async () => {
  try {
    await saveAuth();
    const res = await apiPost("/api/login", {
      username: $("username").value.trim(),
      password: $("password").value,
    });
    $("password").value = "";
    if (!res.ok) throw new Error(res.error || "连接失败");
    $("credsNextHint").classList.add("hidden");
    hideWaiting();
    await refresh({ flash: "已连接 @" + (res.username || ""), flashCls: "ok" });
  } catch (e) {
    setFlash("连接失败: " + friendlyLogMessage(e.message), "err");
    await refresh({ keepFlash: true }).catch(() => {});
  }
};

$("btnDisconnect").onclick = async () => {
  await apiPost("/api/logout", {});
  await refresh({ flash: "已断开连接", flashCls: "muted" });
};

$("btnNp").onclick = async () => {
  try {
    const res = await apiPost("/api/test/nowplaying", {});
    if (!res.ok) throw new Error(res.error || "failed");
    await refresh({ flash: "Now Playing 探测已发送", flashCls: "ok" });
  } catch (e) {
    setFlash("Now Playing 失败: " + friendlyLogMessage(e.message), "err");
    await refresh({ keepFlash: true }).catch(() => {});
  }
};

$("btnSc").onclick = async () => {
  try {
    const res = await apiPost("/api/test/scrobble", {});
    if (!res.ok) throw new Error(res.error || "failed");
    await refresh({ flash: "Scrobble 探测已发送", flashCls: "ok" });
  } catch (e) {
    setFlash("Scrobble 失败: " + friendlyLogMessage(e.message), "err");
    await refresh({ keepFlash: true }).catch(() => {});
  }
};


$("btnLove").onclick = async () => {
  try {
    const res = await doLove("love");
    await refresh({ flash: "已红心：" + res.artist + " — " + res.title, flashCls: "ok" });
  } catch (e) {
    setFlash("红心失败: " + friendlyLogMessage(e.message), "err");
    await refresh({ keepFlash: true }).catch(() => {});
  }
};

$("btnUnlove").onclick = async () => {
  try {
    const res = await doLove("unlove");
    await refresh({ flash: "已取消红心：" + res.artist + " — " + res.title, flashCls: "ok" });
  } catch (e) {
    setFlash("取消红心失败: " + friendlyLogMessage(e.message), "err");
    await refresh({ keepFlash: true }).catch(() => {});
  }
};

async function loveProbe(kind) {
  const artist = $("loveArtist").value.trim();
  const title = $("loveTitle").value.trim();
  if (!artist || !title) {
    setFlash("请填写艺人与曲名，或先播放一首歌后用上方按钮。", "warn");
    return;
  }
  try {
    const res = await doLove(kind, { artist, title });
    const verb = kind === "love" ? "已红心" : "已取消红心";
    await refresh({ flash: verb + "：" + res.artist + " — " + res.title, flashCls: "ok" });
  } catch (e) {
    setFlash((kind === "love" ? "红心" : "取消红心") + "失败: " + friendlyLogMessage(e.message), "err");
    await refresh({ keepFlash: true }).catch(() => {});
  }
}

$("btnLoveProbe").onclick = () => loveProbe("love");
$("btnUnloveProbe").onclick = () => loveProbe("unlove");


async function saveLovedPlaylistName() {
  const raw = $("lovedPlaylistName") ? $("lovedPlaylistName").value : "";
  await apiPost("/api/settings", { lovedPlaylistName: raw });
}

$("btnSaveLovedName").onclick = async () => {
  try {
    await saveLovedPlaylistName();
    await refresh({ flash: "Loved 歌单名已保存", flashCls: "ok" });
  } catch (e) {
    setFlash("保存歌单名失败: " + friendlyLogMessage(e.message), "err");
    await refresh({ keepFlash: true }).catch(() => {});
  }
};

async function saveLovedSchedule() {
  const enabled = $("lovedScheduleEnabled") ? $("lovedScheduleEnabled").checked : false;
  const hoursRaw = $("lovedScheduleIntervalHours") ? $("lovedScheduleIntervalHours").value : "24";
  const hours = Number(hoursRaw);
  await apiPost("/api/settings", {
    lovedScheduleEnabled: !!enabled,
    lovedScheduleIntervalHours: hours === 6 || hours === 12 || hours === 24 ? hours : 24,
  });
}

$("btnSaveLovedSchedule").onclick = async () => {
  try {
    await saveLovedSchedule();
    await refresh({ flash: "Loved 定时已保存", flashCls: "ok" });
  } catch (e) {
    setFlash("保存定时失败: " + friendlyLogMessage(e.message), "err");
    await refresh({ keepFlash: true }).catch(() => {});
  }
};

$("btnSyncLoved").onclick = async () => {
  const btn = $("btnSyncLoved");
  btn.disabled = true;
  try {
    // Persist name first so sync uses the value currently in the input.
    await saveLovedPlaylistName();
    setFlash("正在同步 Loved 到歌单…", "muted");
    const res = await apiPost("/api/loved-playlist/sync", {});
    if (!res.ok) throw new Error(res.error || "同步失败");
    await refresh({
      flash: "Loved 歌单已更新：" + (res.summary || ""),
      flashCls: "ok",
    });
  } catch (e) {
    setFlash("Loved 同步失败: " + friendlyLogMessage(e.message), "err");
    await refresh({ keepFlash: true }).catch(() => {});
  }
  // disabled state comes from refresh() / connectionState — do not force-enable
};
$("btnLoveTest").onclick = async () => {
  try {
    const res = await apiPost("/api/test/love", {});
    if (!res.ok) throw new Error(res.error || "failed");
    await refresh({ flash: "红心探测已发送：" + res.artist + " — " + res.title, flashCls: "ok" });
  } catch (e) {
    setFlash("红心探测失败: " + friendlyLogMessage(e.message), "err");
    await refresh({ keepFlash: true }).catch(() => {});
  }
};

$("btnUnloveTest").onclick = async () => {
  try {
    const res = await apiPost("/api/test/unlove", {});
    if (!res.ok) throw new Error(res.error || "failed");
    await refresh({ flash: "取消红心探测已发送：" + res.artist + " — " + res.title, flashCls: "ok" });
  } catch (e) {
    setFlash("取消红心探测失败: " + friendlyLogMessage(e.message), "err");
    await refresh({ keepFlash: true }).catch(() => {});
  }
};

document.addEventListener("DOMContentLoaded", () => {
  refresh().catch((e) => setFlash(String(e), "err"));
});





$("btnSaveStatsCap") && ($("btnSaveStatsCap").onclick = async () => {
  try {
    const raw = $("statsSyncHardCap") ? $("statsSyncHardCap").value : "500";
    await apiPost("/api/settings", { statsSyncHardCap: Number(raw) });
    await refresh({ flash: "同步上限已保存", flashCls: "ok" });
  } catch (e) {
    setFlash("保存上限失败: " + friendlyLogMessage(e.message), "err");
  }
});

$("btnSaveStatsSchedule") && ($("btnSaveStatsSchedule").onclick = async () => {
  try {
    const enabled = $("statsScheduleEnabled") ? $("statsScheduleEnabled").checked : false;
    await apiPost("/api/settings", {
      statsScheduleEnabled: !!enabled,
      statsScheduleIntervalHours: 24,
    });
    await refresh({ flash: "播放统计定时已保存", flashCls: "ok" });
  } catch (e) {
    setFlash("保存定时失败: " + friendlyLogMessage(e.message), "err");
  }
});

$("btnSyncStats") && ($("btnSyncStats").onclick = async () => {
  const btn = $("btnSyncStats");
  if (btn) btn.disabled = true;
  const fullBtn = $("btnSyncStatsFull");
  if (fullBtn) fullBtn.disabled = true;
  try {
    // persist hard cap before sync
    const raw = $("statsSyncHardCap") ? $("statsSyncHardCap").value : "500";
    await apiPost("/api/settings", { statsSyncHardCap: Number(raw) });
    setFlash("正在同步 Last.fm → 播放统计…", "muted");
    const res = await apiPost("/api/stats-sync", {});
    await refresh({
      flash: "播放统计已同步：" + (res.summary || ""),
      flashCls: "ok",
    });
  } catch (e) {
    setFlash("播放统计同步失败: " + friendlyLogMessage(e.message), "err");
    try { await loadStatsSync(); } catch (_) {}
  } finally {
    applyStatsControls();
  }
});

$("btnSyncStatsFull") && ($("btnSyncStatsFull").onclick = async () => {
  const ok = window.confirm(
    "尽量同步：单次最多约 5000 条，并暂时忽略水位以便首次回填。\n" +
      "只写入曲库已有歌曲；未匹配会跳过。已导入的会去重。\n" +
      "需已安装官方「播放统计」插件。可能较慢（后台进行），确定继续？"
  );
  if (!ok) return;
  const btn = $("btnSyncStatsFull");
  const incrBtn = $("btnSyncStats");
  if (btn) btn.disabled = true;
  if (incrBtn) incrBtn.disabled = true;
  try {
    setFlash("正在尽量同步 Last.fm → 播放统计（硬顶 5000）…", "muted");
    const res = await apiPost("/api/stats-sync", { mode: "full" });
    if (res.accepted) {
      setFlash("尽量同步已开始，后台进行中…", "muted");
      const prevTs = res.last && res.last.ts;
      let finalSummary = res.summary || "";
      // ok | fail | skipped | timeout — never fake "完成" on skip/fail
      let outcome = "timeout";
      // ~360s: hardCap 5000 may exceed old 240s poll window
      for (let i = 0; i < 180; i++) {
        await new Promise((r) => setTimeout(r, 2000));
        const st = await apiGet("/api/stats-sync");
        if (!st) {
          setFlash("尽量同步进行中… (" + ((i + 1) * 2) + "s)", "muted");
          continue;
        }
        const running = !!st.running;
        const ts = st.last && st.last.ts;
        const tsChanged = !!(ts && ts !== prevTs);
        if (!running) {
          finalSummary = st.summary || finalSummary;
          if (tsChanged) {
            outcome = st.last && st.last.ok === false ? "fail" : "ok";
            break;
          }
          // Accept then skip_busy: ts unchanged once queue clears. Allow a few ticks for setTimeout(0).
          if (i > 2) {
            outcome = "skipped";
            break;
          }
        }
        setFlash("尽量同步进行中… (" + ((i + 1) * 2) + "s)", "muted");
      }
      if (outcome === "ok") {
        await refresh({
          flash: "尽量同步完成：" + finalSummary,
          flashCls: "ok",
        });
      } else if (outcome === "fail") {
        await refresh({
          flash: "尽量同步失败：" + finalSummary,
          flashCls: "err",
        });
      } else if (outcome === "skipped") {
        await refresh({
          flash: "尽量同步未执行（忙或已跳过）：" + finalSummary,
          flashCls: "err",
        });
      } else {
        await refresh({
          flash: "尽量同步仍在进行或超时，请稍后刷新状态：" + finalSummary,
          flashCls: "muted",
        });
      }
    } else {
      await refresh({
        flash: "尽量同步未开始（忙）：" + (res.summary || res.reason || ""),
        flashCls: "err",
      });
    }
  } catch (e) {
    setFlash("尽量同步失败: " + friendlyLogMessage(e.message), "err");
    try { await loadStatsSync(); } catch (_) {}
  } finally {
    applyStatsControls();
  }
});
