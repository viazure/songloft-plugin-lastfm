import { createRouter, jsonResponse } from "@songloft/plugin-sdk";
import type { HTTPRequest, HTTPResponse } from "@songloft/plugin-sdk";
import { LastFmScrobbler } from "./scrobbler";
import { refreshScrobbler, getScrobbler, getLastPlayCache } from "./engine";
import {
  appendLog,
  appendScrobbleRecord,
  clearSession,
  friendlyLastFmError,
  isInvalidSessionError,
  loadLog,
  loadLovedPlaylistSync,
  loadScrobbleRecords,
  loadSettings,
  markSessionInvalid,
  publicStatus,
  saveLovedPlaylistSync,
  saveSettings,
} from "./store";
import {
  resolveLovedPlaylistName, formatLovedSyncSummary, syncLovedToPlaylist } from "./loved-playlist";

const router = createRouter();

function readJson(req: HTTPRequest): Record<string, unknown> {
  const body = req.body;
  if (!body) return {};
  if (typeof body === "object") return body as Record<string, unknown>;
  if (typeof body === "string") {
    try {
      return JSON.parse(body) as Record<string, unknown>;
    } catch {
      return {};
    }
  }
  return {};
}

function statusMessage(settings: Awaited<ReturnType<typeof loadSettings>>): string {
  if (!settings.apiKey || !settings.apiSecret) {
    return "请先在「应用凭证（高级）」填写 API Key 与 Shared Secret";
  }
  if (!settings.sessionKey && settings.needsReconnect) {
    return "连接已失效，请重新连接账号";
  }
  if (!settings.sessionKey) {
    return "尚未连接账号";
  }
  return "已连接，可同步播放";
}

router.get("/api/status", async () => {
  const settings = await loadSettings();
  return jsonResponse({
    ok: true,
    status: publicStatus(settings),
    message: statusMessage(settings),
    lastPlay: getLastPlayCache(),
  });
});

router.get("/api/settings", async () => {
  const settings = await loadSettings();
  return jsonResponse({
    // never echo apiKey/secret/session in clear — only set flags
    apiKeySet: !!settings.apiKey,
    apiSecretSet: !!settings.apiSecret,
    sessionKeySet: !!settings.sessionKey,
    username: settings.username,
    onlyMiot: settings.onlyMiot,
    enabled: settings.enabled,
    needsReconnect: settings.needsReconnect === true,
    minDurationSec: settings.minDurationSec,
    delayPercent: settings.delayPercent,
    delayMaxSec: settings.delayMaxSec,
    lovedPlaylistName: resolveLovedPlaylistName(settings.lovedPlaylistName),
    status: publicStatus(settings),
  });
});

