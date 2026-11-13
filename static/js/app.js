const { apiGet, apiPost } = SongloftPlugin;
const ui = require("./settings-ui.js");

function $(id) { return document.getElementById(id); }

function stripSecrets(raw) {
  return ui.stripSecrets ? ui.stripSecrets(raw) : String(raw ?? "");
}

let toastTimer = null;

function setFlash(text, cls) {
  const el = $("flash");
  if (!el) return;
  if (toastTimer) {
    clearTimeout(toastTimer);
    toastTimer = null;
  }
  const msg = text ? stripSecrets(String(text)) : "";
  if (!msg) {
    el.classList.remove("show");
    el.textContent = "";
    el.className = "toast";
    return;
  }
  el.className = "toast show" + (cls && cls !== "muted" ? " " + cls : "");
  el.textContent = msg;
  const sticky = /正在|进行中|等待网页允许/.test(msg);
  if (sticky) return;
  const ms = cls === "err" ? 4500 : cls === "warn" ? 4000 : 3200;
  toastTimer = setTimeout(() => {
    el.classList.remove("show");
    toastTimer = null;
  }, ms);
}

function pathLabel(path) {
  return ui.pathLabel ? ui.pathLabel(path) : (path || "");
}

function sourceLabel(source) {
  return ui.sourceLabel ? ui.sourceLabel(source) : (source || "");
}

function formatDateTime(ts, withSeconds) {
  return ui.formatDateTime ? ui.formatDateTime(ts, withSeconds) : String(ts ?? "—");
}

function friendlyLogMessage(msg) {
  return ui.friendlyLogMessage ? ui.friendlyLogMessage(msg) : String(msg || "");
}

function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const recentView = { mode: "preview", records: [] };
const PREVIEW_COUNT = 5;

function renderScrobbles(records) {
  const box = $("scrobbleList");
  if (!box) return;
  if (Array.isArray(records)) recentView.records = records.slice().reverse();
  const all = recentView.records;
  if (!all.length) {
    box.innerHTML = '<div class="scrobble-empty">暂无记录。听几首歌或在「诊断」里测试后会出现在这里。</div>';
    return;
  }

  const list = ui.selectRecentRecords
    ? ui.selectRecentRecords(all, recentView.mode, PREVIEW_COUNT)
    : (recentView.mode === "failed" ? all.filter((r) => !r.ok) : recentView.mode === "preview" ? all.slice(0, PREVIEW_COUNT) : all);

  if (!list.length) {
    box.innerHTML = '<div class="scrobble-empty">没有符合条件的记录。</div>';
  } else {
    box.innerHTML = list.map((r) => {
      const ok = !!r.ok;
      const badge = ok
        ? '<span class="badge ok">成功</span>'
        : '<span class="badge err">失败</span>';
      const titleText = ui.formatRecentTitle ? ui.formatRecentTitle(r) : ((r.artist || r.title) ? ((r.artist || "未知艺人") + " — " + (r.title || "未知曲名")) : (pathLabel(r.path) || "记录"));
      const title = "<strong>" + escapeHtml(titleText) + "</strong>";
      const meta = escapeHtml(ui.formatRecentMeta ? ui.formatRecentMeta(r) : formatDateTime(r.ts, true));
      const rawReason = r.reason ? stripSecrets(String(r.reason)) : "";
      const friendly = rawReason ? friendlyLogMessage(rawReason) : "";
      const showRaw = !ok && rawReason && friendly && friendly !== rawReason;
      const reason = !ok && friendly
        ? '<div class="reason">' + escapeHtml(friendly) +
          (showRaw
            ? '<details class="raw"><summary>查看详情</summary><pre>' + escapeHtml(rawReason) + "</pre></details>"
            : "") +
          "</div>"
        : "";
      return (
        '<div class="scrobble-row' + (ok ? "" : " is-fail") + '">' +
          "<div>" + title + '<div class="meta">' + meta + "</div></div>" +
          "<div>" + badge + "</div>" +
          reason +
        "</div>"
      );
    }).join("");
  }

  syncRecentToolbar();
}

function syncRecentToolbar() {
  const preview = $("btnRecentPreview");
  const allBtn = $("btnRecentAll");
  const failBtn = $("btnRecentFailed");
  if (preview) preview.setAttribute("aria-pressed", recentView.mode === "preview" ? "true" : "false");
  if (allBtn) allBtn.setAttribute("aria-pressed", recentView.mode === "all" ? "true" : "false");
  if (failBtn) failBtn.setAttribute("aria-pressed", recentView.mode === "failed" ? "true" : "false");
}

