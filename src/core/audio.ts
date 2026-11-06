// The precomputed "sounds like" index (data/audio.json, built by `pnpm audio` from
// audio-embed-engine vectors): a 2D layout for the map and top-K neighbors per track.
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
};

export function neighborsFrom(index: AudioIndex): Neighbors {
  const pos = new Map(index.ids.map((id, i) => [id, i]));
  return (trackId) => {
    const i = pos.get(trackId);
    if (i === undefined) return [];
    return (index.nn[i] ?? []).map((j, k) => ({ id: index.ids[j]!, sim: index.sim[i]?.[k] ?? 0 }));
  };
}
