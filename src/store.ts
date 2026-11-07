import type { LovedScheduleState } from "./loved-schedule";
import { DEFAULT_LOVED_SCHEDULE, normalizeIntervalHours } from "./loved-schedule";
import type { StatsScheduleState } from "./stats-schedule";
import { DEFAULT_STATS_SCHEDULE, normalizeStatsIntervalHours } from "./stats-schedule";
import { normalizeHardCap, STATS_SYNC_DEFAULT_HARD_CAP, NEAR_WINDOW_STRATEGY } from "./stats-sync";

export interface PluginSettings {
  apiKey: string;
  apiSecret: string;
  sessionKey: string;
  username: string;
  /** When true, only sync events with source === "miot". */
  onlyMiot: boolean;
  enabled: boolean;
  pendingToken: string;
  /** True after key rotate / invalid session — UI shows「需重新连接」. */
  needsReconnect: boolean;
  /** Pano-like: min track length (sec). Default 30. */
  minDurationSec: number;
  /** Pano-like: percent of duration. Default 50. */
  delayPercent: number;
  /** Pano-like: absolute delay cap (sec). Default 240. */
  delayMaxSec: number;
  /** Songloft playlist name for Loved sync. Empty → "Last.fm Loved". */
  lovedPlaylistName: string;
  /** Max recent tracks per stats sync (1..1000, default 500). */
  statsSyncHardCap: number;
}

const SETTINGS_KEY = "settings";
const LOG_KEY = "recent_log";
const MAX_LOG = 40;
const SCROBBLES_KEY = "scrobble_records";

export const MAX_SCROBBLE_RECORDS = 20;

const DEFAULTS: PluginSettings = {
  apiKey: "",
  apiSecret: "",
  sessionKey: "",
  username: "",
  onlyMiot: false,
  enabled: true,
  pendingToken: "",
  needsReconnect: false,
  minDurationSec: 30,
  delayPercent: 50,
  delayMaxSec: 240,
  lovedPlaylistName: "Last.fm Loved",
  statsSyncHardCap: STATS_SYNC_DEFAULT_HARD_CAP,
};

function asObject(raw: unknown): Record<string, unknown> {
  if (raw == null) return {};
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }
  if (typeof raw === "object") return raw as Record<string, unknown>;
  return {};
}

function numOr(v: unknown, fallback: number): number {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : fallback;
}

export async function loadSettings(): Promise<PluginSettings> {
  try {
    const raw = await songloft.storage.get(SETTINGS_KEY);
    const data = asObject(raw);
    return {
      apiKey: typeof data.apiKey === "string" ? data.apiKey : "",
      apiSecret: typeof data.apiSecret === "string" ? data.apiSecret : "",
      sessionKey: typeof data.sessionKey === "string" ? data.sessionKey : "",
      username: typeof data.username === "string" ? data.username : "",
      onlyMiot: !!data.onlyMiot,
      enabled: data.enabled !== false,
      pendingToken: typeof data.pendingToken === "string" ? data.pendingToken : "",
      needsReconnect: data.needsReconnect === true,
      minDurationSec: numOr(data.minDurationSec, DEFAULTS.minDurationSec),
      delayPercent: numOr(data.delayPercent, DEFAULTS.delayPercent),
      delayMaxSec: numOr(data.delayMaxSec, DEFAULTS.delayMaxSec),
      lovedPlaylistName:
        typeof data.lovedPlaylistName === "string" ? data.lovedPlaylistName : DEFAULTS.lovedPlaylistName,
      statsSyncHardCap: normalizeHardCap(
        data.statsSyncHardCap !== undefined ? data.statsSyncHardCap : DEFAULTS.statsSyncHardCap
      ),
    };
  } catch {
    return { ...DEFAULTS };
  }
}

export async function saveSettings(partial: Partial<PluginSettings>): Promise<PluginSettings> {
  const cur = await loadSettings();
  const next: PluginSettings = { ...cur, ...partial };
  // Drop legacy earlyOnThreshold if still present in raw storage merge paths.
  const toStore = { ...next } as Record<string, unknown>;
  delete toStore.earlyOnThreshold;
  await songloft.storage.set(SETTINGS_KEY, toStore);
  return next;
}

/** User intentionally disconnected → 未连接 */
export async function clearSession(): Promise<PluginSettings> {
  return saveSettings({
    sessionKey: "",
    username: "",
    pendingToken: "",
    needsReconnect: false,
  });
}

