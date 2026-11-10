// Builds the lyric search index from the engine's fetched lyrics. Passages already in the index keep
// their vectors, so adding songs later only embeds the new text.
//
// Lyrics: LYRICS_FILE in .env, or by default the engine's cache.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { passagesOf } from "../core/lyrics.ts";
import { INDEX_TEXT, INDEX_VECTORS, MODEL, loadEmbedder, loadIndex, type IndexText } from "./lyricModel.ts";

const BATCH = 32;
const file = process.env.LYRICS_FILE ?? join(homedir(), ".cache/audio-embed-engine/lyrics.jsonl");
const songs = (await readFile(file, "utf8"))
  .split("\n")
  .filter(Boolean)
  .map((line) => JSON.parse(line) as { key: string; status: string; plain?: string })
  .filter((s) => s.status === "ok" && s.plain);

const keys: string[] = [];
const passages: string[] = [];
for (const song of songs)
  for (const passage of passagesOf(song.plain!)) {
    keys.push(song.key);
    passages.push(passage);
  }

const previous = await loadIndex();
const reusable = previous?.model === MODEL ? previous : null;
const previousRow = new Map(reusable?.passages.map((p, row) => [p, row]));
// Longest first, so similar lengths share a batch and little padding is computed.
const missing = [...new Set(passages)].filter((p) => !previousRow.has(p)).sort((a, b) => b.length - a.length);
console.log(`${songs.length} songs, ${passages.length} passages, ${missing.length} to embed`);

const embed = await loadEmbedder();
const fresh = new Map<string, Float32Array>();
let dim = reusable?.dim ?? 0;
const started = Date.now();
for (let i = 0; i < missing.length; i += BATCH) {
  const batch = missing.slice(i, i + BATCH);
  const out = await embed(batch, "passage");
  dim = out.length / batch.length;
  batch.forEach((p, b) => fresh.set(p, out.slice(b * dim, (b + 1) * dim)));
  if ((i / BATCH) % 25 === 0) console.log(`${i + batch.length}/${missing.length} (${Math.round((Date.now() - started) / 1000)}s)`);
}

const vectors = new Float32Array(passages.length * dim);
passages.forEach((p, row) => {
  const old = previousRow.get(p);
  vectors.set(fresh.get(p) ?? reusable!.vectors.subarray(old! * dim, (old! + 1) * dim), row * dim);
});

await mkdir("data", { recursive: true });
await writeFile(INDEX_VECTORS, Buffer.from(vectors.buffer));
await writeFile(INDEX_TEXT, JSON.stringify({ model: MODEL, dim, keys, passages } satisfies IndexText));
console.log(`Wrote ${INDEX_TEXT} and ${INDEX_VECTORS}. Restart \`pnpm dev\` to search the new index.`);