router.post("/api/settings", async (req) => {
  const body = readJson(req);
  const cur = await loadSettings();
  const patch: Record<string, unknown> = {};
  if (typeof body.apiKey === "string" && body.apiKey.trim()) {
    patch.apiKey = body.apiKey.trim();
  }
  if (typeof body.apiSecret === "string" && body.apiSecret.trim()) {
    patch.apiSecret = body.apiSecret.trim();
  }
  if (typeof body.sessionKey === "string") {
    // allow pasting an existing session from form / parent agent
    patch.sessionKey = body.sessionKey.trim();
  }
  if (typeof body.username === "string") patch.username = body.username.trim();
  if (typeof body.onlyMiot === "boolean") patch.onlyMiot = body.onlyMiot;
  if (typeof body.enabled === "boolean") patch.enabled = body.enabled;
  if (typeof body.minDurationSec === "number" || typeof body.minDurationSec === "string") {
    const n = Number(body.minDurationSec);
    if (Number.isFinite(n)) patch.minDurationSec = n;
  }
  if (typeof body.delayPercent === "number" || typeof body.delayPercent === "string") {
    const n = Number(body.delayPercent);
    if (Number.isFinite(n)) patch.delayPercent = n;
  }
  if (typeof body.delayMaxSec === "number" || typeof body.delayMaxSec === "string") {
    const n = Number(body.delayMaxSec);
    if (Number.isFinite(n)) patch.delayMaxSec = n;
  }
  if (typeof body.lovedPlaylistName === "string") {
    // Persist raw (may be blank); resolve at sync/read time so empty → default.
    patch.lovedPlaylistName = body.lovedPlaylistName;
  }
  const nextKey = typeof patch.apiKey === "string" ? (patch.apiKey as string) : cur.apiKey;
  const nextSecret =
    typeof patch.apiSecret === "string" ? (patch.apiSecret as string) : cur.apiSecret;
  const keyChanged = typeof patch.apiKey === "string" && nextKey !== cur.apiKey;
  const secretChanged = typeof patch.apiSecret === "string" && nextSecret !== cur.apiSecret;
  const pastingSession =
    typeof patch.sessionKey === "string" && (patch.sessionKey as string).length > 0;

  let sessionInvalidated = false;
  if ((keyChanged || secretChanged) && !pastingSession) {
    // Saving new App credentials invalidates the old user session.
    patch.sessionKey = "";
    patch.pendingToken = "";
    patch.needsReconnect = true;
    sessionInvalidated = !!(cur.sessionKey || cur.needsReconnect || cur.username);
  }

  // Explicit session paste counts as connected.
  if (pastingSession) {
    patch.needsReconnect = false;
  }

  const settings = await saveSettings(patch as any);
  await refreshScrobbler();
  await appendLog(
    "info",
    sessionInvalidated ? "settings saved (session cleared; reconnect required)" : "settings saved"
  );
  return jsonResponse({
    ok: true,
    status: publicStatus(settings),
    sessionInvalidated,
    message: statusMessage(settings),
  });
});

router.post("/api/login", async (req) => {
  const body = readJson(req);
  const username = typeof body.username === "string" ? body.username.trim() : "";
  const password = typeof body.password === "string" ? body.password : "";
  if (!username || !password) {
    return jsonResponse({ ok: false, error: "需要用户名与密码" }, 400);
  }
  const settings = await loadSettings();
  if (!settings.apiKey || !settings.apiSecret) {
    return jsonResponse({ ok: false, error: "请先保存应用凭证（API Key / Secret）" }, 400);
  }
  const client = new LastFmScrobbler({
    apiKey: settings.apiKey,
    apiSecret: settings.apiSecret,
  });
  try {
    const session = await client.getMobileSession(username, password);
    const next = await saveSettings({
      sessionKey: session.key,
      username: session.name,
      pendingToken: "",
      needsReconnect: false,
    });
    await refreshScrobbler();
    await appendLog("info", `connected as ${session.name}`);
    return jsonResponse({ ok: true, username: session.name, status: publicStatus(next) });
  } catch (e) {
    const msg = friendlyLastFmError(e);
    await appendLog("error", `login failed: ${msg}`);
    return jsonResponse({ ok: false, error: msg }, 400);
  }
});

router.post("/api/auth/web/start", async () => {
  const settings = await loadSettings();
  if (!settings.apiKey || !settings.apiSecret) {
    return jsonResponse({ ok: false, error: "请先保存应用凭证（API Key / Secret）" }, 400);
  }
  const client = new LastFmScrobbler({
    apiKey: settings.apiKey,
    apiSecret: settings.apiSecret,
  });
  try {
    const token = await client.getToken();
    await saveSettings({ pendingToken: token });
    const url = client.authUrl(token);
    return jsonResponse({ ok: true, token, url });
  } catch (e) {
    return jsonResponse({ ok: false, error: friendlyLastFmError(e) }, 400);
  }
});