/** Session died / key rotated → 需重新连接（保留 username 便于展示） */
export async function markSessionInvalid(): Promise<PluginSettings> {
  return saveSettings({
    sessionKey: "",
    pendingToken: "",
    needsReconnect: true,
  });
}

export interface LogEntry {
  ts: number;
  level: "info" | "warn" | "error";
  message: string;
}

export async function appendLog(level: LogEntry["level"], message: string): Promise<void> {
  let list: LogEntry[] = [];
  try {
    const raw = await songloft.storage.get(LOG_KEY);
    const data = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (Array.isArray(data)) list = data as LogEntry[];
  } catch {
    list = [];
  }
  list.push({ ts: Date.now(), level, message });
  if (list.length > MAX_LOG) list = list.slice(-MAX_LOG);
  await songloft.storage.set(LOG_KEY, list);
}

export async function loadLog(): Promise<LogEntry[]> {
  try {
    const raw = await songloft.storage.get(LOG_KEY);
    const data = typeof raw === "string" ? JSON.parse(raw) : raw;
    return Array.isArray(data) ? (data as LogEntry[]) : [];
  } catch {
    return [];
  }
}

/** Structured recent scrobble attempts for the settings observation panel. */
export interface ScrobbleRecord {
  ts: number;
  title: string;
  artist: string;
  ok: boolean;
  /** Human-readable failure reason (never secrets). Optional path hint on success. */
  reason?: string;
  source?: string;
  /** early-threshold | finish | skip | switch | replay | nowplaying | test | love | unlove | loved_playlist_sync | stats_sync */
  path?: string;
}

/** Pure ring-buffer append (newest at end); keeps at most `max` entries. */
export function pushScrobbleRecord(
  list: ScrobbleRecord[],
  entry: ScrobbleRecord,
  max: number = MAX_SCROBBLE_RECORDS
): ScrobbleRecord[] {
  const next = list.concat(entry);
  return next.length > max ? next.slice(-max) : next;
}

/** Strip hex blobs / labeled secrets before any user-facing string leaves the plugin. */
export function stripSecrets(raw: string): string {
  let s = String(raw ?? "");
  s = s.replace(/[a-fA-F0-9]{32,}/g, "[已隐藏]");
  s = s.replace(
    /\b(api[_-]?key|api[_-]?secret|shared[_-]?secret|session[_-]?key|password|token|sk)\b\s*[:=]\s*\S+/gi,
    "$1=[已隐藏]"
  );
  return s;
}

export function publicStatus(settings: PluginSettings) {
  const authorized = !!(settings.apiKey && settings.apiSecret && settings.sessionKey);
  return {
    configured: !!(settings.apiKey && settings.apiSecret),
    authorized,
    needsReconnect: !authorized && settings.needsReconnect === true,
    username: settings.username || "",
    onlyMiot: settings.onlyMiot,
    enabled: settings.enabled,
    hasApiKey: !!settings.apiKey,
    hasApiSecret: !!settings.apiSecret,
    pendingToken: !!settings.pendingToken,
    minDurationSec: settings.minDurationSec,
    delayPercent: settings.delayPercent,
    delayMaxSec: settings.delayMaxSec,
  };
}

export function rulesFromSettings(settings: PluginSettings) {
  return {
    minDurationSec: settings.minDurationSec,
    delayPercent: settings.delayPercent,
    delayMaxSec: settings.delayMaxSec,
  };
}

/** Map Last.fm API / thrown errors to user-facing Chinese (no secrets). */
export function friendlyLastFmError(err: unknown): string {
  const s = stripSecrets(String(err ?? ""));
  if (/Invalid session key|error\s*9\b|连接已失效/i.test(s)) {
    return "连接已失效，请重新连接账号";
  }
  if (/Authentication Failed|error\s*4\b/i.test(s)) {
    return "账号或密码不正确，请重试";
  }
  if (/Invalid API key|error\s*10\b/i.test(s)) {
    return "应用凭证无效，请检查 API Key / Secret";
  }
  if (/rate limit|error\s*29\b/i.test(s)) {
    return "Last.fm 限流，请稍后再试";
  }
  if (/Service Offline|error\s*11\b/i.test(s)) {
    return "Last.fm 服务暂时不可用，请稍后再试";
  }
  if (
    /fetch failed|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|ECONNRESET|network|Failed to fetch|NetworkError/i.test(
      s
    )
  ) {
    return "网络错误，请检查网络后重试";
  }
  if (/Last\.F[Mm] HTTP|HTTP \d{3}/i.test(s)) {
    return "Last.fm 暂时无响应，请稍后再试";
  }
  if (/未连接|not connected/i.test(s)) {
    return "尚未连接账号";
  }
  if (s.length > 160) return s.slice(0, 160) + "…";
  return s || "未知错误";
}

