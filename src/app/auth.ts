// Browser Spotify login: PKCE redirect to /web_player, token kept in localStorage and
// refreshed as needed. `client` is the shared API client bound to this token.
import { config } from "../core/config.ts";
import { createClient } from "../core/spotify.ts";

const CLIENT_ID = import.meta.env.SPOTIFY_CLIENT_ID as string;
const REDIRECT_URI = import.meta.env.SPOTIFY_REDIRECT_URI as string;
const TOKEN_KEY = "spotify-token";
const VERIFIER_KEY = "spotify-verifier";

type StoredToken = { accessToken: string; refreshToken: string; expiresAt: number };

const readToken = (): StoredToken | null => {
  try {
    return JSON.parse(localStorage.getItem(TOKEN_KEY) ?? "null") as StoredToken | null;
  } catch {
    return null;
  }
};

async function tokenRequest(body: Record<string, string>, previousRefresh = ""): Promise<StoredToken> {
  const res = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: CLIENT_ID, ...body }),
  });
  if (!res.ok) throw new Error(`Spotify token request failed (${res.status})`);
  const json = (await res.json()) as { access_token: string; refresh_token?: string; expires_in: number };
  const token = {
    accessToken: json.access_token,
    refreshToken: json.refresh_token ?? previousRefresh,
    expiresAt: Date.now() + (json.expires_in - 60) * 1000,
  };
  localStorage.setItem(TOKEN_KEY, JSON.stringify(token));
  return token;
}

const base64url = (bytes: ArrayBuffer | Uint8Array) =>
  btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

export async function startLogin() {
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(48)));
  const challenge = base64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
  sessionStorage.setItem(VERIFIER_KEY, verifier);
  const url = new URL("https://accounts.spotify.com/authorize");
  url.search = new URLSearchParams({
    client_id: CLIENT_ID,
    response_type: "code",
    redirect_uri: REDIRECT_URI,
    code_challenge_method: "S256",
    code_challenge: challenge,
    scope: config.scopes.join(" "),
  }).toString();
  location.assign(url);
}

/** Finishes a login redirect if this page load is one. Returns whether we're logged in. */
export async function completeLogin(): Promise<boolean> {
  const params = new URLSearchParams(location.search);
  const code = params.get("code");
  const verifier = sessionStorage.getItem(VERIFIER_KEY);
  if (location.pathname === new URL(REDIRECT_URI).pathname) {
    history.replaceState(null, "", "/");
    if (code && verifier) {
      sessionStorage.removeItem(VERIFIER_KEY);
      await tokenRequest({ grant_type: "authorization_code", code, redirect_uri: REDIRECT_URI, code_verifier: verifier });
    }
  }
  return readToken() !== null;
}

let refreshing: Promise<StoredToken> | null = null;

export async function accessToken(): Promise<string> {
  const token = readToken();
  if (!token) throw new Error("Not logged in");
  if (Date.now() < token.expiresAt) return token.accessToken;
  refreshing ??= tokenRequest({ grant_type: "refresh_token", refresh_token: token.refreshToken }, token.refreshToken).finally(
    () => (refreshing = null),
  );
  return (await refreshing).accessToken;
}

export const client = createClient(accessToken);