router.post("/api/auth/web/finish", async () => {
  const settings = await loadSettings();
  if (!settings.apiKey || !settings.apiSecret || !settings.pendingToken) {
    return jsonResponse({ ok: false, error: "没有进行中的网页连接，请先点「连接账号」" }, 400);
  }
  const client = new LastFmScrobbler({
    apiKey: settings.apiKey,
    apiSecret: settings.apiSecret,
  });
  try {
    const session = await client.getSession(settings.pendingToken);
    const next = await saveSettings({
      sessionKey: session.key,
      username: session.name,
      pendingToken: "",
      needsReconnect: false,
    });
    await refreshScrobbler();
    await appendLog("info", `web-connected as ${session.name}`);
    return jsonResponse({ ok: true, username: session.name, status: publicStatus(next) });
  } catch (e) {
    const msg = friendlyLastFmError(e);
    await appendLog("error", `web connect finish failed: ${msg}`);
    return jsonResponse({ ok: false, error: msg }, 400);
  }
});

router.post("/api/logout", async () => {
  const next = await clearSession();
  await refreshScrobbler();
  await appendLog("info", "disconnected");
  return jsonResponse({ ok: true, status: publicStatus(next), message: statusMessage(next) });
});

router.get("/api/log", async () => {
  const log = await loadLog();
  return jsonResponse({ ok: true, log });
});

/** Recent structured scrobble attempts (newest last; UI may reverse). */
router.get("/api/scrobbles", async () => {
  const records = await loadScrobbleRecords();
  return jsonResponse({ ok: true, records, max: 20 });
});

/** Manual dry-run helpers for when speaker play events are not used yet. */
router.post("/api/test/nowplaying", async (req) => {
  const body = readJson(req);
  const artist = typeof body.artist === "string" ? body.artist : "Songloft Test";
  const title = typeof body.title === "string" ? body.title : "Now Playing Probe";
  await refreshScrobbler();
  const client = getScrobbler();
  if (!client || !(await client.isReady())) {
    return jsonResponse({ ok: false, error: "尚未连接账号：需要应用凭证 + 已连接的账号" }, 400);
  }
  try {
    await client.updateNowPlaying({
      artist,
      title,
      startedAtSec: Math.floor(Date.now() / 1000),
    });
    await appendLog("info", `test nowplaying: ${artist} - ${title}`);
    return jsonResponse({ ok: true });
  } catch (e) {
    if (isInvalidSessionError(e)) {
      await markSessionInvalid();
      await refreshScrobbler();
    }
    const msg = friendlyLastFmError(e);
    await appendLog("error", `test nowplaying failed: ${msg}`);
    return jsonResponse({ ok: false, error: msg }, 400);
  }
});

router.post("/api/test/scrobble", async (req) => {
  const body = readJson(req);
  const artist = typeof body.artist === "string" ? body.artist : "Songloft Test";
  const title = typeof body.title === "string" ? body.title : "Scrobble Probe";
  await refreshScrobbler();
  const client = getScrobbler();
  if (!client || !(await client.isReady())) {
    return jsonResponse({ ok: false, error: "尚未连接账号：需要应用凭证 + 已连接的账号" }, 400);
  }
  try {
    await client.scrobble({
      artist,
      title,
      startedAtSec: Math.floor(Date.now() / 1000) - 60,
    });
    await appendScrobbleRecord({ title, artist, ok: true, path: "test", source: "test" });
    await appendLog("info", `test scrobble: ${artist} - ${title}`);
    return jsonResponse({ ok: true });
  } catch (e) {
    if (isInvalidSessionError(e)) {
      await markSessionInvalid();
      await refreshScrobbler();
    }
    const msg = friendlyLastFmError(e);
    await appendScrobbleRecord({ title, artist, ok: false, reason: msg, path: "test", source: "test" });
    await appendLog("error", `test scrobble failed: ${msg}`);
    return jsonResponse({ ok: false, error: msg }, 400);
  }
});

