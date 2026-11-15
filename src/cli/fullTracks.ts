// Brings new saved songs' full-track data up to date with Stemma (ENGINE_DIR): fetches their full audio from YouTube
// Music to the storage box, embeds the whole song and each ~2 s moment, extracts tempo, key, loudness and vocals for
// songs Gaia has separated into stems, reruns the mood and genre tags, and fetches and language-tags their lyrics.
// Every step resumes where it stopped, so a run only works on new songs. The host's daily refresh runs it before
// `pnpm audio`, which then reads the results.
//
//   pnpm full-tracks [--limit N]   fetches at most N new full tracks (default 50; the rest wait for the next run)
//
// Needs the storage box's ssh alias (`audio-box`), YouTube from a residential IP (this Mac), and Stemma's `.venv` with
// its bench dependencies. A failed step doesn't stop the others; the run exits non-zero naming them.
import { execFileSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";

const BOX = "audio-box";
const limitArg = process.argv.indexOf("--limit");
const limit = limitArg >= 0 ? Number(process.argv[limitArg + 1]) : 50;

const engine = process.env.ENGINE_DIR;
if (!engine) throw new Error("Set ENGINE_DIR in .env to the Stemma checkout");
const cache = process.env.ENGINE_CACHE ?? join(homedir(), ".cache/audio-embed-engine");
const tracks = resolve("data/tracks.jsonl");
const manifest = join(cache, "yt-outbox/manifest.jsonl");
const python = join(engine, ".venv/bin/python");
// The features and tags scripts carry their own dependencies (PEP 723), so they run outside the project's venv.
const script = ["uv", "run", "--no-project", "--python", "3.12"] as const;

const run = (cmd: string, ...args: string[]) => {
  console.log(`$ ${cmd} ${args.join(" ")}`);
  execFileSync(cmd, args, { cwd: engine, stdio: "inherit", env: { ...process.env, PYTHONPATH: "bench" } });
};

/** Songs whose vocals stem is on the box: Gaia separates them after the full track arrives. */
async function keysWithStems() {
  const listing = execFileSync("rsync", ["--list-only", `${BOX}:stems/`], { encoding: "utf8", maxBuffer: 64 << 20 });
  const keys = [...listing.matchAll(/ (\S+)\.vocals\.opus$/gm)].map((m) => m[1]);
  const file = join(await mkdtemp(join(tmpdir(), "cento-stems-")), "keys.txt");
  await writeFile(file, keys.join("\n"));
  return file;
}

const newer = (a: string, b: string) => !existsSync(b) || statSync(a).mtimeMs > statSync(b).mtimeMs;

const steps: [name: string, step: () => void | Promise<void>][] = [
  ["fetch full tracks", () => run(python, "bench/fetch_youtube.py", tracks, join(cache, "yt-outbox"), "--limit", String(limit), "--upload", `${BOX}:tracks/`)],
  ["embed full tracks", () => run(python, "bench/embed_full.py", manifest, `${BOX}:tracks/`)],
  ["embed moments", () => run(python, "bench/embed_patches.py", manifest, `${BOX}:tracks/`, join(cache, "patches"))],
  ["features", async () => run(...script, "bench/extract_features.py", manifest, join(cache, "features/features.jsonl"), "--keys", await keysWithStems())],
  // Tags are rebuilt from every song's moments (a few minutes), so only when there are new ones.
  ["tags", () => {
    if (newer(join(cache, "patches/index.jsonl"), join(cache, "tags/tags.jsonl"))) run(...script, "bench/tags.py", "run");
  }],
  ["lyrics", () => run(python, "bench/fetch_lyrics.py", tracks, join(cache, "lyrics.jsonl"))],
  ["lyric languages", () => run(join(engine, ".venv/bin/audio-embed"), "languages", join(cache, "lyrics.jsonl"), "--out", resolve("data/languages.jsonl"))],
];

const failed: string[] = [];
for (const [name, step] of steps) {
  try {
    await step();
  } catch (e) {
    console.error(`full-tracks: ${name} failed: ${e instanceof Error ? e.message : e}`);
    failed.push(name);
  }
}
if (failed.length) {
  console.error(`full-tracks: failed: ${failed.join(", ")}`);
  process.exit(1);
}