/** Alias used by scrobble observation — same sanitization + friendly map. */
export function sanitizeReason(raw: unknown): string {
  return friendlyLastFmError(raw);
}

export function isInvalidSessionError(err: unknown): boolean {
  return /Invalid session key|error\s*9\b/i.test(String(err));
}

function normalizeRecord(raw: unknown): ScrobbleRecord | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const title = typeof o.title === "string" ? o.title : "";
  const artist = typeof o.artist === "string" ? o.artist : "";
  const ts = typeof o.ts === "number" && Number.isFinite(o.ts) ? o.ts : 0;
  if (!title && !artist && !ts) return null;
  const ok = o.ok === true;
  const rec: ScrobbleRecord = {
    ts: ts || Date.now(),
    title: title || "Unknown",
    artist: artist || "Unknown",
    ok,
  };
  if (typeof o.reason === "string" && o.reason) {
    rec.reason = sanitizeReason(o.reason);
  }
  if (typeof o.source === "string" && o.source) rec.source = o.source;
  if (typeof o.path === "string" && o.path) rec.path = o.path;
  return rec;
}

export async function loadScrobbleRecords(): Promise<ScrobbleRecord[]> {
  try {
    const raw = await songloft.storage.get(SCROBBLES_KEY);
    const data = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (!Array.isArray(data)) return [];
    return data.map(normalizeRecord).filter((x): x is ScrobbleRecord => !!x);
  } catch {
    return [];
  }
}

export async function appendScrobbleRecord(input: {
  title: string;
  artist: string;
  ok: boolean;
  reason?: string;
  source?: string;
  path?: string;
  ts?: number;
}): Promise<ScrobbleRecord[]> {
  const list = await loadScrobbleRecords();
  const entry: ScrobbleRecord = {
    ts: input.ts ?? Date.now(),
    title: input.title || "Unknown",
    artist: input.artist || "Unknown",
    ok: !!input.ok,
    source: input.source,
    path: input.path,
  };
  if (!input.ok) {
    entry.reason = sanitizeReason(input.reason || "未知错误");
  } else if (input.reason) {
    entry.reason = sanitizeReason(input.reason);
  }
  const next = pushScrobbleRecord(list, entry);
  await songloft.storage.set(SCROBBLES_KEY, next);
  return next;
}

/** Last successful/failed Loved→playlist sync summary (settings page). */
export interface LovedPlaylistSyncStored {
  ts: number;
  ok: boolean;
  loved: number;
  matched: number;
  unmatched: number;
  truncated?: boolean;
  playlistId?: number;
  playlistIdChanged?: boolean;
  reason?: string;
  unmatchedSamples?: Array<{ artist: string; title: string }>;
  /** Resolved playlist name used for this sync. */
  playlistName?: string;
}

const LOVED_SYNC_KEY = "loved_playlist_sync";

export async function loadLovedPlaylistSync(): Promise<LovedPlaylistSyncStored | null> {
  try {
    const raw = await songloft.storage.get(LOVED_SYNC_KEY);
    const data = asObject(raw);
    if (!data || typeof data.ts !== "number") return null;
    const out: LovedPlaylistSyncStored = {
      ts: data.ts as number,
      ok: data.ok === true,
      loved: numOr(data.loved, 0),
      matched: numOr(data.matched, 0),
      unmatched: numOr(data.unmatched, 0),
    };
    if (data.truncated === true) out.truncated = true;
    if (typeof data.playlistId === "number") out.playlistId = data.playlistId;
    if (data.playlistIdChanged === true) out.playlistIdChanged = true;
    if (typeof data.playlistName === "string" && data.playlistName.trim()) {
      out.playlistName = data.playlistName.trim();
    }
    if (typeof data.reason === "string" && data.reason) {
      out.reason = sanitizeReason(data.reason);
    }
    if (Array.isArray(data.unmatchedSamples)) {
      out.unmatchedSamples = (data.unmatchedSamples as unknown[])
        .map((x) => {
          if (!x || typeof x !== "object") return null;
          const o = x as Record<string, unknown>;
          const artist = typeof o.artist === "string" ? o.artist : "";
          const title = typeof o.title === "string" ? o.title : "";
          if (!artist && !title) return null;
          return { artist, title };
        })
        .filter((x): x is { artist: string; title: string } => !!x)
        .slice(0, 10);
    }
    return out;
  } catch {
    return null;
  }
}

