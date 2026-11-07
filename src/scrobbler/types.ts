/** Thin listen/scrobbler contract — Last.FM now; more backends later. */

export interface Listen {
  title: string;
  artist: string;
  album?: string;
  durationSec?: number;
  /** Unix seconds when playback started (for scrobble timestamp). */
  startedAtSec: number;
  songId?: number;
  source?: string;
}

export interface Scrobbler {
  readonly id: string;
  isReady(): Promise<boolean>;
  updateNowPlaying(listen: Listen): Promise<void>;
  scrobble(listen: Listen): Promise<void>;
}