function updateLoveCurrent(lastPlay) {
  const el = $("loveCurrent");
  if (!el) return;
  if (lastPlay && lastPlay.artist && lastPlay.title) {
    const when = lastPlay.atMs ? (" · " + formatDateTime(lastPlay.atMs, true)) : "";
    const src = lastPlay.source ? (" · " + sourceLabel(lastPlay.source)) : "";
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

const dirty = { scrobble: false, loved: false, writeback: false, stats: false };
const savedSnap = { scrobble: null, loved: null, writeback: null, stats: null };
let lastWritebackSettings = null;
let lastStatus = null;

function setSaveState(id, kind, text) {
  const el = $(id);
  if (!el) return;
  el.className = "save-state" + (kind ? " " + kind : " muted");
  el.textContent = text || "";
}

function scrobbleSnapshotFromForm() {
  return {
    enabled: $("enabled") ? $("enabled").checked : true,
    scrobbleLocal: $("scrobbleLocal") ? $("scrobbleLocal").checked : true,
    scrobbleNetwork: $("scrobbleNetwork") ? $("scrobbleNetwork").checked : true,
    sources: [
      $("scrobbleSourceMiot") && $("scrobbleSourceMiot").checked ? "miot" : null,
      $("scrobbleSourceSongloft") && $("scrobbleSourceSongloft").checked ? "songloft-player" : null,
    ].filter(Boolean).join(","),
    minDurationSec: Number($("minDurationSec") ? $("minDurationSec").value : 30),
    delayPercent: Number($("delayPercent") ? $("delayPercent").value : 50),
    delayMaxSec: Number($("delayMaxSec") ? $("delayMaxSec").value : 240),
  };
}

function scrobbleSnapshotFromSettings(settings) {
  const src = settings || {};
  const sources = Array.isArray(src.scrobbleSources)
    ? src.scrobbleSources
    : ["miot", "songloft-player"];
  return {
    enabled: src.enabled !== false,
    scrobbleLocal: src.scrobbleLocal !== false,
    scrobbleNetwork: src.scrobbleNetwork === true,
    sources: sources.filter(Boolean).join(","),
    minDurationSec: src.minDurationSec ?? 30,
    delayPercent: src.delayPercent ?? 50,
    delayMaxSec: src.delayMaxSec ?? 240,
  };
}

function lovedSnapshotFromForm() {
  const raw = $("lovedPlaylistName") ? $("lovedPlaylistName").value.trim() : "";
  const hoursRaw = $("lovedScheduleIntervalHours") ? $("lovedScheduleIntervalHours").value : "24";
  const hours = Number(hoursRaw);
  return {
    target: lovedSyncTargetValue(),
    name: raw || "Last.fm Loved",
    scheduleEnabled: $("lovedScheduleEnabled") ? $("lovedScheduleEnabled").checked : false,
    intervalHours: hours === 6 || hours === 12 || hours === 24 ? hours : 24,
  };
}

function lovedSnapshotFromSettings(settings) {
  const src = settings || {};
  const hours = src.lovedScheduleIntervalHours;
  return {
    target: src.lovedSyncTarget === "playlist" ? "playlist" : "favorites",
    name: (src.lovedPlaylistName || "Last.fm Loved").trim() || "Last.fm Loved",
    scheduleEnabled: !!src.lovedScheduleEnabled,
    intervalHours: hours === 6 || hours === 12 || hours === 24 ? hours : 24,
  };
}

function writebackSnapshotFromForm() {
  return { enabled: $("lovedWritebackEnabled") ? $("lovedWritebackEnabled").checked : false };
}

function writebackSnapshotFromSettings(settings) {
  return { enabled: !!(settings && settings.lovedWritebackEnabled) };
}

function statsSnapshotFromForm() {
  return {
    hardCap: Number($("statsSyncHardCap") ? $("statsSyncHardCap").value : 500),
    scheduleEnabled: $("statsScheduleEnabled") ? $("statsScheduleEnabled").checked : false,
  };
}

function statsSnapshotFromSettings(settings) {
  const src = settings || {};
  return {
    hardCap: Number(src.statsSyncHardCap ?? src.hardCap ?? 500),
    scheduleEnabled: !!(src.statsScheduleEnabled),
  };
}

function sameSnap(a, b) {
  return ui.sameSnapshot ? ui.sameSnapshot(a, b) : JSON.stringify(a) === JSON.stringify(b);
}

function markDirty(section) {
  if (!savedSnap[section]) return;
  const form =
    section === "scrobble" ? scrobbleSnapshotFromForm()
    : section === "loved" ? lovedSnapshotFromForm()
    : section === "writeback" ? writebackSnapshotFromForm()
    : statsSnapshotFromForm();
  dirty[section] = !sameSnap(form, savedSnap[section]);
  const stateId = {
    scrobble: "scrobbleSaveState",
    loved: "lovedSaveState",
    writeback: "writebackSaveState",
    stats: "statsSaveState",
  }[section];
  if (dirty[section]) setSaveState(stateId, "dirty", "有未保存的更改");
  else setSaveState(stateId, "muted", "");
  if (section === "loved") {
    updateLovedModeHint();
    applyLovedExecState();
  }
  if (section === "stats") applyStatsControls();
  if (section === "writeback") applyWritebackFields(lastWritebackSettings || {});
}

function lovedSyncTargetValue() {
  const pl = $("lovedSyncTargetPlaylist");
  return pl && pl.checked ? "playlist" : "favorites";
}

function updateLovedTargetVisibility() {
  const wrap = $("lovedPlaylistNameWrap");
  if (wrap) wrap.classList.toggle("hidden", lovedSyncTargetValue() !== "playlist");
}

function applyLovedTargetFields(settings) {
  const src = settings || {};
  const target = src.lovedSyncTarget === "playlist" ? "playlist" : "favorites";
  if ($("lovedSyncTargetFavorites")) $("lovedSyncTargetFavorites").checked = target === "favorites";
  if ($("lovedSyncTargetPlaylist")) $("lovedSyncTargetPlaylist").checked = target === "playlist";
  if ($("lovedPlaylistName")) {
    $("lovedPlaylistName").value = src.lovedPlaylistName || "Last.fm Loved";
  }
  updateLovedTargetVisibility();
}

function currentLovedDestLabel() {
  const saved = savedSnap.loved;
  if (saved && saved.target === "playlist") {
    return "「" + (saved.name || "Last.fm Loved") + "」";
  }
  if (!saved && lovedSyncTargetValue() === "playlist") {
    const raw = $("lovedPlaylistName") ? $("lovedPlaylistName").value.trim() : "";
    return "「" + (raw || "Last.fm Loved") + "」";
  }
  return "「收藏」";
}

async function saveLovedSettings() {
  const snap = lovedSnapshotFromForm();
  const raw = $("lovedPlaylistName") ? $("lovedPlaylistName").value : "";
  await apiPost("/api/settings", {
    lovedSyncTarget: snap.target,
    lovedPlaylistName: raw,
    lovedScheduleEnabled: !!snap.scheduleEnabled,
    lovedScheduleIntervalHours: snap.intervalHours,
  });
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

function updateLovedModeHint() {
  const el = $("lovedSyncModeHint");
  if (!el || !ui.lovedModeHint) return;
  const saved = lastWritebackSettings || {};
  el.textContent = ui.lovedModeHint({
    savedWritebackEnabled: saved.lovedWritebackEnabled === true,
    savedTarget: saved.lovedSyncTarget === "playlist" ? "playlist" : "favorites",
    formTarget: lovedSyncTargetValue(),
    hostSupported: saved.playlistSongsChangeSupported !== false,
  });
}

function applyLovedExecState() {
  const connected = connectionState((lastStatus && lastStatus.status) || {}) === "connected";
  const gate = ui.canRunLovedSync
    ? ui.canRunLovedSync({
        connected: connected,
        dirty: dirty.loved,
        form: { target: lovedSyncTargetValue() },
      })
    : { ok: connected && !dirty.loved, reason: dirty.loved ? "请先保存同步设置" : (connected ? "" : "请先连接账号") };
  const btn = $("btnSyncLoved");
  if (btn) {
    btn.disabled = !gate.ok;
    btn.title = gate.ok ? "" : gate.reason;
  }
  const hint = $("lovedSyncDisabledHint");
  if (hint) {
    hint.textContent = gate.ok ? "" : gate.reason;
    hint.classList.toggle("hidden", gate.ok);
  }
}

function applyWritebackFields(settings) {
  const src = settings || {};
  const supported = src.playlistSongsChangeSupported !== false;
  const enabled = src.lovedWritebackEnabled === true;
  const view = ui.formatWritebackStatus
    ? ui.formatWritebackStatus({
        supported: supported,
        enabled: enabled,
        baselineAt: src.writebackBaselineAt,
        snapshotError: src.writebackSnapshotError,
        needsReconnect: !!src.needsReconnect,
        paused: !!(src.writebackQueuePaused || (src.needsReconnect && enabled)),
        deferBusy: src.writebackDeferReason === "busy",
        deferRetry: src.writebackDeferReason === "retry" || (src.writebackQueueSize > 0 && src.writebackDeferReason !== "busy"),
        lastResultOk: src.writebackLastResultOk,
        lastError: src.writebackLastError,
        truncated: !!(src.writebackSnapshotTruncated) || /起点不完整/.test(String(src.writebackStatusLine || "")),
      })
    : { line: src.writebackStatusLine || (enabled ? "已开启" : "未开启"), canEnable: supported, canDisable: true };

  const cb = $("lovedWritebackEnabled");
  if (cb && !dirty.writeback) cb.checked = enabled;
  if (cb) {
    // Unsupported host: cannot turn on; already-on can still be turned off.
    const formOn = cb.checked;
    cb.disabled = !supported && !formOn;
  }
  const hostHint = $("writebackHostHint");
  if (hostHint) {
    if (supported) hostHint.classList.add("hidden");
    else hostHint.classList.remove("hidden");
  }
  const offHint = $("writebackOffHint");
  if (offHint) offHint.style.display = supported ? "" : "none";
  const statusEl = $("writebackStatus");
  if (statusEl) statusEl.textContent = view.line;

  const diagHint = $("diagWritebackMergeHint");
  const savedTarget = src.lovedSyncTarget === "playlist" ? "playlist" : "favorites";
  const mergeMode = enabled && savedTarget === "favorites" && supported;
  if (diagHint) diagHint.style.display = mergeMode ? "" : "none";
  updateLovedModeHint();
}

async function saveWritebackSetting() {
  const enabled = $("lovedWritebackEnabled") ? $("lovedWritebackEnabled").checked : false;
  return apiPost("/api/settings", { lovedWritebackEnabled: !!enabled });
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

function updateStatsCapHint() {
  const hint = $("statsCapHint");
  if (!hint) return;
  const cap = savedSnap.stats && savedSnap.stats.hardCap ? savedSnap.stats.hardCap : 500;
  hint.textContent = "每次最多拉取 " + cap + " 条，仅补新记录。";
}

let statsPluginAvailable = false;
let statsNeedConnection = true;

function applyStatsControls() {
  const available = !!statsPluginAvailable;
  const hint = $("statsPluginHint");
  if (hint) {
    if (available) hint.classList.add("hidden");
    else hint.classList.remove("hidden");
  }
  const connected = !statsNeedConnection;
  const gate = ui.canRunStatsSync
    ? ui.canRunStatsSync({ available: available, connected: connected, dirty: dirty.stats })
    : { ok: available && connected && !dirty.stats, reason: "" };
  if ($("btnSyncStats")) {
    $("btnSyncStats").disabled = !gate.ok;
    $("btnSyncStats").title = gate.ok ? "" : gate.reason;
  }
  if ($("btnSyncStatsFull")) {
    $("btnSyncStatsFull").disabled = !gate.ok;
    $("btnSyncStatsFull").title = gate.ok ? "" : gate.reason;
  }
  const dis = $("statsSyncDisabledHint");
  if (dis) {
    dis.textContent = gate.ok ? "" : (gate.reason || "");
    dis.classList.toggle("hidden", gate.ok);
  }
  ["statsSyncHardCap", "btnSaveStatsSettings", "statsScheduleEnabled"].forEach((id) => {
    const el = $(id);
    if (el) el.disabled = !available;
  });
}

function renderLovedStatus(res) {
  const lastEl = $("lovedSyncLast");
  const outcomeEl = $("lovedSyncOutcome");
  const resultEl = $("lovedSyncResult");
  const nextEl = $("lovedSyncNext");
  const statusEl = $("lovedCurrentStatus");
  const view = ui.formatLovedOutcome ? ui.formatLovedOutcome(res && res.last) : null;
  if (lastEl) {
    lastEl.textContent = view && view.time ? ("上次同步：" + view.time) : "上次同步：尚未同步过";
  }
  if (outcomeEl) outcomeEl.textContent = view && view.outcome && view.time ? ("结果：" + view.outcome) : "";
  if (resultEl) resultEl.textContent = (view && view.stats) || "";
  const nextText = ui.scheduleNextLine
    ? ui.scheduleNextLine(res && res.schedule)
    : ((res && res.schedule && res.schedule.enabled) ? "下次同步：" + formatDateTime(res.schedule.nextDueAt) : "定时同步未开启");
  if (nextEl) nextEl.textContent = nextText;
  if (statusEl) {
    statusEl.textContent = ui.formatLovedCurrentTarget
      ? ui.formatLovedCurrentTarget(savedSnap.loved)
      : ("当前目标：" + (savedSnap.loved && savedSnap.loved.target === "playlist"
        ? ("自定义歌单「" + savedSnap.loved.name + "」")
        : "Songloft 收藏"));
  }
}

function renderStatsStatus(res) {
  const lastEl = $("statsSyncLast");
  const outcomeEl = $("statsSyncOutcome");
  const resultEl = $("statsSyncResult");
  const nextEl = $("statsSyncNext");
  const view = ui.formatStatsOutcome ? ui.formatStatsOutcome(res && res.last) : null;
  if (lastEl) {
    lastEl.textContent = view && view.time ? ("上次同步：" + view.time) : "上次同步：尚未同步过";
  }
  if (outcomeEl) outcomeEl.textContent = view && view.outcome && view.time ? ("结果：" + view.outcome) : "";
  if (resultEl) resultEl.textContent = (view && view.stats) || "";
  if (nextEl) {
    nextEl.textContent = ui.scheduleNextLine
      ? ui.scheduleNextLine(res && res.schedule)
      : "定时同步未开启";
  }
}

async function loadStatsSync() {
  const el = $("statsSyncLast");
  if (!el) return null;
  try {
    const res = await apiGet("/api/stats-sync");
    renderStatsStatus(res);
    if (!dirty.stats) {
      if (res.schedule) applyStatsScheduleFields({ ...res.schedule, hardCap: res.hardCap });
      if (typeof res.hardCap === "number" && $("statsSyncHardCap")) {
        $("statsSyncHardCap").value = String(res.hardCap);
      }
      savedSnap.stats = statsSnapshotFromSettings({
        statsSyncHardCap: res.hardCap,
        statsScheduleEnabled: res.schedule && res.schedule.enabled,
      });
    }
    statsPluginAvailable = typeof res.statsAvailable === "boolean" ? res.statsAvailable : false;
    updateStatsCapHint();
    applyStatsControls();
    return res;
  } catch (e) {
    el.textContent = "上次同步：无法读取（" + friendlyLogMessage(e.message) + "）";
    statsPluginAvailable = false;
    applyStatsControls();
    return null;
  }
}

async function loadLovedSync() {
  const el = $("lovedSyncLast");
  if (!el) return null;
  try {
    const res = await apiGet("/api/loved-playlist");
    if (!dirty.loved && res.schedule) applyLovedScheduleFields(res.schedule);
    renderLovedStatus(res);
    return res;
  } catch (e) {
    el.textContent = "上次同步：无法读取（" + friendlyLogMessage(e.message) + "）";
    if ($("lovedSyncNext")) $("lovedSyncNext").textContent = "定时同步未开启";
    return null;
  }
}

async function loadScrobbles() {
  const res = await apiGet("/api/scrobbles");
  renderScrobbles(res.records || []);
  return res;
}

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
    "已打开 Last.fm 授权页，请在网页点允许，回到这里即自动完成。" + link;
  $("connectPanel").classList.remove("hidden");
  $("connectPanel").scrollIntoView({ behavior: "smooth", block: "nearest" });
}

function hideWaiting() {
  stopPolling();
  $("connectWaiting").classList.add("hidden");
  authUrl = "";
  $("authHint").textContent = "";
}

function updateScrobbleFilterEmptyHint() {
  const hint = $("scrobbleFilterEmptyHint");
  if (!hint) return;
  const contentEmpty = !$("scrobbleLocal").checked && !$("scrobbleNetwork").checked;
  const playbackEmpty = !$("scrobbleSourceMiot").checked && !$("scrobbleSourceSongloft").checked;
  hint.classList.toggle("hidden", !(contentEmpty || playbackEmpty));
}

function applyScrobbleFilterDisabled(disabled) {
  ["scrobbleLocal", "scrobbleNetwork", "scrobbleSourceMiot", "scrobbleSourceSongloft"].forEach((id) => {
    if ($(id)) $(id).disabled = disabled;
  });
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
  applyScrobbleFilterDisabled(!connected);
  if ($("filterLoginHint")) $("filterLoginHint").classList.toggle("hidden", connected);
  if ($("section-scrobble-filter")) $("section-scrobble-filter").removeAttribute("aria-busy");
  $("minDurationSec").disabled = !connected;
  $("delayPercent").disabled = !connected;
  $("delayMaxSec").disabled = !connected;
  $("btnSave").disabled = !connected;

  $("connectPanel").classList.toggle("hidden", connected);
}

function applyScrobbleFields(settings) {
  if ($("scrobbleLocal")) $("scrobbleLocal").checked = settings.scrobbleLocal !== false;
  if ($("scrobbleNetwork")) $("scrobbleNetwork").checked = settings.scrobbleNetwork === true;
  const sources = Array.isArray(settings.scrobbleSources)
    ? settings.scrobbleSources
    : ["miot", "songloft-player"];
  if ($("scrobbleSourceMiot")) $("scrobbleSourceMiot").checked = sources.includes("miot");
  if ($("scrobbleSourceSongloft")) $("scrobbleSourceSongloft").checked = sources.includes("songloft-player");
  updateScrobbleFilterEmptyHint();
  $("enabled").checked = settings.enabled !== false;
  $("minDurationSec").value = settings.minDurationSec ?? 30;
  $("delayPercent").value = settings.delayPercent ?? 50;
  $("delayMaxSec").value = settings.delayMaxSec ?? 240;
}

async function refresh(opts) {
  const options = opts || {};
  const reset = options.reset || [];
  const shouldReset = (section) => reset.indexOf(section) !== -1 || reset.indexOf("all") !== -1;

  const st = await apiGet("/api/status");
  const settings = await apiGet("/api/settings");
  lastStatus = st;
  $("apiKey").value = "";
  $("apiKey").placeholder = settings.apiKeySet ? "已保存（留空不改）" : "填入 Last.fm API Key";
  if ($("apiSecret")) $("apiSecret").placeholder = settings.apiSecretSet ? "已保存（留空不改）" : "填入 Shared Secret";
  if ($("username")) $("username").value = settings.username || "";

  if (shouldReset("scrobble") || !dirty.scrobble) {
    applyScrobbleFields(settings);
    savedSnap.scrobble = scrobbleSnapshotFromSettings(settings);
    dirty.scrobble = false;
    if (shouldReset("scrobble")) setSaveState("scrobbleSaveState", options.saved === "scrobble" ? "saved" : "muted", options.saved === "scrobble" ? "已保存" : "");
  }

  if (shouldReset("loved") || !dirty.loved) {
    applyLovedTargetFields(settings);
    applyLovedScheduleFields(settings);
    savedSnap.loved = lovedSnapshotFromSettings(settings);
    dirty.loved = false;
    if (shouldReset("loved")) setSaveState("lovedSaveState", options.saved === "loved" ? "saved" : "muted", options.saved === "loved" ? "已保存" : "");
  }

  lastWritebackSettings = settings;
  if (shouldReset("writeback") || !dirty.writeback) {
    savedSnap.writeback = writebackSnapshotFromSettings(settings);
    dirty.writeback = false;
    if (shouldReset("writeback")) setSaveState("writebackSaveState", options.saved === "writeback" ? "saved" : "muted", options.saved === "writeback" ? "已保存" : "");
  }
  applyWritebackFields(settings);

  if (shouldReset("stats") || !dirty.stats) {
    applyStatsScheduleFields(settings);
    savedSnap.stats = statsSnapshotFromSettings(settings);
    dirty.stats = false;
    updateStatsCapHint();
    if (shouldReset("stats")) setSaveState("statsSaveState", options.saved === "stats" ? "saved" : "muted", options.saved === "stats" ? "已保存" : "");
  }

  applyConnectionUI(st, settings);
  updateLoveCurrent(st.lastPlay);

  const loveDisabled = connectionState((st && st.status) || {}) !== "connected";
  statsNeedConnection = loveDisabled;
  ["btnLove", "btnUnlove", "btnLoveProbe", "btnUnloveProbe", "btnLoveTest", "btnUnloveTest"].forEach((id) => {
    const b = $(id);
    if (b) b.disabled = loveDisabled;
  });
  if ($("lovedPlaylistName")) $("lovedPlaylistName").disabled = false;
  ["lovedSyncTargetFavorites", "lovedSyncTargetPlaylist", "lovedScheduleEnabled", "lovedScheduleIntervalHours", "btnSaveLovedSettings"].forEach((id) => {
    if ($(id)) $(id).disabled = false;
  });
  applyLovedExecState();
  applyStatsControls();

  if (options.flash) setFlash(options.flash, options.flashCls || "muted");

  const log = await apiGet("/api/log");
  $("logBox").textContent = (log.log || []).map((e) => {
    const t = formatDateTime(e.ts, true);
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
    scrobbleLocal: $("scrobbleLocal").checked,
    scrobbleNetwork: $("scrobbleNetwork").checked,
    scrobbleSources: [
      $("scrobbleSourceMiot").checked ? "miot" : null,
      $("scrobbleSourceSongloft").checked ? "songloft-player" : null,
    ].filter(Boolean),
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
      stopPolling();
      setFlash("仍在等待网页允许。允许后点「我已允许，完成连接」。", "warn");
      return;
    }
    try {
      await tryFinishWeb();
    } catch (_) {
      // not authorized yet
    }
  }, 3000);
}

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

if ($("btnReloadScrobbles")) {
  $("btnReloadScrobbles").onclick = () => loadScrobbles().catch((e) => setFlash(String(e), "err"));
}
if ($("btnReload2")) {
  $("btnReload2").onclick = () => refresh().catch((e) => setFlash(String(e), "err"));
}
if ($("btnRecentPreview")) $("btnRecentPreview").onclick = () => { recentView.mode = "preview"; renderScrobbles(); };
if ($("btnRecentAll")) $("btnRecentAll").onclick = () => { recentView.mode = "all"; renderScrobbles(); };
if ($("btnRecentFailed")) $("btnRecentFailed").onclick = () => { recentView.mode = "failed"; renderScrobbles(); };

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

[
  "enabled",
  "scrobbleLocal",
  "scrobbleNetwork",
  "scrobbleSourceMiot",
  "scrobbleSourceSongloft",
  "minDurationSec",
  "delayPercent",
  "delayMaxSec",
].forEach((id) => {
  const el = $(id);
  if (!el) return;
  el.addEventListener("change", () => {
    updateScrobbleFilterEmptyHint();
    markDirty("scrobble");
  });
  if (el.tagName === "INPUT" && (el.type === "number" || el.type === "text")) {
    el.addEventListener("input", () => markDirty("scrobble"));
  }
});

$("btnSave").onclick = async () => {
  try {
    await saveScrobble();
    await refresh({ flash: "播放记录设置已保存", flashCls: "ok", reset: ["scrobble"], saved: "scrobble" });
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
  if (!window.confirm("确定断开与 Last.fm 的连接？")) return;
  await apiPost("/api/logout", {});
  await refresh({ flash: "已断开连接", flashCls: "muted" });
};

$("btnNp").onclick = async () => {
  try {
    const res = await apiPost("/api/test/nowplaying", {});
    if (!res.ok) throw new Error(res.error || "failed");
    await refresh({ flash: "正在播放测试已发送", flashCls: "ok" });
  } catch (e) {
    setFlash("Now Playing 失败: " + friendlyLogMessage(e.message), "err");
    await refresh({ keepFlash: true }).catch(() => {});
  }
};

$("btnSc").onclick = async () => {
  try {
    const res = await apiPost("/api/test/scrobble", {});
    if (!res.ok) throw new Error(res.error || "failed");
    await refresh({ flash: "记播放测试已发送", flashCls: "ok" });
  } catch (e) {
    setFlash("记录播放失败: " + friendlyLogMessage(e.message), "err");
    await refresh({ keepFlash: true }).catch(() => {});
  }
};

$("btnLove").onclick = async () => {
  try {
    const res = await doLove("love");
    await refresh({ flash: "已标为喜欢：" + res.artist + " — " + res.title, flashCls: "ok" });
  } catch (e) {
    setFlash("标为喜欢失败: " + friendlyLogMessage(e.message), "err");
    await refresh({ keepFlash: true }).catch(() => {});
  }
};

$("btnUnlove").onclick = async () => {
  try {
    const res = await doLove("unlove");
    await refresh({ flash: "已取消喜欢：" + res.artist + " — " + res.title, flashCls: "ok" });
  } catch (e) {
    setFlash("取消喜欢失败: " + friendlyLogMessage(e.message), "err");
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
    const verb = kind === "love" ? "已标为喜欢" : "已取消喜欢";
    await refresh({ flash: verb + "：" + res.artist + " — " + res.title, flashCls: "ok" });
  } catch (e) {
    setFlash((kind === "love" ? "标为喜欢" : "取消喜欢") + "失败: " + friendlyLogMessage(e.message), "err");
    await refresh({ keepFlash: true }).catch(() => {});
  }
}

$("btnLoveProbe").onclick = () => loveProbe("love");
$("btnUnloveProbe").onclick = () => loveProbe("unlove");

["lovedSyncTargetFavorites", "lovedSyncTargetPlaylist", "lovedScheduleEnabled", "lovedScheduleIntervalHours", "lovedPlaylistName"].forEach((id) => {
  const el = $(id);
  if (!el) return;
  el.addEventListener("change", () => {
    updateLovedTargetVisibility();
    markDirty("loved");
  });
  if (el.tagName === "INPUT" && el.type === "text") {
    el.addEventListener("input", () => markDirty("loved"));
  }
});

if ($("btnSaveLovedSettings")) $("btnSaveLovedSettings").onclick = async () => {
  try {
    await saveLovedSettings();
    await refresh({ flash: "同步设置已保存", flashCls: "ok", reset: ["loved"], saved: "loved" });
  } catch (e) {
    setFlash("保存同步设置失败: " + friendlyLogMessage(e.message), "err");
    await refresh({ keepFlash: true }).catch(() => {});
  }
};

if ($("lovedWritebackEnabled")) {
  $("lovedWritebackEnabled").addEventListener("change", () => markDirty("writeback"));
}

if ($("btnSaveWriteback")) $("btnSaveWriteback").onclick = async () => {
  try {
    const res = await saveWritebackSetting();
    if (!res.ok) throw new Error(res.error || "保存失败");
    let flash = "写回设置已保存";
    let cls = "ok";
    if (res.lovedWritebackEnabled) {
      if (res.snapshotInitialized) {
        flash = res.writebackReopened
          ? "已重新记下当前喜欢。关闭期间的改动不会补写到 Last.fm。"
          : "已记下当前喜欢。之后在「收藏」里的改动会写回 Last.fm。";
      } else if (res.snapshotError) {
        flash =
          "开关已打开，但还没记下当前喜欢：" +
          res.snapshotError +
          "。记下之前即时写回可能不完整，可点上方「立即同步喜欢」再试（这次只记起点，不会改歌）。";
        cls = "warn";
      }
    }
    await refresh({ flash, flashCls: cls, reset: ["writeback"], saved: "writeback" });
  } catch (e) {
    setFlash("保存写回设置失败: " + friendlyLogMessage(e.message), "err");
    await refresh({ keepFlash: true }).catch(() => {});
  }
};

$("btnSyncLoved").onclick = async () => {
  const gate = ui.canRunLovedSync
    ? ui.canRunLovedSync({
        connected: connectionState((lastStatus && lastStatus.status) || {}) === "connected",
        dirty: dirty.loved,
        form: { target: lovedSyncTargetValue() },
      })
    : { ok: !dirty.loved, reason: "请先保存同步设置" };
  if (!gate.ok) {
    setFlash(gate.reason, "warn");
    return;
  }
  const btn = $("btnSyncLoved");
  btn.disabled = true;
  try {
    setFlash("正在同步 Last.fm 喜欢到" + currentLovedDestLabel() + "…", "muted");
    const res = await apiPost("/api/loved-playlist/sync", {});
    if (!res.ok) throw new Error(res.error || "同步失败");
    await refresh({
      flash: "喜欢已同步到" + currentLovedDestLabel() + (res.last ? "" : "：" + (res.summary || "")),
      flashCls: "ok",
    });
  } catch (e) {
    setFlash("喜欢同步失败: " + friendlyLogMessage(e.message), "err");
    await refresh({ keepFlash: true }).catch(() => {});
  }
};

$("btnLoveTest").onclick = async () => {
  try {
    const res = await apiPost("/api/test/love", {});
    if (!res.ok) throw new Error(res.error || "failed");
    await refresh({ flash: "喜欢测试已发送：" + res.artist + " — " + res.title, flashCls: "ok" });
  } catch (e) {
    setFlash("喜欢测试失败: " + friendlyLogMessage(e.message), "err");
    await refresh({ keepFlash: true }).catch(() => {});
  }
};

$("btnUnloveTest").onclick = async () => {
  try {
    const res = await apiPost("/api/test/unlove", {});
    if (!res.ok) throw new Error(res.error || "failed");
    await refresh({ flash: "取消喜欢测试已发送：" + res.artist + " — " + res.title, flashCls: "ok" });
  } catch (e) {
    setFlash("取消喜欢测试失败: " + friendlyLogMessage(e.message), "err");
    await refresh({ keepFlash: true }).catch(() => {});
  }
};

document.addEventListener("DOMContentLoaded", () => {
  refresh().catch((e) => setFlash(String(e), "err"));
});

if ($("statsSyncHardCap")) {
  $("statsSyncHardCap").addEventListener("input", () => markDirty("stats"));
  $("statsSyncHardCap").addEventListener("change", () => markDirty("stats"));
}
if ($("statsScheduleEnabled")) {
  $("statsScheduleEnabled").addEventListener("change", () => markDirty("stats"));
}

$("btnSaveStatsSettings") && ($("btnSaveStatsSettings").onclick = async () => {
  try {
    const raw = $("statsSyncHardCap") ? $("statsSyncHardCap").value : "500";
    const enabled = $("statsScheduleEnabled") ? $("statsScheduleEnabled").checked : false;
    await apiPost("/api/settings", {
      statsSyncHardCap: Number(raw),
      statsScheduleEnabled: !!enabled,
      statsScheduleIntervalHours: 24,
    });
    await refresh({ flash: "统计设置已保存", flashCls: "ok", reset: ["stats"], saved: "stats" });
  } catch (e) {
    setFlash("保存统计设置失败: " + friendlyLogMessage(e.message), "err");
  }
});

$("btnSyncStats") && ($("btnSyncStats").onclick = async () => {
  const gate = ui.canRunStatsSync
    ? ui.canRunStatsSync({ available: statsPluginAvailable, connected: !statsNeedConnection, dirty: dirty.stats })
    : { ok: !dirty.stats, reason: "请先保存统计设置" };
  if (!gate.ok) {
    setFlash(gate.reason, "warn");
    return;
  }
  const btn = $("btnSyncStats");
  if (btn) btn.disabled = true;
  const fullBtn = $("btnSyncStatsFull");
  if (fullBtn) fullBtn.disabled = true;
  try {
    setFlash("正在同步 Last.fm → 播放统计…", "muted");
    const res = await apiPost("/api/stats-sync", {});
    if (!res || res.ok === false) {
      throw new Error((res && (res.error || res.summary)) || "同步失败");
    }
    await refresh({
      flash: "播放统计已同步",
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
  const gate = ui.canRunStatsSync
    ? ui.canRunStatsSync({ available: statsPluginAvailable, connected: !statsNeedConnection, dirty: dirty.stats })
    : { ok: !dirty.stats, reason: "请先保存统计设置" };
  if (!gate.ok) {
    setFlash(gate.reason, "warn");
    return;
  }
  const btn = $("btnSyncStats");
  if (btn) btn.disabled = true;
  const fullBtn = $("btnSyncStatsFull");
  if (fullBtn) fullBtn.disabled = true;
  try {
    setFlash("尽量同步已开始…", "muted");
    const res = await apiPost("/api/stats-sync", { mode: "full" });
    if (res && res.accepted) {
      const prevTs = res.last && res.last.ts;
      let outcome = "";
      let finalSummary = res.summary || "";
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
          if (i > 2) {
            outcome = "skipped";
            break;
          }
        }
        setFlash("尽量同步进行中… (" + ((i + 1) * 2) + "s)", "muted");
      }
      if (outcome === "ok") {
        await refresh({ flash: "尽量同步完成", flashCls: "ok" });
      } else if (outcome === "fail") {
        await refresh({ flash: "尽量同步失败：" + finalSummary, flashCls: "err" });
      } else if (outcome === "skipped") {
        await refresh({ flash: "尽量同步未执行（忙或已跳过）：" + finalSummary, flashCls: "err" });
      } else {
        await refresh({ flash: "尽量同步仍在进行或超时，请稍后查看最近记录：" + finalSummary, flashCls: "muted" });
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
