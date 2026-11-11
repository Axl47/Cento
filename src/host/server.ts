// `pnpm host`: the always-on half of the app. It alone talks to Spotify for Now Playing and serves the
// screen at /now to the network, so a TV or spare monitor needs neither a Spotify login nor a tab open on
// the Mac. Other devices can reach only /now, its data and the player commands, and only with the password.
import { readFile, stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { networkInterfaces } from "node:os";
import { extname, join, resolve, sep } from "node:path";
import { config } from "../core/config.ts";
import { mapLibrary } from "../core/now.ts";
import { sortTargets } from "../core/library.ts";
import { hasSession, isLocal, newSecret, passwordMatches, readSecret, saveSecret, sessionCookie, type Secret } from "./access.ts";
import { createRecorder, GAPS_FILE, HISTORY_FILE, rsyncBackup } from "./history.ts";
import { refreshIfDue, refreshStatus, scheduleRefresh } from "./refresh.ts";
import { addScreen, isPlayerCommand, libraryData, poll, runCommand, seek } from "./playback.ts";
import { forgetToken, freshToken, setToken, spotify, type HostToken } from "./spotify.ts";

const BUILD = resolve("dist");
const MAX_BODY = 64 * 1024;
const MIN_PASSWORD = 4;
const LOGIN_WAIT_MS = 1000;
const TYPES: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".woff2": "font/woff2", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon" };

let secret: Secret | null = await readSecret();
let nextLoginAt = 0;
const history = createRecorder(spotify, { file: HISTORY_FILE, gapsFile: GAPS_FILE, backup: rsyncBackup(config.historyBackup) });

const json = (res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store", ...headers });
  res.end(JSON.stringify(body));
};

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new Error("Body too large");
    chunks.push(chunk as Buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

const lanAddresses = () =>
  Object.values(networkInterfaces())
    .flat()
    .filter((a) => a && a.family === "IPv4" && !a.internal)
    .map((a) => `http://${a!.address}:${config.hostPort}/now`);

const isTokenBody = (b: unknown): b is HostToken => {
  const t = b as Partial<HostToken> | null;
  return typeof t?.accessToken === "string" && typeof t.refreshToken === "string" && typeof t.expiresAt === "number";
};

/** Calls only this Mac may make: the Spotify token, the password, and where to find the screen. */
async function localRoute(req: IncomingMessage, res: ServerResponse, path: string) {
  if (path === "/host/token") {
    if (req.method === "GET") return freshToken().then(({ accessToken, expiresAt }) => json(res, 200, { accessToken, expiresAt }), () => json(res, 401, {}));
    if (req.method === "POST") {
      const body = await readBody(req);
      if (!isTokenBody(body)) return json(res, 400, {});
      await setToken(body);
      void poll();
      void history.poll();
      return json(res, 200, {});
    }
    if (req.method === "DELETE") return forgetToken().then(() => json(res, 200, {}));
  }
  if (path === "/host/status" && req.method === "GET") return json(res, 200, { addresses: lanAddresses(), passwordSet: !!secret, history: history.status, refresh: refreshStatus() });
  if (path === "/host/password" && req.method === "PUT") {
    const { password } = (await readBody(req)) as { password?: unknown };
    if (typeof password !== "string" || password.length < MIN_PASSWORD) return json(res, 400, {});
    secret = await newSecret(password);
    await saveSecret(secret);
    return json(res, 200, {});
  }
  json(res, 404, {});
}

/** What a signed-in screen may do. */
async function screenRoute(req: IncomingMessage, res: ServerResponse, path: string) {
  if (req.method === "GET" && path === "/host/session") {
    const { lib } = await libraryData();
    const playlists = lib ? sortTargets(lib).map(({ id, name, imageUrl }) => ({ id, name, imageUrl, trackIds: [] })) : [];
    return json(res, 200, { playlists });
  }
  if (req.method === "GET" && path === "/host/events") return addScreen(res);
  if (req.method === "GET" && path === "/host/map") {
    const { lib, audio, hidden } = await libraryData();
    return lib && audio ? json(res, 200, { audio, lib: mapLibrary(lib, hidden) }) : json(res, 404, {});
  }
  if (req.method === "POST" && path.startsWith("/host/player/")) {
    const name = path.slice("/host/player/".length);
    if (name === "seek") {
      const { ms } = (await readBody(req)) as { ms?: unknown };
      if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) return json(res, 400, {});
      await seek(ms);
      return json(res, 200, {});
    }
    if (!isPlayerCommand(name)) return json(res, 404, {});
    await runCommand(name);
    return json(res, 200, {});
  }
  json(res, 404, {});
}

/** The built app's files. Anything else, including the main app's pages, leads to the screen. */
async function staticRoute(res: ServerResponse, path: string) {
  if (path === "/now") {
    res.writeHead(200, { "Content-Type": "text/html", "Cache-Control": "no-cache" });
    return res.end(await readFile(join(BUILD, "index.html")));
  }
  const file = resolve(join(BUILD, path));
  const isFile = file.startsWith(BUILD + sep) && (await stat(file).then((s) => s.isFile(), () => false));
  if (!isFile) {
    res.writeHead(302, { Location: "/now" });
    return res.end();
  }
  res.writeHead(200, { "Content-Type": TYPES[extname(file)] ?? "application/octet-stream", "Cache-Control": "public, max-age=3600" });
  res.end(await readFile(file));
}

async function route(req: IncomingMessage, res: ServerResponse) {
  const path = new URL(req.url ?? "/", "http://host").pathname;
  // Browsers won't send this content type across sites without permission, which the host never grants.
  if (req.method !== "GET" && req.headers["content-type"] !== "application/json") return json(res, 415, {});

  const signedIn = isLocal(req) || hasSession(secret, req.headers.cookie);
  if (["/host/token", "/host/status", "/host/password"].includes(path)) return isLocal(req) ? localRoute(req, res, path) : json(res, 403, {});
  if (path === "/host/login" && req.method === "POST") {
    if (!secret) return json(res, 409, {});
    if (Date.now() < nextLoginAt) return json(res, 429, {});
    const { password } = (await readBody(req)) as { password?: unknown };
    if (typeof password === "string" && (await passwordMatches(secret, password))) return json(res, 200, {}, { "Set-Cookie": sessionCookie(secret) });
    nextLoginAt = Date.now() + LOGIN_WAIT_MS;
    return json(res, 401, {});
  }
  if (path.startsWith("/host/")) return signedIn ? screenRoute(req, res, path) : json(res, 401, { passwordSet: !!secret });
  if (req.method !== "GET") return json(res, 404, {});
  return staticRoute(res, path);
}

// A data refresh owed from a day the host wasn't running comes first, so the screen starts on fresh data.
await refreshIfDue();
scheduleRefresh();

createServer((req, res) => {
  route(req, res).catch((e: unknown) => {
    console.error(e);
    if (!res.headersSent) json(res, 500, {});
    else res.end();
  });
}).listen(config.hostPort, "0.0.0.0", () => {
  console.log(`Now Playing on this Mac: http://127.0.0.1:${config.hostPort}/now`);
  for (const address of lanAddresses()) console.log(`On your network: ${address}`);
  if (!secret) console.log("Set a password from Settings on the Now Playing screen to let other devices in.");
  history.start();
});
