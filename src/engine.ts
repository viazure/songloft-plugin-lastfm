import type { PlayEvent } from "@songloft/plugin-sdk";
import { LastFmScrobbler } from "./scrobbler";
import type { Listen } from "./scrobbler";
import {
  appendLog,
  appendScrobbleRecord,
  friendlyLastFmError,
  isInvalidSessionError,
  loadSettings,
  markSessionInvalid,
  rulesFromSettings,
} from "./store";
import {
  qualifiesForScrobble,
  shouldFlushAbandoned,
  thresholdDelayMs,
  type ScrobbleRuleConfig,
} from "./rules";

/** In-flight track state for threshold / dedupe. */
interface ActivePlay {
  songId: number;
  title: string;
  artist: string;
  album?: string;
  durationSec: number;
  startedAtSec: number;
  source: string;
  scrobbled: boolean;
  /** True only when a real `play` event opened this session. */
  sawPlay: boolean;
  earlyTimer: ReturnType<typeof setTimeout> | null;
  /** Shared promise so early-timer and switch-flush cannot double-scrobble. */
  scrobbleInflight: Promise<void> | null;
}

let scrobbler: LastFmScrobbler | null = null;
const active = new Map<number, ActivePlay>();

/** Latest play cache for manual love/unlove (independent of onlyMiot). */
export interface LastPlayCache {
  title: string;
  artist: string;
  songId?: number;
  source?: string;
  atMs: number;
}

let lastPlayCache: LastPlayCache | null = null;

export function getLastPlayCache(): LastPlayCache | null {
  return lastPlayCache ? { ...lastPlayCache } : null;
}

function rememberLastPlay(input: { title: string; artist: string; songId?: number; source?: string }): void {
  lastPlayCache = {
    title: input.title || "Unknown",
    artist: input.artist || "Unknown",
    songId: input.songId,
    source: input.source,
    atMs: Date.now(),
  };
}

export async function refreshScrobbler(): Promise<LastFmScrobbler | null> {
  const s = await loadSettings();
  if (!s.apiKey || !s.apiSecret) {
    scrobbler = null;
    return null;
  }
  scrobbler = new LastFmScrobbler({
    apiKey: s.apiKey,
    apiSecret: s.apiSecret,
    sessionKey: s.sessionKey || undefined,
    username: s.username || undefined,
  });
  return scrobbler;
}

export function getScrobbler(): LastFmScrobbler | null {
  return scrobbler;
}

async function songMeta(songId: number): Promise<{ album?: string; durationSec: number }> {
  try {
    const song = await songloft.songs.getById(songId);
    const durationSec =
      typeof song?.duration === "number" && song.duration > 0 ? song.duration : 0;
    return { album: song?.album || undefined, durationSec };
  } catch {
    return { durationSec: 0 };
  }
}

function toListen(p: ActivePlay): Listen {
  return {
    title: p.title,
    artist: p.artist,
    album: p.album,
    durationSec: p.durationSec > 0 ? p.durationSec : undefined,
    startedAtSec: p.startedAtSec,
    songId: p.songId,
    source: p.source,
  };
}

function clearEarly(play: ActivePlay): void {
  if (play.earlyTimer != null) {
    clearTimeout(play.earlyTimer);
    play.earlyTimer = null;
  }
}

function eventUnixSec(event: PlayEvent): number {
  const ts = event.timestamp || Date.now();
  return ts > 1e12 ? Math.floor(ts / 1000) : Math.floor(ts);
}

async function handleInvalidSession(err: unknown): Promise<string> {
  if (isInvalidSessionError(err)) {
    await markSessionInvalid();
    await refreshScrobbler();
  }
  return friendlyLastFmError(err);
}

