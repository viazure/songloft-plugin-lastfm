import type { HTTPRequest, HTTPResponse } from "@songloft/plugin-sdk";
import { handleHTTP } from "./router";
import { refreshScrobbler, subscribePlayEvents, unsubscribePlayEvents } from "./engine";
import { ensureHostKeepAlive } from "./keepalive";
import { lovedScheduler } from "./loved-schedule";
import { bindLovedScheduleTick } from "./loved-sync-run";
import { statsScheduler } from "./stats-schedule";
import { bindStatsScheduleTick } from "./stats-sync-run";
import {
  hostPlaylistSongsChangeSupported,
  syncWritebackSubscription,
} from "./writeback-service";
import {
  loadLovedSchedule,
  loadSettings,
  loadStatsSchedule,
  publicStatus,
  saveLovedSchedule,
  saveStatsSchedule,
} from "./store";

async function onInit(): Promise<void> {
  const settings = await loadSettings();
  const status = publicStatus(settings);
  await refreshScrobbler();
  subscribePlayEvents();

  // Loved schedule: plugin-local timer only (not keep-alive / miot cron).
  lovedScheduler.setPersist(async (st) => {
    await saveLovedSchedule(st);
  });
  bindLovedScheduleTick();
  const savedSchedule = await loadLovedSchedule();
  await lovedScheduler.applyState(savedSchedule, { rearm: true, persist: false });
  if (savedSchedule.enabled) {
    songloft.log.info(
      `[lastfm] loved schedule armed: every ${savedSchedule.intervalHours}h; nextDue=${
        savedSchedule.nextDueAt ? new Date(savedSchedule.nextDueAt).toISOString() : "(pending)"
      }`
    );
  }

  // Stats sync schedule: independent timer; exclusive lock shared with Loved.
  statsScheduler.setPersist(async (st) => {
    await saveStatsSchedule(st);
  });
  bindStatsScheduleTick();
  const savedStatsSchedule = await loadStatsSchedule();
  await statsScheduler.applyState(savedStatsSchedule, { rearm: true, persist: false });
  if (savedStatsSchedule.enabled) {
    songloft.log.info(
      `[lastfm] stats schedule armed: every ${savedStatsSchedule.intervalHours}h; nextDue=${
        savedStatsSchedule.nextDueAt
          ? new Date(savedStatsSchedule.nextDueAt).toISOString()
          : "(pending)"
      }`
    );
  }

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

  // 收藏事件订阅：空闲唤醒后必须恢复；旧宿主缺接口时只提示，不抛。
  if (settings.lovedWritebackEnabled) {
    if (!hostPlaylistSongsChangeSupported()) {
      songloft.log.warn(
        "[lastfm] 收藏写回已开启，但当前 Songloft 版本还不支持即时写回，请升级 Songloft"
      );
    } else {
      const sub = await syncWritebackSubscription();
      if (!sub.subscribed) {
        songloft.log.warn("[lastfm] 收藏写回订阅失败，稍后保存设置时重试");
      }
    }
  }
}

async function onDeinit(): Promise<void> {
  lovedScheduler.dispose();
  statsScheduler.dispose();
  unsubscribePlayEvents();
  songloft.log.info("[lastfm] stopped");
}

async function onHTTPRequest(req: HTTPRequest): Promise<HTTPResponse> {
  return await handleHTTP(req);
}

globalThis.onInit = onInit;
globalThis.onDeinit = onDeinit;
globalThis.onHTTPRequest = onHTTPRequest;
