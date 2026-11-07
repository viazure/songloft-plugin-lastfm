import type { HTTPRequest, HTTPResponse } from "@songloft/plugin-sdk";
import { handleHTTP } from "./router";
import { refreshScrobbler, subscribePlayEvents, unsubscribePlayEvents } from "./engine";
import { ensureHostKeepAlive } from "./keepalive";
import { loadSettings, publicStatus } from "./store";

async function onInit(): Promise<void> {
  const settings = await loadSettings();
  const status = publicStatus(settings);
  await refreshScrobbler();
  subscribePlayEvents();

  // Prevent idle unload from dropping play-event subscription (scrobble gaps).
  // Host does not wake onPlayEvent subscribers; keep-alive whitelist is the fix.
  const ka = await ensureHostKeepAlive();
  if (ka.ok) {
    songloft.log.info(
      ka.already
        ? `[lastfm] host keep-alive ok (already listed): ${ka.plugins.join(",")}`
        : `[lastfm] host keep-alive registered: ${ka.plugins.join(",")}`
    );
  } else {
    songloft.log.warn(
      `[lastfm] keep-alive self-register failed (${ka.reason}); ` +
        `add "lastfm" under Settings → plugin-keep-alive or scrobbles may miss after idle unload`
    );
  }

  if (!status.configured) {
    songloft.log.warn("[lastfm] 未配置应用凭证 — 插件已启用但不会同步");
  } else if (status.needsReconnect) {
    songloft.log.warn("[lastfm] 连接已失效 — 打开设置页重新连接账号");
  } else if (!status.authorized) {
    songloft.log.warn("[lastfm] 已有应用凭证但未连接账号 — 打开设置页连接");
  } else {
    songloft.log.info(`[lastfm] ready as ${settings.username || "(session)"}`);
  }
}

async function onDeinit(): Promise<void> {
  unsubscribePlayEvents();
  songloft.log.info("[lastfm] stopped");
}

async function onHTTPRequest(req: HTTPRequest): Promise<HTTPResponse> {
  return await handleHTTP(req);
}

globalThis.onInit = onInit;
globalThis.onDeinit = onDeinit;
globalThis.onHTTPRequest = onHTTPRequest;
