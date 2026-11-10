/** Pure scrobble gating helpers (no Songloft/Last.fm I/O). */

export type ScrobblePlaySource = "miot" | "songloft-player";

export const DEFAULT_SCROBBLE_SOURCES: ScrobblePlaySource[] = ["miot", "songloft-player"];

export function isNetworkSongType(songType?: string | null): boolean {
  return songType === "remote" || songType === "radio";
}

export function isLocalSongType(songType?: string | null): boolean {
  return songType === "local";
}

/**
 * Normalize persisted / posted playback sources to known values only.
 * Empty array is allowed (means no playback source is recorded).
 */
export function normalizeScrobbleSources(raw: unknown): ScrobblePlaySource[] {
  if (!Array.isArray(raw)) return [...DEFAULT_SCROBBLE_SOURCES];
  const out: ScrobblePlaySource[] = [];
  for (const item of raw) {
    if (item === "miot" || item === "songloft-player") {
      if (!out.includes(item)) out.push(item);
    }
  }
  return out;
}

/** Derive legacy onlyMiot flag: true iff the sole selected source is miot. */
export function deriveOnlyMiot(sources: ScrobblePlaySource[]): boolean {
  return sources.length === 1 && sources[0] === "miot";
}

/**
 * Compat when `scrobbleSources` is absent from saved settings:
 * onlyMiot === true → ["miot"]; otherwise both defaults.
 */
export function sourcesFromLegacyOnlyMiot(onlyMiot: boolean): ScrobblePlaySource[] {
  return onlyMiot ? ["miot"] : [...DEFAULT_SCROBBLE_SOURCES];
}

/**
 * Chinese skip reason, or null when the play should be recorded.
 *
 * Content: local ↔ scrobbleLocal; remote|radio ↔ scrobbleNetwork (network includes radio).
 * Missing / empty / unknown songType → fail-open on the content axis (do not skip).
 * Playback: when playSource is present and not in scrobbleSources → skip.
 * Missing / empty playSource → fail-open on the playback axis.
 * Both axes are AND (either axis can skip).
 */
export function getScrobbleSkipReason(opts: {
  scrobbleLocal: boolean;
  scrobbleNetwork: boolean;
  scrobbleSources: ScrobblePlaySource[];
  songType?: string | null;
  playSource?: string | null;
}): string | null {
  const t = opts.songType;
  if (isLocalSongType(t) && !opts.scrobbleLocal) {
    return "未勾选记录本地音乐";
  }
  if (isNetworkSongType(t) && !opts.scrobbleNetwork) {
    return "未勾选记录网络音乐";
  }

  const src = opts.playSource;
  if (src != null && src !== "") {
    if (!opts.scrobbleSources.includes(src as ScrobblePlaySource)) {
      return "未勾选该播放方式";
    }
  }
  return null;
}

export function shouldSkipScrobble(opts: {
  scrobbleLocal: boolean;
  scrobbleNetwork: boolean;
  scrobbleSources: ScrobblePlaySource[];
  songType?: string | null;
  playSource?: string | null;
}): boolean {
  return getScrobbleSkipReason(opts) != null;
}
