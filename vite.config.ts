import { defineConfig, loadEnv, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import basicSsl from "@vitejs/plugin-basic-ssl";
import { spawn } from "node:child_process";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";

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

function localData(): Plugin {
  const files: Record<string, string> = {
    "/api/library": "data/library.json",
    "/api/rules": "data/rules.json",
    "/api/hidden": "data/hidden.json",
    "/api/ledger": "data/ledger.json",
    "/api/audio": "data/audio.json",
    "/api/vectors": "data/vectors.bin",
    "/api/classifier": "data/classifier.json",
  };
  const writable = new Set(["data/library.json", "data/rules.json", "data/hidden.json", "data/ledger.json"]);


  return {
    name: "local-data",
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        if (isPrivate(req.url ?? "")) return void res.writeHead(403).end();
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
    },
  };
});
