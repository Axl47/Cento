// Builds data/audio.json (neighbors + 2D map layout) from audio-embed-engine vectors.
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
import type { AudioIndex } from "../core/audio.ts";

const NEIGHBORS = 50; // stored per track (some will be unsorted songs, which don't vote)
const LAYOUT_NEIGHBORS = 15; // used for the UMAP layout
const OUT = "data/audio.json";

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
  const hash = createHash("sha1").update(`${NEIGHBORS}:${LAYOUT_NEIGHBORS}\n`); // settings are part of the cache key
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

console.log("  layout (UMAP)…");
let seed = 7;
const umap = new UMAP({
  nComponents: 2,
  nNeighbors: LAYOUT_NEIGHBORS,
  minDist: 0.15,
  random: () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646,
});
umap.setPrecomputedKNN(
  nn.map((r) => r.slice(0, LAYOUT_NEIGHBORS)),
  sim.map((r) => r.slice(0, LAYOUT_NEIGHBORS).map((s) => 1 - s)),
);
const raw = umap.fit(rows.map((r) => Array.from(r)));

// Center and scale into [-1, 1].
const mean = [0, 1].map((d) => raw.reduce((s, p) => s + p[d]!, 0) / raw.length);
const scale = Math.max(...raw.flatMap((p) => [Math.abs(p[0]! - mean[0]!), Math.abs(p[1]! - mean[1]!)])) || 1;
const xy = raw.map((p) => [0, 1].map((d) => Math.round(((p[d]! - mean[d]!) / scale) * 10000) / 10000) as [number, number]);

const index: AudioIndex & { sourceHash: string } = {
  model: process.env.ENGINE_MODEL ?? "unknown",
  ids,
  xy,
  nn,
  sim,
  sourceHash: hash,
};
await writeFile(OUT, JSON.stringify(index));
console.log(`Wrote ${OUT} in ${((performance.now() - started) / 1000).toFixed(1)}s`);
