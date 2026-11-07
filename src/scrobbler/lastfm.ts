import { md5 } from "../md5";
import type { Listen, Scrobbler } from "./types";

const API_ROOT = "https://ws.audioscrobbler.com/2.0/";

export interface LastFmCredentials {
  apiKey: string;
  apiSecret: string;
  sessionKey?: string;
  username?: string;
}

type ParamMap = Record<string, string>;

function sign(params: ParamMap, apiSecret: string): string {
  const keys = Object.keys(params).filter((k) => k !== "format" && k !== "callback").sort();
  let raw = "";
  for (const k of keys) raw += k + params[k];
  raw += apiSecret;
  return md5(raw);
}

async function post(params: ParamMap, apiSecret: string): Promise<unknown> {
  const body: ParamMap = { ...params, format: "json" };
  body.api_sig = sign(params, apiSecret);
  const form = Object.keys(body)
    .map((k) => encodeURIComponent(k) + "=" + encodeURIComponent(body[k]))
    .join("&");
  const res = await fetch(API_ROOT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded; charset=utf-8" },
    body: form,
  });
  const text = await res.text();
  let data: any;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`Last.FM non-JSON (${res.status}): ${text.slice(0, 200)}`);
  }
  if (data && typeof data.error !== "undefined") {
    throw new Error(`Last.FM error ${data.error}: ${data.message || text.slice(0, 200)}`);
  }
  if (!res.ok) {
    throw new Error(`Last.FM HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
  return data;
}

export class LastFmScrobbler implements Scrobbler {
  readonly id = "lastfm";
  private creds: LastFmCredentials;

  constructor(creds: LastFmCredentials) {
    this.creds = { ...creds };
  }

  updateCredentials(creds: LastFmCredentials): void {
    this.creds = { ...creds };
  }

  getCredentials(): LastFmCredentials {
    return { ...this.creds };
  }

  async isReady(): Promise<boolean> {
    return !!(this.creds.apiKey && this.creds.apiSecret && this.creds.sessionKey);
  }

  async getMobileSession(username: string, password: string): Promise<{ name: string; key: string }> {
    const params: ParamMap = {
      method: "auth.getMobileSession",
      api_key: this.creds.apiKey,
      username,
      password,
    };
    const data: any = await post(params, this.creds.apiSecret);
    const session = data?.session;
    if (!session?.key) throw new Error("auth.getMobileSession: missing session.key");
    this.creds.sessionKey = String(session.key);
    this.creds.username = String(session.name || username);
    return { name: this.creds.username!, key: this.creds.sessionKey! };
  }

  async getToken(): Promise<string> {
    const params: ParamMap = {
      method: "auth.getToken",
      api_key: this.creds.apiKey,
    };
    const data: any = await post(params, this.creds.apiSecret);
    const token = data?.token;
    if (!token) throw new Error("auth.getToken: missing token");
    return String(token);
  }

  authUrl(token: string): string {
    return `https://www.last.fm/api/auth/?api_key=${encodeURIComponent(this.creds.apiKey)}&token=${encodeURIComponent(token)}`;
  }

  async getSession(token: string): Promise<{ name: string; key: string }> {
    const params: ParamMap = {
      method: "auth.getSession",
      api_key: this.creds.apiKey,
      token,
    };
    const data: any = await post(params, this.creds.apiSecret);
    const session = data?.session;
    if (!session?.key) throw new Error("auth.getSession: missing session.key");
    this.creds.sessionKey = String(session.key);
    this.creds.username = String(session.name || "");
    return { name: this.creds.username!, key: this.creds.sessionKey! };
  }

  async updateNowPlaying(listen: Listen): Promise<void> {
    if (!(await this.isReady())) throw new Error("Last.FM not authorized");
    const params: ParamMap = {
      method: "track.updateNowPlaying",
      api_key: this.creds.apiKey,
      sk: this.creds.sessionKey!,
      artist: listen.artist,
      track: listen.title,
    };
    if (listen.album) params.album = listen.album;
    if (listen.durationSec && listen.durationSec > 0) {
      params.duration = String(Math.floor(listen.durationSec));
    }
    await post(params, this.creds.apiSecret);
  }

  async scrobble(listen: Listen): Promise<void> {
    if (!(await this.isReady())) throw new Error("Last.FM not authorized");
    const params: ParamMap = {
      method: "track.scrobble",
      api_key: this.creds.apiKey,
      sk: this.creds.sessionKey!,
      artist: listen.artist,
      track: listen.title,
      timestamp: String(Math.floor(listen.startedAtSec)),
    };
    if (listen.album) params.album = listen.album;
    if (listen.durationSec && listen.durationSec > 0) {
      params.duration = String(Math.floor(listen.durationSec));
    }
    await post(params, this.creds.apiSecret);
  }

  async love(artist: string, track: string): Promise<void> {
    if (!(await this.isReady())) throw new Error("Last.FM not authorized");
    const params: ParamMap = {
      method: "track.love",
      api_key: this.creds.apiKey,
      sk: this.creds.sessionKey!,
      artist,
      track,
    };
    await post(params, this.creds.apiSecret);
  }

  async unlove(artist: string, track: string): Promise<void> {
    if (!(await this.isReady())) throw new Error("Last.FM not authorized");
    const params: ParamMap = {
      method: "track.unlove",
      api_key: this.creds.apiKey,
      sk: this.creds.sessionKey!,
      artist,
      track,
    };
    await post(params, this.creds.apiSecret);
  }
  /**
   * Page through user.getLovedTracks until exhausted or hardCap.
   * Read-only; session key optional. Secrets never logged here.
   */
  async getLovedTracks(opts?: {
    username?: string;
    limitPerPage?: number;
    hardCap?: number;
  }): Promise<{
    tracks: Array<{ artist: string; title: string; mbid?: string }>;
    truncated: boolean;
    totalReported: number;
  }> {
    const user = (opts?.username || this.creds.username || "").trim();
    if (!user) throw new Error("Last.FM username required for loved tracks");
    if (!this.creds.apiKey) throw new Error("Last.FM apiKey required");
    const limitPerPage = Math.min(Math.max(opts?.limitPerPage ?? 50, 1), 50);
    const hardCap = Math.max(opts?.hardCap ?? 1000, 1);
    const tracks: Array<{ artist: string; title: string; mbid?: string }> = [];
    let page = 1;
    let totalPages = 1;
    let totalReported = 0;
    let truncated = false;

    while (page <= totalPages && tracks.length < hardCap) {
      const params: ParamMap = {
        method: "user.getLovedTracks",
        api_key: this.creds.apiKey,
        user,
        limit: String(limitPerPage),
        page: String(page),
      };
      if (this.creds.sessionKey) params.sk = this.creds.sessionKey;
      const data: any = await post(params, this.creds.apiSecret);
      const root = data?.lovedtracks;
      const attr = root?.["@attr"] || {};
      totalPages = Math.max(1, parseInt(String(attr.totalPages || "1"), 10) || 1);
      totalReported = parseInt(String(attr.total || "0"), 10) || totalReported;
      let batch = root?.track;
      if (!batch) batch = [];
      if (!Array.isArray(batch)) batch = [batch];
      for (const raw of batch) {
        if (tracks.length >= hardCap) {
          truncated = true;
          break;
        }
        const title = String(raw?.name || "").trim();
        const artistRaw = raw?.artist;
        const artist =
          typeof artistRaw === "string"
            ? artistRaw.trim()
            : String(artistRaw?.name || artistRaw?.["#text"] || "").trim();
        if (!title || !artist) continue;
        const mbidRaw = String(raw?.mbid || "").trim();
        const entry: { artist: string; title: string; mbid?: string } = { artist, title };
        if (mbidRaw) entry.mbid = mbidRaw;
        tracks.push(entry);
      }
      if (tracks.length >= hardCap && page < totalPages) truncated = true;
      if (truncated) break;
      page += 1;
    }

    if (!truncated && totalReported > hardCap && tracks.length >= hardCap) {
      truncated = true;
    }
    return { tracks, truncated, totalReported: totalReported || tracks.length };
  }
}