async function doScrobble(
  play: ActivePlay,
  reason: string,
  rules: ScrobbleRuleConfig
): Promise<void> {
  if (play.scrobbled) return;
  // Serialize early-threshold vs switch/replay flush around the same listen.
  if (play.scrobbleInflight) {
    await play.scrobbleInflight;
    return;
  }
  const run = (async () => {
    if (play.scrobbled) return;
    if (!(await refreshScrobbler()) || !(await scrobbler!.isReady())) {
      songloft.log.info(`[lastfm] skip scrobble (${reason}): not connected`);
      await appendScrobbleRecord({
        title: play.title,
        artist: play.artist,
        ok: false,
        reason: "尚未连接账号",
        source: play.source,
        path: reason,
      });
      await appendLog("warn", `scrobble skipped (not connected): ${play.artist} - ${play.title}`);
      return;
    }
    try {
      await scrobbler!.scrobble(toListen(play));
      play.scrobbled = true;
      clearEarly(play);
      await appendScrobbleRecord({
        title: play.title,
        artist: play.artist,
        ok: true,
        source: play.source,
        path: reason,
      });
      await appendLog(
        "info",
        `scrobble: ${play.artist} - ${play.title} (${play.source}, ${reason})`
      );
      songloft.log.info(`[lastfm] scrobble ${play.artist} - ${play.title} (${reason})`);
    } catch (e) {
      const msg = await handleInvalidSession(e);
      await appendScrobbleRecord({
        title: play.title,
        artist: play.artist,
        ok: false,
        reason: msg,
        source: play.source,
        path: reason,
      });
      await appendLog("error", `scrobble failed: ${msg}`);
      songloft.log.error(`[lastfm] scrobble failed: ${msg}`);
    }
  })();
  play.scrobbleInflight = run;
  try {
    await run;
  } finally {
    if (play.scrobbleInflight === run) play.scrobbleInflight = null;
  }
}

function scheduleEarly(play: ActivePlay, rules: ScrobbleRuleConfig): void {
  clearEarly(play);
  if (!play.sawPlay || play.scrobbled) return;
  const delay = thresholdDelayMs(play.durationSec, rules);
  play.earlyTimer = setTimeout(() => {
    play.earlyTimer = null;
    // Best-effort continuous-play assumption after a real play event.
    // Not verified position; pause/seek invisible. Always on; miot often finish-only.
    const playedProxy = delay / 1000;
    if (!qualifiesForScrobble(play.durationSec, playedProxy, rules)) return;
    void doScrobble(play, "early-threshold", rules);
  }, delay);
}

/**
 * Host often emits play(B) without skip/finish(A). Previously we only clearEarly+delete,
 * which races the early timer at the threshold and drops wall-clock-qualified listens.
 * Flush with the same continuous-play assumption as early-threshold.
 */
async function flushAbandonedPlay(
  play: ActivePlay,
  nowSec: number,
  rules: ScrobbleRuleConfig,
  reason: "switch" | "replay"
): Promise<void> {
  clearEarly(play);
  const { flush, playedSec } = shouldFlushAbandoned({
    sawPlay: play.sawPlay,
    scrobbled: play.scrobbled,
    durationSec: play.durationSec,
    startedAtSec: play.startedAtSec,
    nowSec,
    rules,
  });
  if (!flush) {
    if (play.sawPlay && !play.scrobbled) {
      await appendLog(
        "info",
        `abandon without scrobble (${reason}, played=${playedSec}s): ${play.artist} - ${play.title}`
      );
    }
    return;
  }
  await doScrobble(play, reason, rules);
}

