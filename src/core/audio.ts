// The precomputed "sounds like" index (data/audio.json, built by `pnpm audio` from
// Stemma vectors): a 2D layout for the map and top-K neighbors per track.
// data/vectors.bin holds the vectors themselves (8-bit), for exact similarity to any song.
import type { Neighbors } from "./suggest.ts";

export type AudioIndex = {
  model: string;
  /** Spotify track ids; every other array is parallel to this one. */
  ids: string[];
  /** 2D layout (UMAP), roughly in [-1, 1]. */
  xy: [number, number][];
  /** Indices into `ids` of each track's nearest neighbors, most similar first. */
  nn: number[][];
  /** Cosine similarity for each entry in `nn`. */
  sim: number[][];
  /** Median similarity of two random songs: anything at or below it doesn't really "sound like". */
  baseline: number;
};

/**
 * Unit vectors parallel to `AudioIndex.ids`, quantized to int8 with a scale per row.
 * File layout (little-endian): u32 n, u32 dim, f32 scale × n, i8 q × n·dim.
 */
export type Vectors = { dim: number; scale: Float32Array; q: Int8Array };

export function encodeVectors(rows: Float32Array[]): Uint8Array {
  const n = rows.length;
  const dim = rows[0]?.length ?? 0;
  const buf = new ArrayBuffer(8 + 4 * n + n * dim);
  const head = new DataView(buf);
  head.setUint32(0, n, true);
  head.setUint32(4, dim, true);
  const scale = new Float32Array(buf, 8, n);
  const q = new Int8Array(buf, 8 + 4 * n);
  rows.forEach((row, i) => {
    const s = row.reduce((m, x) => Math.max(m, Math.abs(x)), 0) / 127 || 1;
    scale[i] = s;
    for (let d = 0; d < dim; d++) q[i * dim + d] = Math.round(row[d]! / s);
  });
  return new Uint8Array(buf);
}

export function decodeVectors(buf: ArrayBuffer): Vectors {
  const head = new DataView(buf);
  const [n, dim] = [head.getUint32(0, true), head.getUint32(4, true)];
  return { dim, scale: new Float32Array(buf, 8, n), q: new Int8Array(buf, 8 + 4 * n, n * dim) };
}

/** Cosine similarity of the songs at two positions in the index. */
export function similarity({ dim, scale, q }: Vectors, i: number, j: number) {
  let dot = 0;
  for (let d = 0, a = i * dim, b = j * dim; d < dim; d++) dot += q[a + d]! * q[b + d]!;
  return dot * scale[i]! * scale[j]!;
}

/** Songs among `candidates` most similar to `trackId`, best first, keeping only those above the baseline. */
export function closestAmong(index: AudioIndex, v: Vectors, trackId: string, candidates: Iterable<string>, limit: number) {
  const pos = positions(index);
  const i = pos.get(trackId);
  if (i === undefined) return [];
  const out: { id: string; sim: number }[] = [];
  for (const id of candidates) {
    const j = pos.get(id);
    if (j === undefined || j === i) continue;
    const sim = similarity(v, i, j);
    if (sim > index.baseline) out.push({ id, sim });
  }
  return out.sort((a, b) => b.sim - a.sim).slice(0, limit);
}

/** How many songs "the songs nearest by sound" means, here and on the map. */
export const NEAREST = 15;

/** A song's nearest sorted songs, most similar first: the ones with a playlist to compare it against. */
export const nearestSorted = (neighbors: Neighbors, sorted: ReadonlyMap<string, string>, trackId: string) =>
  neighbors(trackId).filter((n) => sorted.has(n.id)).slice(0, NEAREST);

const positionCache = new WeakMap<AudioIndex, Map<string, number>>();
export const positions = (index: AudioIndex) => {
  let pos = positionCache.get(index);
  if (!pos) positionCache.set(index, (pos = new Map(index.ids.map((id, i) => [id, i]))));
  return pos;
};

export function neighborsFrom(index: AudioIndex): Neighbors {
  const pos = positions(index);
  return (trackId) => {
    const i = pos.get(trackId);
    if (i === undefined) return [];
    return (index.nn[i] ?? []).map((j, k) => ({ id: index.ids[j]!, sim: index.sim[i]?.[k] ?? 0 }));
  };
}
