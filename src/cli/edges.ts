// Builds data/edges.bin: how each song starts and ends, for judging the handoff from one song to the next.
//
//   pnpm edges
//
// Reads the engine's per-moment vectors (one per ~2 s of each full track, in PATCHES_DIR, default
// ~/.cache/audio-embed-engine/patches) and averages each song's first and last EDGE_PATCHES of them.
// A song the engine has no full track for uses its whole-song vector for both, so it still gets a handoff.
// Run it after `pnpm audio`: rows follow data/audio.json.
import { open, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { decodeVectors, encodeVectors, type AudioIndex } from "../core/audio.ts";

const EDGE_PATCHES = 8; // ~16 s
const OUT = "data/edges.bin";
const dir = process.env.PATCHES_DIR ?? join(homedir(), ".cache/audio-embed-engine/patches");

const lines = async <T>(path: string) => (await readFile(path, "utf8")).split("\n").filter(Boolean).map((l) => JSON.parse(l) as T);

const audio = JSON.parse(await readFile("data/audio.json", "utf8")) as AudioIndex;
const whole = decodeVectors((await readFile("data/vectors.bin")).buffer as ArrayBuffer);
// The engine names a song by its ISRC, or by its Spotify id when it has none.
const engineKey = new Map((await lines<{ key: string; isrc: string | null }>("data/tracks.jsonl")).map((t) => [t.key, t.isrc?.toUpperCase() ?? t.key]));
const patches = new Map((await lines<{ key: string; start: number; n: number }>(join(dir, "index.jsonl"))).map((p) => [p.key, p]));

const file = await open(join(dir, "patches.f32"));
const { dim } = whole;
/** The unit mean of `count` moment vectors starting at row `start`. */
async function mean(start: number, count: number) {
  const { buffer } = await file.read(Buffer.alloc(count * dim * 4), 0, count * dim * 4, start * dim * 4);
  const rows = new Float32Array(buffer.buffer, buffer.byteOffset, count * dim);
  const out = new Float32Array(dim);
  for (let i = 0; i < rows.length; i++) out[i % dim]! += rows[i]!;
  const norm = Math.hypot(...out) || 1;
  return out.map((x) => x / norm);
}

const rows: Float32Array[] = [];
let missing = 0;
for (const [i, id] of audio.ids.entries()) {
  const song = patches.get(engineKey.get(id) ?? id);
  if (song && song.n > 0) {
    const count = Math.min(EDGE_PATCHES, song.n);
    rows.push(await mean(song.start, count), await mean(song.start + song.n - count, count));
  } else {
    missing++;
    const row = Float32Array.from(whole.q.subarray(i * dim, (i + 1) * dim), (q) => q * whole.scale[i]!);
    rows.push(row, row);
  }
}
await file.close();
await writeFile(OUT, encodeVectors(rows));
console.log(`${OUT}: ${audio.ids.length} songs, ${missing} without a full track (using the whole song instead)`);
