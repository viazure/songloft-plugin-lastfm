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
import { qualifiesForScrobble, thresholdDelayMs, type ScrobbleRuleConfig } from "./rules";

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
}

let scrobbler: LastFmScrobbler | null = null;
const active = new Map<number, ActivePlay>();

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

export async function handlePlayEvent(event: PlayEvent): Promise<void> {
  const settings = await loadSettings();
  if (!settings.enabled) return;
  if (settings.onlyMiot && event.source !== "miot") return;

  const title = event.song.title || "Unknown";
  const artist = event.song.artist || "Unknown";
  const source = event.source || "unknown";
  const songId = event.song.id;
  const startedAtSec = eventUnixSec(event);
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
    // New play: drop other early timers for different songs to avoid ghosts.
    for (const [id, other] of active) {
      if (id !== songId) {
        clearEarly(other);
        active.delete(id);
      }
    }
    const meta = await songMeta(songId);
    const prev = active.get(songId);
    if (prev) clearEarly(prev);
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
    };
    active.set(songId, play);
    try {
      await scrobbler!.updateNowPlaying(toListen(play));
      await appendLog("info", `nowplaying: ${artist} - ${title} (${source})`);
      songloft.log.info(`[lastfm] nowplaying ${artist} - ${title}`);
    } catch (e) {
      const msg = await handleInvalidSession(e);
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
  songloft.events.offPlayEvent();
}

/** Test seam: inspect/clear in-memory sessions (no I/O). */
export function _testActiveSize(): number {
  return active.size;
}