export async function saveLovedPlaylistSync(
  result: LovedPlaylistSyncStored
): Promise<LovedPlaylistSyncStored> {
  const toStore: LovedPlaylistSyncStored = {
    ts: result.ts,
    ok: !!result.ok,
    loved: result.loved | 0,
    matched: result.matched | 0,
    unmatched: result.unmatched | 0,
  };
  if (result.truncated) toStore.truncated = true;
  if (typeof result.playlistId === "number") toStore.playlistId = result.playlistId;
  if (result.playlistIdChanged) toStore.playlistIdChanged = true;
  if (typeof result.playlistName === "string" && result.playlistName.trim()) {
    toStore.playlistName = result.playlistName.trim();
  }
  if (!result.ok && result.reason) toStore.reason = sanitizeReason(result.reason);
  else if (result.reason) toStore.reason = sanitizeReason(result.reason);
  if (result.unmatchedSamples?.length) {
    toStore.unmatchedSamples = result.unmatchedSamples.slice(0, 10);
  }
  await songloft.storage.set(LOVED_SYNC_KEY, toStore);
  return toStore;
}

const LOVED_SCHEDULE_KEY = "loved_schedule";

export async function loadLovedSchedule(): Promise<LovedScheduleState> {
  try {
    const raw = await songloft.storage.get(LOVED_SCHEDULE_KEY);
    const data = asObject(raw);
    const lastSuccessAt =
      typeof data.lastSuccessAt === "number" && Number.isFinite(data.lastSuccessAt)
        ? data.lastSuccessAt
        : null;
    const nextDueAt =
      typeof data.nextDueAt === "number" && Number.isFinite(data.nextDueAt)
        ? data.nextDueAt
        : null;
    return {
      enabled: data.enabled === true,
      intervalHours: normalizeIntervalHours(data.intervalHours),
      lastSuccessAt,
      nextDueAt,
    };
  } catch {
    return { ...DEFAULT_LOVED_SCHEDULE };
  }
}

export async function saveLovedSchedule(
  partial: Partial<LovedScheduleState>
): Promise<LovedScheduleState> {
  const cur = await loadLovedSchedule();
  const next: LovedScheduleState = {
    enabled: partial.enabled !== undefined ? !!partial.enabled : cur.enabled,
    intervalHours: normalizeIntervalHours(
      partial.intervalHours !== undefined ? partial.intervalHours : cur.intervalHours
    ),
    lastSuccessAt:
      partial.lastSuccessAt !== undefined
        ? partial.lastSuccessAt == null || !Number.isFinite(partial.lastSuccessAt as number)
          ? null
          : (partial.lastSuccessAt as number)
        : cur.lastSuccessAt,
    nextDueAt:
      partial.nextDueAt !== undefined
        ? partial.nextDueAt == null || !Number.isFinite(partial.nextDueAt as number)
          ? null
          : (partial.nextDueAt as number)
        : cur.nextDueAt,
  };
  await songloft.storage.set(LOVED_SCHEDULE_KEY, next);
  return next;
}


/** Last successful/failed Last.fm → stats sync summary (settings page). */
export interface StatsSyncStored {
  ts: number;
  ok: boolean;
  fetched: number;
  matched: number;
  imported: number;
  skippedNear: number;
  skippedExact: number;
  unmatched: number;
  truncated?: boolean;
  watermarkUts: number;
  nearWindowStrategy: string;
  hardCap: number;
  reason?: string;
  unmatchedSamples?: Array<{ artist: string; title: string }>;
}

const STATS_SYNC_KEY = "stats_sync_state";

