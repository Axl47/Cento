// Minimal Spotify Web API client: PKCE login via a loopback redirect, a cached
// refreshable token, and a `get` helper that retries on rate limits.
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";

const CLIENT_ID = requireEnv("SPOTIFY_CLIENT_ID");
const REDIRECT_URI = requireEnv("SPOTIFY_REDIRECT_URI");
const TOKEN_PATH = ".cache/token.json";
const API = "https://api.spotify.com/v1";

// Requested up front so the sorter app can reuse the same token later.
const SCOPES = [
  "playlist-read-private",
  "playlist-read-collaborative",
  "playlist-modify-private",
  "playlist-modify-public",
  "user-library-read",
  "user-library-modify",
  "user-read-playback-state",
  "user-modify-playback-state",
  "streaming",
];

type StoredToken = { accessToken: string; refreshToken: string; expiresAt: number };
type TokenResponse = { access_token: string; refresh_token?: string; expires_in: number };

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing env var ${name} (see .env)`);
  return value;
}

const base64url = (buf: Buffer) => buf.toString("base64url");

async function tokenRequest(body: Record<string, string>, previousRefresh?: string): Promise<StoredToken> {
  const res = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: CLIENT_ID, ...body }),
  });
  if (!res.ok) throw new Error(`Token request failed: ${res.status} ${await res.text()}`);
  const json = (await res.json()) as TokenResponse;
  const token: StoredToken = {
    accessToken: json.access_token,
    refreshToken: json.refresh_token ?? previousRefresh ?? "",
    expiresAt: Date.now() + (json.expires_in - 60) * 1000,
  };
  await mkdir(".cache", { recursive: true });
  await writeFile(TOKEN_PATH, JSON.stringify(token));
  return token;
}

/** Opens the browser for consent and waits for the redirect on the loopback URI. */
async function login(): Promise<StoredToken> {
  const verifier = base64url(randomBytes(48));
  const challenge = base64url(createHash("sha256").update(verifier).digest());
  const state = base64url(randomBytes(12));
  const redirect = new URL(REDIRECT_URI);

  const code = await new Promise<string>((resolve, reject) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", redirect.origin);
      if (url.pathname !== redirect.pathname) return void res.writeHead(404).end();
      const got = url.searchParams.get("code");
      const ok = got && url.searchParams.get("state") === state;
      res.writeHead(ok ? 200 : 400, { "Content-Type": "text/plain" });
      res.end(ok ? "Logged in. You can close this tab." : `Login failed: ${url.searchParams.get("error")}`);
      server.close();
      ok ? resolve(got) : reject(new Error(`Login failed: ${url.searchParams.get("error")}`));
    });
    server.listen(Number(redirect.port), redirect.hostname, () => {
      const auth = new URL("https://accounts.spotify.com/authorize");
      auth.search = new URLSearchParams({
        client_id: CLIENT_ID,
        response_type: "code",
        redirect_uri: REDIRECT_URI,
        code_challenge_method: "S256",
        code_challenge: challenge,
        state,
        scope: SCOPES.join(" "),
      }).toString();
      console.log(`Opening Spotify login. If nothing opens, visit:\n${auth}`);
      execFile("open", [auth.toString()]);
    });
  });

  return tokenRequest({ grant_type: "authorization_code", code, redirect_uri: REDIRECT_URI, code_verifier: verifier });
}

let token: StoredToken | undefined;

async function accessToken(): Promise<string> {
  token ??= await readFile(TOKEN_PATH, "utf8")
    .then((s) => JSON.parse(s) as StoredToken)
    .catch(() => undefined);
  if (!token) token = await login();
  if (Date.now() > token.expiresAt) {
    token = await tokenRequest({ grant_type: "refresh_token", refresh_token: token.refreshToken }, token.refreshToken)
      .catch(() => login());
  }
  return token.accessToken;
}

/** GET an API path (or full `next` URL), retrying on 429 and transient 5xx. */
export async function get<T>(pathOrUrl: string): Promise<T> {
  const url = pathOrUrl.startsWith("http") ? pathOrUrl : `${API}${pathOrUrl}`;
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${await accessToken()}` } });
    if (res.ok) return (await res.json()) as T;
    const retryable = res.status === 429 || res.status >= 500;
    if (!retryable || attempt >= 5) throw new Error(`GET ${url} -> ${res.status} ${await res.text()}`);
    const wait = Number(res.headers.get("retry-after") ?? 2 ** attempt) * 1000;
    await new Promise((r) => setTimeout(r, wait));
  }
}

type Page<T> = { items: T[]; next: string | null; total: number };

/** Follows `next` links and returns every item of a paged endpoint. */
export async function getAll<T>(path: string): Promise<T[]> {
  const items: T[] = [];
  for (let next: string | null = path; next; ) {
    const page: Page<T> = await get<Page<T>>(next);
    items.push(...page.items);
    next = page.next;
  }
  return items;
}
