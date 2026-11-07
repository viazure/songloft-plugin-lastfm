import { createRouter, jsonResponse } from "@songloft/plugin-sdk";
import type { HTTPRequest, HTTPResponse } from "@songloft/plugin-sdk";
import { LastFmScrobbler } from "./scrobbler";
import { refreshScrobbler, getScrobbler } from "./engine";
import {
  appendLog,
  appendScrobbleRecord,
  clearSession,
  friendlyLastFmError,
  isInvalidSessionError,
  loadLog,
  loadScrobbleRecords,
  loadSettings,
  markSessionInvalid,
  publicStatus,
  saveSettings,
} from "./store";

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

export async function handleHTTP(req: HTTPRequest): Promise<HTTPResponse> {
  return await router.handle(req);
}