/** Resolve artist/title: body override, else last play cache. */
function resolveTrack(body: Record<string, unknown>): { artist: string; title: string } | { error: string } {
  const bodyArtist = typeof body.artist === "string" ? body.artist.trim() : "";
  const bodyTitle = typeof body.title === "string" ? body.title.trim() : "";
  if (bodyArtist && bodyTitle) {
    return { artist: bodyArtist, title: bodyTitle };
  }
  const cached = getLastPlayCache();
  if (cached?.artist && cached?.title) {
    return { artist: cached.artist, title: cached.title };
  }
  return { error: "没有当前曲：先听一首歌，或在请求里带上 artist 与 title" };
}

/**
 * Manual love/unlove — independent of onlyMiot / early scrobble / flush / keep-alive.
 * Explicit user action; does not require settings.enabled.
 */
async function handleLoveAction(
  req: HTTPRequest,
  kind: "love" | "unlove"
): Promise<HTTPResponse> {
  const body = readJson(req);
  const track = resolveTrack(body);
  if ("error" in track) {
    return jsonResponse({ ok: false, error: track.error }, 400);
  }
  const { artist, title } = track;
  await refreshScrobbler();
  const client = getScrobbler();
  if (!client || !(await client.isReady())) {
    await appendScrobbleRecord({
      title,
      artist,
      ok: false,
      reason: "尚未连接账号",
      path: kind,
      source: "manual",
    });
    return jsonResponse({ ok: false, error: "尚未连接账号：需要应用凭证 + 已连接的账号" }, 400);
  }
  try {
    if (kind === "love") {
      await client.love(artist, title);
    } else {
      await client.unlove(artist, title);
    }
    await appendScrobbleRecord({
      title,
      artist,
      ok: true,
      path: kind,
      source: "manual",
    });
    await appendLog("info", `${kind}: ${artist} - ${title}`);
    return jsonResponse({ ok: true, artist, title, action: kind });
  } catch (e) {
    if (isInvalidSessionError(e)) {
      await markSessionInvalid();
      await refreshScrobbler();
    }
    const msg = friendlyLastFmError(e);
    await appendScrobbleRecord({
      title,
      artist,
      ok: false,
      reason: msg,
      path: kind,
      source: "manual",
    });
    await appendLog("error", `${kind} failed: ${msg}`);
    return jsonResponse({ ok: false, error: msg, artist, title, action: kind }, 400);
  }
}

router.post("/api/love", async (req) => handleLoveAction(req, "love"));
router.post("/api/unlove", async (req) => handleLoveAction(req, "unlove"));

/** Manual probe with explicit artist/title (defaults like other test endpoints). */
router.post("/api/test/love", async (req) => {
  const body = readJson(req);
  const artist =
    typeof body.artist === "string" && body.artist.trim()
      ? body.artist.trim()
      : "Songloft Test";
  const title =
    typeof body.title === "string" && body.title.trim()
      ? body.title.trim()
      : "Love Probe";
  return handleLoveAction(
    { ...req, body: { ...body, artist, title } } as HTTPRequest,
    "love"
  );
});

router.post("/api/test/unlove", async (req) => {
  const body = readJson(req);
  const artist =
    typeof body.artist === "string" && body.artist.trim()
      ? body.artist.trim()
      : "Songloft Test";
  const title =
    typeof body.title === "string" && body.title.trim()
      ? body.title.trim()
      : "Love Probe";
  return handleLoveAction(
    { ...req, body: { ...body, artist, title } } as HTTPRequest,
    "unlove"
  );
});


/** Last loved→playlist sync summary for settings page. */
router.get("/api/loved-playlist", async () => {
  const last = await loadLovedPlaylistSync();
  return jsonResponse({
    ok: true,
    last,
    summary: formatLovedSyncSummary(last),
  });
});

/**
 * Sync Last.fm loved tracks into Songloft playlist (configurable name; default Last.fm Loved).
 * Explicit user action — not gated by onlyMiot; isolated from scrobble/flush/keep-alive.
 */
