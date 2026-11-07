const { apiGet, apiPost } = SongloftPlugin;

function $(id) { return document.getElementById(id); }

function setFlash(text, cls) {
  const el = $("flash");
  el.className = cls || "muted";
  el.textContent = text || "";
}


const PATH_LABEL = {
  "early-threshold": "提前阈值",
  finish: "播完",
  skip: "跳过时达标",
  test: "手动探测",
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

async function loadScrobbles() {
  const res = await apiGet("/api/scrobbles");
  renderScrobbles(res.records || []);
  return res;
}


function friendlyLogMessage(msg) {
  const s = String(msg || "");
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

  applyConnectionUI(st, settings);

  if (options.flash) setFlash(options.flash, options.flashCls || "muted");
  else if (!options.keepFlash) setFlash("");

  const log = await apiGet("/api/log");
  $("logBox").textContent = (log.log || []).map((e) => {
    const t = new Date(e.ts).toLocaleString();
    return `[${t}] ${e.level}: ${friendlyLogMessage(e.message)}`;
  }).reverse().join("\n") || "(empty)";

  try {
    await loadScrobbles();
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

document.addEventListener("DOMContentLoaded", () => {
  refresh().catch((e) => setFlash(String(e), "err"));
});
