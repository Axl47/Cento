// Builds data/features.json: each library song's tempo, key, loudness and vocals, for the Build tab.
//
//   pnpm features
//
// Reads Stemma's per-song features (FEATURES_FILE, default ~/.cache/audio-embed-engine/features/features.jsonl,
// written by its bench/extract_features.py) and keeps only what the app shows, keyed by library track id.
// Exits quietly when that file doesn't exist, so the daily refresh can always run it.
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { encodeFeatures, songFeatures, type EngineFeatures, type SongFeatures } from "../core/features.ts";

const OUT = "data/features.json";
const source = process.env.FEATURES_FILE ?? join(homedir(), ".cache/audio-embed-engine/features/features.jsonl");

if (!existsSync(source)) {
  console.log(`${OUT}: skipped, no ${source}`);
  process.exit(0);
}

const lines = async <T>(path: string) => (await readFile(path, "utf8")).split("\n").filter(Boolean).map((l) => JSON.parse(l) as T);

// The engine names a song by its ISRC, or by its Spotify id when it has none.
const byKey = new Map<string, SongFeatures>();
for (const line of await lines<EngineFeatures | { key: string; error: string }>(source)) {
  if (!("error" in line)) byKey.set(line.key, songFeatures(line));
}
const songs = new Map<string, SongFeatures>();
const tracks = await lines<{ key: string; isrc: string | null }>("data/tracks.jsonl");
for (const t of tracks) {
  const f = byKey.get(t.isrc?.toUpperCase() ?? t.key);
  if (f) songs.set(t.key, f);
}
const json = JSON.stringify(encodeFeatures(songs));
await writeFile(OUT, json);
console.log(`${OUT}: ${songs.size} of ${tracks.length} songs, ${Math.round(json.length / 1024)} KB`);