router.post("/api/loved-playlist/sync", async () => {
  await refreshScrobbler();
  const settings = await loadSettings();
  const client = getScrobbler();
  if (!client || !(await client.isReady()) || !settings.username) {
    const reason = !settings.username
      ? "尚未连接账号（缺少用户名）"
      : "尚未连接账号：需要应用凭证 + 已连接的账号";
    const fail = {
      ts: Date.now(),
      ok: false as const,
      loved: 0,
      matched: 0,
      unmatched: 0,
      reason,
    };
    await saveLovedPlaylistSync(fail);
    await appendScrobbleRecord({
      title: resolveLovedPlaylistName(settings.lovedPlaylistName),
      artist: "playlist",
      ok: false,
      reason,
      path: "loved_playlist_sync",
      source: "manual",
    });
    return jsonResponse({ ok: false, error: reason, last: fail, summary: formatLovedSyncSummary(fail) }, 400);
  }

  // songloft.songs / songloft.playlists are host bridge APIs (need playlists.* perms).
  const previous = await loadLovedPlaylistSync();
  const playlistName = resolveLovedPlaylistName(settings.lovedPlaylistName);
  const result = await syncLovedToPlaylist({
    scrobbler: client,
    username: settings.username,
    songsApi: songloft.songs,
    playlistsApi: songloft.playlists,
    playlistName,
    previousPlaylistName: previous?.playlistName || null,
  });

  if (!result.ok) {
    if (isInvalidSessionError(result.reason)) {
      await markSessionInvalid();
      await refreshScrobbler();
    }
    const reason = friendlyLastFmError(result.reason);
    const stored = await saveLovedPlaylistSync({ ...result, reason });
    await appendScrobbleRecord({
      title: resolveLovedPlaylistName(settings.lovedPlaylistName),
      artist: "playlist",
      ok: false,
      reason,
      path: "loved_playlist_sync",
      source: "manual",
    });
    await appendLog("error", `loved playlist sync failed: ${reason}`);
    return jsonResponse(
      { ok: false, error: reason, last: stored, summary: formatLovedSyncSummary(stored) },
      400
    );
  }

  const summaryBits = `loved ${result.loved} · 命中 ${result.matched} · 未命中 ${result.unmatched}`;
  const truncNote = result.truncated ? " · truncated@1000" : "";
  const idNote = result.playlistIdChanged ? " · playlist id changed" : "";
  const targetNote = result.targetChanged ? " · 目标歌单已变" : "";
  const stored = await saveLovedPlaylistSync({
    ts: result.ts,
    ok: true,
    loved: result.loved,
    matched: result.matched,
    unmatched: result.unmatched,
    truncated: result.truncated,
    playlistId: result.playlistId,
    playlistIdChanged: result.playlistIdChanged,
    unmatchedSamples: result.unmatchedSamples,
    playlistName: result.playlistName,
    reason: summaryBits + truncNote + idNote + targetNote,
  });
  await appendScrobbleRecord({
    title: result.playlistName,
    artist: "playlist",
    ok: true,
    reason: summaryBits + truncNote + targetNote,
    path: "loved_playlist_sync",
    source: "manual",
  });
  if (result.unmatchedSamples?.length) {
    const sample = result.unmatchedSamples
      .slice(0, 5)
      .map((s) => `${s.artist} - ${s.title}`)
      .join("; ");
    await appendLog("info", `loved playlist unmatched sample: ${sample}`);
  }
  await appendLog(
    "info",
    `loved playlist sync ok: ${summaryBits}${truncNote} id=${result.playlistId}`
  );
  return jsonResponse({
    ok: true,
    last: stored,
    summary: formatLovedSyncSummary(stored),
    playlistId: result.playlistId,
    created: result.created,
    playlistIdChanged: result.playlistIdChanged,
    truncated: result.truncated,
    unmatchedSamples: result.unmatchedSamples,
  });
});
export async function handleHTTP(req: HTTPRequest): Promise<HTTPResponse> {
  return await router.handle(req);
}

