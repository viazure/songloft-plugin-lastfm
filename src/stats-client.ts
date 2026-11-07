/** HTTP client for official stats plugin via host forward (same pattern as stats→tag). */

const STATS_ENTRY = "stats";

export interface FetchInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}

export interface StatsPlayRecord {
  songId: number;
  title: string;
  artist: string;
  album?: string;
  duration?: number;
  source: string;
  type?: string;
  timestamp: number;
}

export type StatsFetchFn = (path: string, init?: FetchInit) => Promise<unknown>;

/** Build host-forward URL for a stats plugin path (leading slash). */
export function statsPluginUrl(host: string, token: string, path: string): string {
  const base = String(host || "").replace(/\/$/, "");
  const p = path.startsWith("/") ? path : `/${path}`;
  const sep = p.includes("?") ? "&" : "?";
  return `${base}/api/v1/jsplugin/${STATS_ENTRY}${p}${sep}access_token=${encodeURIComponent(token)}`;
}

/** Default fetch via songloft.plugin getHostUrl + getToken. */
export async function statsFetch(path: string, init?: FetchInit): Promise<unknown> {
  const [host, token] = await Promise.all([
    songloft.plugin.getHostUrl(),
    songloft.plugin.getToken(),
  ]);
  const url = statsPluginUrl(host, token, path);
  const res = await fetch(url, init as any);
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`stats 插件响应 HTTP ${res.status}${body ? `: ${body.slice(0, 120)}` : ""}`);
  }
  try {
    return await res.json();
  } catch {
    return {};
  }
}

export async function probeStatsAvailable(fetchFn: StatsFetchFn = statsFetch): Promise<boolean> {
  try {
    await fetchFn("/api/history/raw?limit=1");
    return true;
  } catch {
    return false;
  }
}

export async function fetchRawHistoryWindow(
  opts: {
    /** Earliest timestamp (ms) we care about (inclusive floor for paging stop). */
    olderThanMs: number;
    pageLimit?: number;
    maxPages?: number;
  },
  fetchFn: StatsFetchFn = statsFetch
): Promise<StatsPlayRecord[]> {
  const pageLimit = Math.min(Math.max(opts.pageLimit ?? 100, 1), 100);
  const maxPages = Math.min(Math.max(opts.maxPages ?? 50, 1), 100);
  const out: StatsPlayRecord[] = [];
  let offset = 0;
  for (let page = 0; page < maxPages; page++) {
    const data: any = await fetchFn(`/api/history/raw?limit=${pageLimit}&offset=${offset}`);
    const records = (data?.data?.records || data?.records || []) as StatsPlayRecord[];
    if (!Array.isArray(records) || records.length === 0) break;
    for (const r of records) {
      if (!r || typeof r.songId !== "number" || typeof r.timestamp !== "number") continue;
      out.push(r);
    }
    const oldest = records[records.length - 1];
    const oldestTs = typeof oldest?.timestamp === "number" ? oldest.timestamp : 0;
    const hasMore = data?.data?.hasMore === true;
    if (oldestTs > 0 && oldestTs < opts.olderThanMs) break;
    if (!hasMore) break;
    offset += records.length;
  }
  return out;
}

export async function importPlayRecords(
  records: StatsPlayRecord[],
  fetchFn: StatsFetchFn = statsFetch
): Promise<{ added: number; total?: number }> {
  if (!records.length) return { added: 0 };
  const data: any = await fetchFn("/api/import", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ records }),
  });
  if (data && data.success === false) {
    throw new Error(String(data.error || "stats import failed"));
  }
  const added = typeof data?.data?.added === "number" ? data.data.added : 0;
  const total = typeof data?.data?.total === "number" ? data.data.total : undefined;
  return { added, total };
}