export async function handlePlayEvent(event: PlayEvent): Promise<void> {
  const title = event.song.title || "Unknown";
  const artist = event.song.artist || "Unknown";
  const source = event.source || "unknown";
  const songId = event.song.id;
  const startedAtSec = eventUnixSec(event);

  // Always remember latest play for manual love/unlove (not gated by onlyMiot/enabled).
  if (event.type === "play") {
    rememberLastPlay({ title, artist, songId, source });
  }

  const settings = await loadSettings();
  if (!settings.enabled) return;
  if (settings.onlyMiot && event.source !== "miot") return;

  const rules = rulesFromSettings(settings);

  if (!(await refreshScrobbler()) || !(await scrobbler!.isReady())) {
    songloft.log.info(`[lastfm] skip ${event.type}: not connected`);
    // Diagnose "没记上": surface disconnected early-return in 最近记录.
    await appendScrobbleRecord({
      title,
      artist,
      ok: false,
      reason: "尚未连接账号",
      source,
      path: event.type,
    });
    return;
  }

  if (event.type === "play") {
    // New play: flush other sessions that already crossed threshold, then drop them.
    for (const [id, other] of [...active.entries()]) {
      if (id !== songId) {
        await flushAbandonedPlay(other, startedAtSec, rules, "switch");
        active.delete(id);
      }
    }
    const meta = await songMeta(songId);
    const prev = active.get(songId);
    if (prev) {
      // Same songId re-play (restart / re-queue): flush prior listen if qualified.
      await flushAbandonedPlay(prev, startedAtSec, rules, "replay");
      active.delete(songId);
    }
    const play: ActivePlay = {
      songId,
      title,
      artist,
      album: meta.album,
      durationSec: meta.durationSec,
      startedAtSec,
      source,
      scrobbled: false,
      sawPlay: true,
      earlyTimer: null,
    scrobbleInflight: null,
    };
    active.set(songId, play);
    try {
      await scrobbler!.updateNowPlaying(toListen(play));
      await appendLog("info", `nowplaying: ${artist} - ${title} (${source})`);
      songloft.log.info(`[lastfm] nowplaying ${artist} - ${title}`);
    } catch (e) {
      const msg = await handleInvalidSession(e);
      // Surface nowplaying failures in 最近记录 (scrobble path already recorded).
      await appendScrobbleRecord({
        title,
        artist,
        ok: false,
        reason: msg,
        source,
        path: "nowplaying",
      });
      await appendLog("error", `nowplaying failed: ${msg}`);
      songloft.log.error(`[lastfm] nowplaying failed: ${msg}`);
    }
    scheduleEarly(play, rules);
    return;
  }

  if (event.type === "finish" || event.type === "skip") {
    let play = active.get(songId);
    if (!play) {
      const meta = await songMeta(songId);
      play = {
        songId,
        title,
        artist,
        album: meta.album,
        durationSec: meta.durationSec,
        startedAtSec,
        source,
        scrobbled: false,
        sawPlay: false,
        earlyTimer: null,
      scrobbleInflight: null,
      };
      active.set(songId, play);
    }
    clearEarly(play);

    if (play.scrobbled) {
      active.delete(songId);
      return;
    }

    const endSec = eventUnixSec(event);
    // Observed listen: prefer elapsed since real play; finish-only without play
    // may use host-declared full duration (finish means track completed).
    let playedSec: number;
    if (play.sawPlay) {
      playedSec = Math.max(0, endSec - play.startedAtSec);
      // Host `finish` means track completed; credit full duration if known.
      if (event.type === "finish" && play.durationSec > 0) {
        playedSec = Math.max(playedSec, play.durationSec);
      }
    } else if (event.type === "finish" && play.durationSec > 0) {
      // finish-only (common on miot): no invented mid-track progress — full duration only.
      playedSec = play.durationSec;
    } else {
      // skip/finish without prior play and unknown duration: cannot invent listen time.
      playedSec = Math.max(0, endSec - play.startedAtSec);
    }

    const ok = qualifiesForScrobble(play.durationSec, playedSec, rules);
    if (!ok) {
      await appendLog(
        "info",
        `skip scrobble (${event.type}, played=${playedSec}s): ${artist} - ${title}`
      );
      active.delete(songId);
      return;
    }
    await doScrobble(play, event.type, rules);
    active.delete(songId);
  }
}

export function subscribePlayEvents(): void {
  songloft.events.onPlayEvent(async (event: PlayEvent) => {
    try {
      await handlePlayEvent(event);
    } catch (e) {
      songloft.log.error(`[lastfm] play handler: ${String(e)}`);
    }
  });
  songloft.log.info("[lastfm] play event subscribed");
}

export function unsubscribePlayEvents(): void {
  for (const play of active.values()) clearEarly(play);
  active.clear();
  lastPlayCache = null;
  songloft.events.offPlayEvent();
}

/** Test seam: inspect/clear in-memory sessions (no I/O). */
export function _testActiveSize(): number {
  return active.size;
}
