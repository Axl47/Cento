// Builds data/audio.json (neighbors + 2D map layout) and data/vectors.bin (the vectors, 8-bit)
// from Stemma vectors.
//
//   pnpm audio                     run the engine on data/tracks.jsonl, then build the index
//   pnpm audio --vectors <file>    build from an existing vectors JSONL, skipping the engine
//
// The engine caches embeddings itself, so re-running only embeds new tracks. This script
// skips its own work too when the vectors haven't changed since the last build.
// Engine commands come from .env (run with cwd = ENGINE_DIR; {input}/{output} are filled in):
//   ENGINE_DIR, ENGINE_EMBED, ENGINE_EXPORT, ENGINE_MODEL (label only)
import { createHash } from "node:crypto";
import { execSync } from "node:child_process";
import { createReadStream } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import { UMAP } from "umap-js";
import { encodeVectors, type AudioIndex } from "../core/audio.ts";

const NEIGHBORS = 50; // stored per track (some will be unsorted songs, which don't vote)
const LAYOUT_NEIGHBORS = 15; // used for the UMAP layout
const OUT = "data/audio.json";
const VECTORS_OUT = "data/vectors.bin";
const FORMAT = 3; // bump when the outputs change shape, so the cache below rebuilds them

type VectorLine = { key: string; status: string; vector?: number[] };

const arg = (name: string) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

function runEngine(): string {
  const { ENGINE_DIR, ENGINE_EMBED, ENGINE_EXPORT } = process.env;
  if (!ENGINE_DIR || !ENGINE_EMBED || !ENGINE_EXPORT)
    throw new Error("Set ENGINE_DIR, ENGINE_EMBED and ENGINE_EXPORT in .env, or pass --vectors <file>");
  const input = resolve("data/tracks.jsonl");
  const output = resolve("data/vectors.jsonl");
  const fill = (cmd: string) => cmd.replaceAll("{input}", input).replaceAll("{output}", output);
  for (const cmd of [ENGINE_EMBED, ENGINE_EXPORT]) {
    console.log(`$ ${fill(cmd)}`);
    execSync(fill(cmd), { cwd: ENGINE_DIR, stdio: "inherit" });
  }
  return output;
}

async function readVectors(path: string) {
  const ids: string[] = [];
  const rows: Float32Array[] = [];
  const hash = createHash("sha1").update(`${FORMAT}:${NEIGHBORS}:${LAYOUT_NEIGHBORS}\n`); // settings are part of the cache key
  const statuses = new Map<string, number>();
  for await (const line of createInterface({ input: createReadStream(path) })) {
    if (!line.trim()) continue;
    hash.update(line);
    const v = JSON.parse(line) as VectorLine;
    statuses.set(v.status, (statuses.get(v.status) ?? 0) + 1);
    if (!v.vector) continue;
    const row = Float32Array.from(v.vector);
    const norm = Math.hypot(...row) || 1; // re-normalize defensively
    for (let i = 0; i < row.length; i++) row[i]! /= norm;
    ids.push(v.key);
    rows.push(row);
  }
  return { ids, rows, hash: hash.digest("hex"), statuses };
}

/** Exact top-K cosine neighbors (vectors are unit length, so dot product = cosine). */
function nearest(rows: Float32Array[], k: number) {
  const n = rows.length;
  const nn: number[][] = [];
  const sim: number[][] = [];
  for (let i = 0; i < n; i++) {
    const a = rows[i]!;
    // Running top-k, kept sorted descending (insertion; k is small).
    const topJ: number[] = [];
    const topD: number[] = [];
    for (let j = 0; j < n; j++) {
      if (j === i) continue;
      const b = rows[j]!;
      let d = 0;
      for (let x = 0; x < a.length; x++) d += a[x]! * b[x]!;
      if (topD.length === k && d <= topD[k - 1]!) continue;
      let at = topD.length;
      while (at > 0 && topD[at - 1]! < d) at--;
      topD.splice(at, 0, d);
      topJ.splice(at, 0, j);
      if (topD.length > k) (topD.pop(), topJ.pop());
    }
    nn.push(topJ);
    sim.push(topD.map((d) => Math.round(d * 1000) / 1000));
    if (i % 500 === 0) process.stdout.write(`\r  neighbors ${i}/${n}`);
  }
  process.stdout.write(`\r  neighbors ${n}/${n}\n`);
  return { nn, sim };
}

