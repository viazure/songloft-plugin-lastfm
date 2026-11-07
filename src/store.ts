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
  /** early-threshold | finish | skip | test */
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
