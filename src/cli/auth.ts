// Spotify login for Node scripts: PKCE via the loopback redirect, with the token cached
// in ~/.cache/playlist-sorter/token.json and refreshed as needed. Exports a ready client, plus library
// file helpers.
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { config } from "../core/config.ts";
import { createClient } from "../core/spotify.ts";
import type { Merge } from "../core/dedupe.ts";
import type { Library } from "../core/library.ts";

const CLIENT_ID = requireEnv("SPOTIFY_CLIENT_ID");
const REDIRECT_URI = requireEnv("SPOTIFY_REDIRECT_URI");
// Outside the project so the app's dev server can never serve it.
const TOKEN_PATH = join(homedir(), ".cache", "playlist-sorter", "token.json");
export const LIBRARY_PATH = "data/library.json";
/** Merges `pnpm merge-copies` made (see src/core/dedupe.ts). */
export const MERGES_PATH = "data/merges.json";

type StoredToken = { accessToken: string; refreshToken: string; expiresAt: number };
type TokenResponse = { access_token: string; refresh_token?: string; expires_in: number };

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing env var ${name} (see .env)`);
  return value;
}

export const loadLibrary = async (): Promise<Library> => JSON.parse(await readFile(LIBRARY_PATH, "utf8")) as Library;

export const loadMerges = (): Promise<Merge[]> =>
  readFile(MERGES_PATH, "utf8").then((s) => JSON.parse(s) as Merge[]).catch(() => []);

export async function saveLibrary(lib: Library) {
  await mkdir("data", { recursive: true });
  await writeFile(LIBRARY_PATH, JSON.stringify(lib));
}

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
  await mkdir(dirname(TOKEN_PATH), { recursive: true });
  await writeFile(TOKEN_PATH, JSON.stringify(token));
  return token;
}

/** Opens the browser for consent and waits for the redirect on the loopback URI. */
async function login(): Promise<StoredToken> {
  const verifier = randomBytes(48).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const state = randomBytes(12).toString("base64url");
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
    server.on("error", reject); // e.g. port 3000 taken by the app's dev server
    server.listen(Number(redirect.port), redirect.hostname, () => {
      const auth = new URL("https://accounts.spotify.com/authorize");
      auth.search = new URLSearchParams({
        client_id: CLIENT_ID,
        response_type: "code",
        redirect_uri: REDIRECT_URI,
        code_challenge_method: "S256",
        code_challenge: challenge,
        state,
        scope: config.scopes.join(" "),
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
    token = await tokenRequest({ grant_type: "refresh_token", refresh_token: token.refreshToken }, token.refreshToken).catch(
      () => login(),
    );
  }
  return token.accessToken;
}

export const client = createClient(accessToken);
