/**
 * 写回服务的宿主接线（单例）。测试直接构造 WritebackService，不经过这里。
 */

import { getScrobbler, refreshScrobbler } from "./engine";
import { lovedScheduler } from "./loved-schedule";
import { LOVED_HARD_CAP } from "./loved-playlist";
import {
  appendLog,
  appendScrobbleRecord,
  friendlyLastFmError,
  isInvalidSessionError,
  loadSettings,
  loadWritebackSnapshot,
  markSessionInvalid,
  saveWritebackMeta,
  saveWritebackSnapshot,
  loadWritebackMeta,
} from "./store";
import { favoritesEchoSuppressor } from "./echo";
import { WritebackService } from "./writeback-run";
import { HOST_EVENT_SUPPORT_HINT, isPlaylistSongsChangeSupported } from "./writeback";
export { EchoSuppressor } from "./echo";

let service: WritebackService | null = null;
let attached = false;

function build(): WritebackService {
  return new WritebackService({
    events: (songloft as unknown as { events?: unknown }).events,
    playlists: songloft.playlists as never,
    library: songloft.songs as never,
    store: {
      load: loadWritebackSnapshot,
      save: saveWritebackSnapshot,
    },
    getWriteApi: async () => {
      const client = await refreshScrobbler();
      if (!client || !(await client.isReady())) return null;
      return {
        love: (artist, title) => client.love(artist, title),
        unlove: (artist, title) => client.unlove(artist, title),
      };
    },
    withLock: (fn) => lovedScheduler.runExclusive(fn),
    onInvalidSession: async () => {
      await markSessionInvalid();
      await refreshScrobbler();
      const meta = await loadWritebackMeta();
      await saveWritebackMeta({
        ...meta,
        lastError: "连接已失效，请重新连接账号",
        paused: true,
      });
    },
    log: (level, message) => {
      songloft.log[level](`[lastfm] ${message}`);
    },
    onWritebackRecord: async (job, ok, reason) => {
      const friendly = reason ? friendlyLastFmError(reason) : undefined;
      await appendLog(
        ok ? "info" : "error",
        `${job.action} (收藏写回): ${job.artist} - ${job.title}${friendly ? " · " + friendly : ""}`
      );
      await appendScrobbleRecord({
        title: job.title,
        artist: job.artist,
        ok,
        reason: friendly,
        path: "loved_writeback",
        source: "writeback",
      });
      if (!ok && friendly) {
        const meta = await loadWritebackMeta();
        await saveWritebackMeta({ ...meta, lastError: friendly, lastResultOk: false });
      } else if (ok) {
        const meta = await loadWritebackMeta();
        await saveWritebackMeta({ ...meta, lastError: "", lastResultOk: true });
      }
    },
    suppressor: favoritesEchoSuppressor,
  });
}

export function getWritebackService(): WritebackService {
  if (!service) service = build();
  return service;
}

/** 开关关闭或宿主没有事件 API 时取消/不订阅；不抛异常到生命周期。 */
export async function syncWritebackSubscription(): Promise<{
  supported: boolean;
  subscribed: boolean;
}> {
  const supported = isPlaylistSongsChangeSupported(
    (songloft as unknown as { events?: unknown }).events
  );
  if (!supported) {
    if (attached) {
      try {
        await getWritebackService().detachEvents();
      } catch {
        /* ignore */
      }
      attached = false;
    }
    return { supported: false, subscribed: false };
  }
  const settings = await loadSettings();
  const snapshot = await loadWritebackSnapshot();
  // 开关可开着并提示，但完整起点落地前不订阅，避免残缺/无起点时入队写回。
  if (!settings.lovedWritebackEnabled || !snapshot) {
    if (attached) {
      try {
        await getWritebackService().detachEvents();
      } catch {
        /* ignore */
      }
      attached = false;
    }
    return { supported: true, subscribed: false };
  }
  if (attached) return { supported: true, subscribed: true };
  const ok = await getWritebackService().attachEvents();
  attached = ok;
  if (ok) songloft.log.info("[lastfm] favorites write-back subscribed");
  else songloft.log.warn(`[lastfm] ${HOST_EVENT_SUPPORT_HINT}`);
  return { supported, subscribed: ok };
}

/** 宿主能力标记：只看 events API 是否存在，与开关状态无关。 */
export function hostPlaylistSongsChangeSupported(): boolean {
  return isPlaylistSongsChangeSupported((songloft as unknown as { events?: unknown }).events);
}

/** 测试/重连用：会话失效后积压的写回继续跑。 */
export function resumeWritebackQueue(): void {
  getWritebackService().resumeQueue();
}

export function isWritebackSessionInvalid(err: unknown): boolean {
  return isInvalidSessionError(err);
}

/**
 * 首次打开写回：仅记录当前 Loved 键 + 收藏 songId。
 * 不 love 历史收藏、不 unlove 仅 Last.fm 有的曲目。
 */
export async function initWritebackSnapshot(): Promise<{ ok: boolean; reason: string }> {
  try {
    const settings = await loadSettings();
    const client = await refreshScrobbler();
    if (!settings.username) {
      const reason = "请先连接账号，否则无法记下起点，也不会写回";
      await saveWritebackMeta({
        snapshotError: reason,
        lastError: "",
        lastResultOk: null,
        paused: false,
        openedOnce: true,
      });
      return { ok: false, reason };
    }
    if (!client) {
      const reason = "请先连接账号，否则无法记下起点，也不会写回";
      await saveWritebackMeta({
        snapshotError: reason,
        lastError: "",
        lastResultOk: null,
        paused: false,
        openedOnce: true,
      });
      return { ok: false, reason };
    }
    const loved = await client.getLovedTracks({ username: settings.username, hardCap: LOVED_HARD_CAP });
    await getWritebackService().buildSnapshot({
      loved: loved.tracks,
      truncated: loved.truncated,
    });
    await saveWritebackMeta({
      snapshotError: "",
      lastError: "",
      lastResultOk: null,
      paused: false,
      openedOnce: true,
    });
    songloft.log.info(
      `[lastfm] write-back baseline ready: loved=${loved.tracks.length}${loved.truncated ? " (truncated)" : ""}`
    );
    return { ok: true, reason: "" };
  } catch (e) {
    const reason = friendlyLastFmError(e);
    await saveWritebackMeta({
      snapshotError: reason,
      lastError: "",
      lastResultOk: null,
      paused: false,
      openedOnce: true,
    });
    songloft.log.warn(`[lastfm] write-back baseline init failed: ${reason}`);
    return { ok: false, reason };
  }
}

export function _resetWritebackServiceForTests(): void {
  service = null;
  attached = false;
}

export function currentScrobblerForWriteback() {
  return getScrobbler();
}
