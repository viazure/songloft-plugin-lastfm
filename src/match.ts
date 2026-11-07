/** Pure match helpers for LFM loved → local library (no host I/O). */

export interface LibrarySongRef {
  id: number;
  artist: string;
  title: string;
  /** Present only when both sides can supply one; Songloft Song has no mbid field today. */
  mbid?: string;
}

export interface LovedTrackRef {
  artist: string;
  title: string;
  mbid?: string;
}

export interface MatchResult {
  matchedIds: number[];
  matched: number;
  unmatched: number;
  unmatchedSamples: Array<{ artist: string; title: string }>;
}

/** trim + lower + collapse whitespace */
export function normalizeText(s: string): string {
  return String(s ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

/** Stable artist+title key (MVP: no fuzzy). */
export function artistTitleKey(artist: string, title: string): string {
  return normalizeText(artist) + "\0" + normalizeText(title);
}

export function normalizeMbid(mbid: string | undefined | null): string | undefined {
  if (typeof mbid !== "string") return undefined;
  const t = mbid.trim().toLowerCase();
  if (!t || t === "00000000-0000-0000-0000-000000000000") return undefined;
  return t;
}

/**
 * Build indexes: mbid → songIds (asc), artistTitle → songIds (asc).
 * One-to-many: callers take the first id (lowest songId).
 */
export function buildLibraryIndexes(songs: LibrarySongRef[]): {
  byMbid: Map<string, number[]>;
  byArtistTitle: Map<string, number[]>;
} {
  const byMbid = new Map<string, number[]>();
  const byArtistTitle = new Map<string, number[]>();
  for (const s of songs) {
    if (!Number.isFinite(s.id)) continue;
    const at = artistTitleKey(s.artist, s.title);
    const atList = byArtistTitle.get(at) || [];
    atList.push(s.id);
    byArtistTitle.set(at, atList);
    const mb = normalizeMbid(s.mbid);
    if (mb) {
      const mbList = byMbid.get(mb) || [];
      mbList.push(s.id);
      byMbid.set(mb, mbList);
    }
  }
  for (const list of byMbid.values()) list.sort((a, b) => a - b);
  for (const list of byArtistTitle.values()) list.sort((a, b) => a - b);
  return { byMbid, byArtistTitle };
}

const SAMPLE_CAP = 10;

/**
 * Match loved tracks to library. mbid wins when both sides have one;
 * else exact normalized artist+title. Dedupes song ids (first love wins order).
 */
export function matchLovedTracks(
  loved: LovedTrackRef[],
  songs: LibrarySongRef[],
  sampleCap: number = SAMPLE_CAP
): MatchResult {
  const { byMbid, byArtistTitle } = buildLibraryIndexes(songs);
  const matchedIds: number[] = [];
  const seen = new Set<number>();
  const unmatchedSamples: Array<{ artist: string; title: string }> = [];
  let unmatched = 0;

  for (const t of loved) {
    let id: number | undefined;
    const mb = normalizeMbid(t.mbid);
    if (mb) {
      const hits = byMbid.get(mb);
      if (hits && hits.length) id = hits[0];
    }
    if (id == null) {
      const hits = byArtistTitle.get(artistTitleKey(t.artist, t.title));
      if (hits && hits.length) id = hits[0];
    }
    if (id == null) {
      unmatched += 1;
      if (unmatchedSamples.length < sampleCap) {
        unmatchedSamples.push({ artist: t.artist, title: t.title });
      }
      continue;
    }
    if (!seen.has(id)) {
      seen.add(id);
      matchedIds.push(id);
    }
  }

  return {
    matchedIds,
    matched: matchedIds.length,
    unmatched,
    unmatchedSamples,
  };
}