export async function loadStatsSyncState(): Promise<StatsSyncStored | null> {
  try {
    const raw = await songloft.storage.get(STATS_SYNC_KEY);
    const data = asObject(raw);
    if (!data || typeof data.ts !== "number") return null;
    const out: StatsSyncStored = {
      ts: data.ts as number,
      ok: data.ok === true,
      fetched: numOr(data.fetched, 0),
      matched: numOr(data.matched, 0),
      imported: numOr(data.imported, 0),
      skippedNear: numOr(data.skippedNear, 0),
      skippedExact: numOr(data.skippedExact, 0),
      unmatched: numOr(data.unmatched, 0),
      watermarkUts: numOr(data.watermarkUts, 0),
      nearWindowStrategy:
        typeof data.nearWindowStrategy === "string" && data.nearWindowStrategy
          ? data.nearWindowStrategy
          : NEAR_WINDOW_STRATEGY,
      hardCap: normalizeHardCap(data.hardCap),
    };
    if (data.truncated === true) out.truncated = true;
    if (typeof data.reason === "string" && data.reason) {
      out.reason = sanitizeReason(data.reason);
    }
    if (Array.isArray(data.unmatchedSamples)) {
      out.unmatchedSamples = (data.unmatchedSamples as unknown[])
        .map((x) => {
          if (!x || typeof x !== "object") return null;
          const o = x as Record<string, unknown>;
          const artist = typeof o.artist === "string" ? o.artist : "";
          const title = typeof o.title === "string" ? o.title : "";
          if (!artist && !title) return null;
          return { artist, title };
        })
        .filter((x): x is { artist: string; title: string } => !!x)
        .slice(0, 10);
    }
    return out;
  } catch {
    return null;
  }
}

export async function saveStatsSyncState(result: StatsSyncStored): Promise<StatsSyncStored> {
  const toStore: StatsSyncStored = {
    ts: result.ts,
    ok: !!result.ok,
    fetched: result.fetched | 0,
    matched: result.matched | 0,
    imported: result.imported | 0,
    skippedNear: result.skippedNear | 0,
    skippedExact: result.skippedExact | 0,
    unmatched: result.unmatched | 0,
    watermarkUts: Math.max(0, result.watermarkUts | 0),
    nearWindowStrategy: result.nearWindowStrategy || NEAR_WINDOW_STRATEGY,
    hardCap: normalizeHardCap(result.hardCap),
  };
  if (result.truncated) toStore.truncated = true;
  if (result.reason) toStore.reason = sanitizeReason(result.reason);
  if (result.unmatchedSamples?.length) {
    toStore.unmatchedSamples = result.unmatchedSamples.slice(0, 10);
  }
  await songloft.storage.set(STATS_SYNC_KEY, toStore);
  return toStore;
}

const STATS_SCHEDULE_KEY = "stats_schedule";

export async function loadStatsSchedule(): Promise<StatsScheduleState> {
  try {
    const raw = await songloft.storage.get(STATS_SCHEDULE_KEY);
    const data = asObject(raw);
    const lastSuccessAt =
      typeof data.lastSuccessAt === "number" && Number.isFinite(data.lastSuccessAt)
        ? data.lastSuccessAt
        : null;
    const nextDueAt =
      typeof data.nextDueAt === "number" && Number.isFinite(data.nextDueAt)
        ? data.nextDueAt
        : null;
    return {
      enabled: data.enabled === true,
      intervalHours: normalizeStatsIntervalHours(data.intervalHours),
      lastSuccessAt,
      nextDueAt,
    };
  } catch {
    return { ...DEFAULT_STATS_SCHEDULE };
  }
}

export async function saveStatsSchedule(
  partial: Partial<StatsScheduleState>
): Promise<StatsScheduleState> {
  const cur = await loadStatsSchedule();
  const next: StatsScheduleState = {
    enabled: partial.enabled !== undefined ? !!partial.enabled : cur.enabled,
    intervalHours: normalizeStatsIntervalHours(
      partial.intervalHours !== undefined ? partial.intervalHours : cur.intervalHours
    ),
    lastSuccessAt:
      partial.lastSuccessAt !== undefined
        ? partial.lastSuccessAt == null || !Number.isFinite(partial.lastSuccessAt as number)
          ? null
          : (partial.lastSuccessAt as number)
        : cur.lastSuccessAt,
    nextDueAt:
      partial.nextDueAt !== undefined
        ? partial.nextDueAt == null || !Number.isFinite(partial.nextDueAt as number)
          ? null
          : (partial.nextDueAt as number)
        : cur.nextDueAt,
  };
  await songloft.storage.set(STATS_SCHEDULE_KEY, next);
  return next;
}

