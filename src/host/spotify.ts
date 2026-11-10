// The host's Spotify access. It owns the login: the sorter on this Mac logs in as usual and hands the
// token over, because Spotify can replace the refresh token on each use, so only one side may hold it.
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createClient } from "../core/spotify.ts";

const TOKEN_FILE = "data/spotify-token.json";

export type HostToken = { accessToken: string; refreshToken: string; expiresAt: number };

let token: HostToken | null = await readFile(TOKEN_FILE, "utf8").then(
  (text) => JSON.parse(text) as HostToken,
  () => null,
);
let refreshing: Promise<HostToken> | null = null;

export async function setToken(next: HostToken) {
  token = next;
  await mkdir("data", { recursive: true });
  await writeFile(TOKEN_FILE, JSON.stringify(next), { mode: 0o600 });
}

export async function forgetToken() {
  token = null;
  await rm(TOKEN_FILE, { force: true });
}

async function refresh(current: HostToken): Promise<HostToken> {
  const res = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: process.env.SPOTIFY_CLIENT_ID ?? "", grant_type: "refresh_token", refresh_token: current.refreshToken }),
  });
  if (res.status === 400) {
    await forgetToken(); // revoked or replaced; only a new login fixes it
    throw new Error("The Spotify login expired. Open the sorter on the Mac and log in.");
  }
  if (!res.ok) throw new Error(`Spotify token request failed (${res.status})`);
  const json = (await res.json()) as { access_token: string; refresh_token?: string; expires_in: number };
  const next = { accessToken: json.access_token, refreshToken: json.refresh_token ?? current.refreshToken, expiresAt: Date.now() + (json.expires_in - 60) * 1000 };
  await setToken(next);
  return next;
}

/** A current access token, refreshed when needed. */
export async function freshToken(): Promise<HostToken> {
  if (!token) throw new Error("Not logged in to Spotify. Open the sorter on the Mac and log in.");
  if (Date.now() < token.expiresAt) return token;
  refreshing ??= refresh(token).finally(() => (refreshing = null));
  return refreshing;
}

export const spotify = createClient(async () => (await freshToken()).accessToken);