/** Median cosine of random pairs (seeded): how alike two unrelated songs are. */
function baselineSimilarity(rows: Float32Array[], samples = 20_000) {
  let seed = 11;
  const rand = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
  const sims: number[] = [];
  for (let t = 0; t < samples; t++) {
    const a = rows[Math.floor(rand() * rows.length)]!;
    const b = rows[Math.floor(rand() * rows.length)]!;
    if (a === b) continue;
    let d = 0;
    for (let x = 0; x < a.length; x++) d += a[x]! * b[x]!;
    sims.push(d);
  }
  return Math.round(sims.sort((x, y) => x - y)[sims.length >> 1]! * 1000) / 1000;
}

const vectorsPath = arg("--vectors") ?? runEngine();
const { ids, rows, hash, statuses } = await readVectors(vectorsPath);
console.log(`Vectors: ${ids.length} tracks · statuses: ${[...statuses].map(([s, c]) => `${s} ${c}`).join(", ")}`);

const previous = await readFile(OUT, "utf8")
  .then((s) => JSON.parse(s) as AudioIndex & { sourceHash?: string })
  .catch(() => undefined);
if (previous?.sourceHash === hash) {
  console.log(`${OUT} is already up to date.`);
  process.exit(0);
}

const started = performance.now();
const { nn, sim } = nearest(rows, NEIGHBORS);

// Copies of one recording (the same song on a single, an EP and an album) have identical vectors. Lay out each
// recording once, so its copies share a point instead of UMAP scattering them, and don't spend each other's
// layout neighbors on themselves.
const songOf: number[] = [];
const songs: number[] = []; // song -> its first track
const seen = new Map<string, number>();
rows.forEach((row, i) => {
  const key = Buffer.from(row.buffer).toString("base64");
  let song = seen.get(key);
  if (song === undefined) seen.set(key, (song = songs.push(i) - 1));
  songOf.push(song);
});
// Each song's layout neighbors: its first track's neighbors as songs, without itself or repeats.
const songNn = songs.map((i, song) => {
  const out: number[] = [];
  const dist: number[] = [];
  nn[i]!.forEach((j, k) => {
    const s = songOf[j]!;
    if (s === song || out.includes(s) || out.length === LAYOUT_NEIGHBORS) return;
    out.push(s);
    dist.push(1 - sim[i]![k]!);
  });
  return { out, dist };
});
console.log(`  layout (UMAP) of ${songs.length} recordings…`);
let seed = 7;
const umap = new UMAP({
  nComponents: 2,
  nNeighbors: LAYOUT_NEIGHBORS,
  minDist: 0.15,
  random: () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646,
});
umap.setPrecomputedKNN(
  songNn.map((n) => n.out),
  songNn.map((n) => n.dist),
);
const raw = umap.fit(songs.map((i) => Array.from(rows[i]!)));

// Center and scale into [-1, 1].
const mean = [0, 1].map((d) => raw.reduce((s, p) => s + p[d]!, 0) / raw.length);
const scale = Math.max(...raw.flatMap((p) => [Math.abs(p[0]! - mean[0]!), Math.abs(p[1]! - mean[1]!)])) || 1;
const songXy = raw.map((p) => [0, 1].map((d) => Math.round(((p[d]! - mean[d]!) / scale) * 10000) / 10000) as [number, number]);

const index: AudioIndex & { sourceHash: string } = {
  model: process.env.ENGINE_MODEL ?? "unknown",
  ids,
  xy: songOf.map((song) => songXy[song]!),
  nn,
  sim,
  baseline: baselineSimilarity(rows),
  sourceHash: hash,
};
await writeFile(VECTORS_OUT, encodeVectors(rows));
await writeFile(OUT, JSON.stringify(index));
console.log(`Wrote ${OUT} in ${((performance.now() - started) / 1000).toFixed(1)}s`);
