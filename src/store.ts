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
  /**
   * If true, after a real `play` event schedule one scrobble at the threshold
   * assuming continuous play. Default true (web play with progress). miot/speaker
   * often finish-only so early path usually no-ops; finish still scrobbles.
   */
  earlyOnThreshold: boolean;
}

const SETTINGS_KEY = "settings";
const LOG_KEY = "recent_log";
const MAX_LOG = 40;

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
  earlyOnThreshold: true,
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
      earlyOnThreshold: typeof data.earlyOnThreshold === "boolean"
        ? data.earlyOnThreshold
        : DEFAULTS.earlyOnThreshold,
    };
  } catch {
    return { ...DEFAULTS };
  }
}

export async function saveSettings(partial: Partial<PluginSettings>): Promise<PluginSettings> {
  const cur = await loadSettings();
  const next: PluginSettings = { ...cur, ...partial };
  await songloft.storage.set(SETTINGS_KEY, next);
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
    earlyOnThreshold: settings.earlyOnThreshold,
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
  const s = String(err);
  if (/Invalid session key|error\s*9\b/i.test(s)) {
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
  return s;
}

export function isInvalidSessionError(err: unknown): boolean {
  return /Invalid session key|error\s*9\b/i.test(String(err));
}