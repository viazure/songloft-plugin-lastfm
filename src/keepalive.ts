/**
 * Host idle eviction unloads jsplugins after ~10m with no activity and clears
 * play-event subscriptions. BroadcastPlayEvent does NOT EnsureLoaded (unlike
 * lyric providers), so a sleeping Last.fm misses scrobbles until something
 * HTTP-hits the plugin.
 *
 * Practical fix without host changes: put `lastfm` on the host
 * `/api/v1/settings/plugin-keep-alive` whitelist (same mechanism as miot).
 * Ideal "wake on play, unload when idle" needs a Songloft host change.
 */

export const ENTRY_PATH = "lastfm";

export type KeepAliveSetting = { plugins?: string[] };

/** Pure: ensure entryPath is in the whitelist (deduped, order preserved). */
export function withKeepAliveEntry(
  current: KeepAliveSetting | null | undefined,
  entryPath: string = ENTRY_PATH
): { plugins: string[]; changed: boolean } {
  const list = Array.isArray(current?.plugins)
    ? current!.plugins!.filter((p): p is string => typeof p === "string" && p.length > 0)
    : [];
  if (list.includes(entryPath)) {
    return { plugins: list, changed: false };
  }
  return { plugins: [...list, entryPath], changed: true };
}

export type EnsureKeepAliveResult =
  | { ok: true; already: boolean; plugins: string[] }
  | { ok: false; reason: string; status?: number };

/**
 * Best-effort: read + optionally PUT host keep-alive whitelist via plugin JWT.
 * Failures are non-fatal (caller logs); admin may have set the list manually.
 */
export async function ensureHostKeepAlive(
  entryPath: string = ENTRY_PATH
): Promise<EnsureKeepAliveResult> {
  try {
    const token = await songloft.plugin.getToken();
    const host = (await songloft.plugin.getHostUrl()).replace(/\/$/, "");
    const url = `${host}/api/v1/settings/plugin-keep-alive`;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
    };

    const getResp = await fetch(url, { method: "GET", headers });
    if (!getResp.ok) {
      return {
        ok: false,
        reason: `GET keep-alive HTTP ${getResp.status}`,
        status: getResp.status,
      };
    }
    let body: KeepAliveSetting = {};
    try {
      body = (await getResp.json()) as KeepAliveSetting;
    } catch {
      body = {};
    }

    const { plugins, changed } = withKeepAliveEntry(body, entryPath);
    if (!changed) {
      return { ok: true, already: true, plugins };
    }

    const putResp = await fetch(url, {
      method: "PUT",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ plugins }),
    });
    if (!putResp.ok) {
      return {
        ok: false,
        reason: `PUT keep-alive HTTP ${putResp.status}`,
        status: putResp.status,
      };
    }
    return { ok: true, already: false, plugins };
  } catch (e) {
    return { ok: false, reason: String(e) };
  }
}
