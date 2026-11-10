import { defineConfig, loadEnv, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import basicSsl from "@vitejs/plugin-basic-ssl";
import { spawn } from "node:child_process";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { config } from "./src/core/config.ts";

/**
 * Serves the local data files to the app so the scripts and the app share them
 * (and blocks direct requests for .cache/ and data/):
 *   GET/PUT /api/library  -> data/library.json
 *   GET/PUT /api/rules    -> data/rules.json (artist rules; 404 until the first one is saved)
 *   GET/PUT /api/hidden   -> data/hidden.json (playlists hidden from suggestions; same)
 *   GET/PUT /api/ledger   -> data/ledger.json (sorts not yet confirmed by a resync; same)
 *   GET     /api/audio    -> data/audio.json (404 until `pnpm audio` has run)
 *   GET     /api/vectors  -> data/vectors.bin (same; binary)
 *   GET     /api/classifier -> data/classifier.json (404 until `pnpm classify` has run)
 *   POST    /api/classifier -> retrains it, replying once it's done
 *   GET     /api/themes   -> data/themes.json (what songs are about; 404 until `pnpm lyrics` has run)
 *   GET     /api/lyrics?q=  -> best lyric passage per song for the search (404 until `pnpm lyrics` has run)
 */
/** Vite serves any file under the root (also via /@fs/); keep .cache/ and data/ private. */
function isPrivate(url: string): boolean {
  try {
    const raw = decodeURIComponent(url.split("?")[0] ?? "");
    const file = resolve(raw.startsWith("/@fs/") ? raw.slice(4) : join(process.cwd(), raw));
    return [".cache", "data"].some((dir) => (file + "/").startsWith(join(process.cwd(), dir) + "/"));
  } catch {
    return true; // malformed encoding
  }
}

const SEARCH_RESULTS = 200;
let lyricSearcher: ReturnType<typeof loadLyricSearcher> | undefined;

/** Loaded on the first search and kept, so only that search waits for the model; null without an index. */
async function loadLyricSearcher() {
  const { loadEmbedder, loadIndex } = await import("./src/cli/lyricModel.ts");
  const { searchLyrics } = await import("./src/core/lyrics.ts");
  const index = await loadIndex();
  if (!index) return null;
  const embed = await loadEmbedder();
  return async (query: string) => searchLyrics(index, await embed([query], "query"), query, SEARCH_RESULTS);
}

async function lyricSearch(query: string) {
  lyricSearcher ??= loadLyricSearcher();
  const search = await lyricSearcher;
  if (!search) lyricSearcher = undefined; // look for the index again next time
  return search ? search(query) : null;
}

function localData(): Plugin {
  const files: Record<string, string> = {
    "/api/library": "data/library.json",
    "/api/rules": "data/rules.json",
    "/api/hidden": "data/hidden.json",
    "/api/ledger": "data/ledger.json",
    "/api/audio": "data/audio.json",
    "/api/vectors": "data/vectors.bin",
    "/api/classifier": "data/classifier.json",
    "/api/themes": "data/themes.json",
  };
  const writable = new Set(["data/library.json", "data/rules.json", "data/hidden.json", "data/ledger.json"]);


  return {
    name: "local-data",
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        if (isPrivate(req.url ?? "")) return void res.writeHead(403).end();
        if (req.method === "GET" && req.url?.startsWith("/api/lyrics?")) {
          const query = new URL(req.url, "http://local").searchParams.get("q")?.trim();
          if (!query) return void res.writeHead(400).end();
          try {
            const hits = await lyricSearch(query);
            if (!hits) return void res.writeHead(404).end();
            res.setHeader("Content-Type", "application/json");
            return void res.end(JSON.stringify(hits));
          } catch (e) {
            console.error(e);
            return void res.writeHead(500).end();
          }
        }
        const path = files[req.url ?? ""];
        if (!path) return next();
        if (req.method === "POST" && req.url === "/api/classifier") {
          const code = await new Promise<number | null>((done) => spawn("pnpm", ["classify"], { stdio: "inherit" }).on("close", done));
          return void res.writeHead(code === 0 ? 204 : 500).end();
        }
        if (req.method === "PUT" && writable.has(path)) {
          const chunks: Buffer[] = [];
          for await (const chunk of req) chunks.push(chunk as Buffer);
          await mkdir("data", { recursive: true });
          await writeFile(path, Buffer.concat(chunks));
          return void res.writeHead(204).end();
        }
        try {
          res.setHeader("Content-Type", path.endsWith(".bin") ? "application/octet-stream" : "application/json");
          res.end(await readFile(path));
        } catch {
          res.writeHead(404).end();
        }
      });
    },
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "SPOTIFY_");
  const redirect = new URL(env.SPOTIFY_REDIRECT_URI ?? "http://127.0.0.1:3000/web_player");
  // `pnpm dev:lan` serves on every interface over HTTPS (self-signed): Spotify only allows plain-http
  // redirects to loopback, and PKCE's crypto.subtle needs a secure context off localhost.
  const lan = mode === "lan";
  return {
    plugins: [react(), tailwindcss(), localData(), ...(lan ? [basicSsl()] : [])],
    envPrefix: "SPOTIFY_",
    // The port must match the redirect URI registered on the Spotify app.
    server: {
      host: lan ? true : redirect.hostname,
      port: Number(redirect.port),
      strictPort: true,
      // Only without LAN mode: forwarded requests look local to the host, so they must really come from this Mac.
      proxy: lan ? undefined : { "/host": `http://127.0.0.1:${config.hostPort}` },
    },
  };
});
