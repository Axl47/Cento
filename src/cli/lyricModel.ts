// The meaning model and the index files. Node only: used by `pnpm lyrics` and the dev server's search,
// so passages and searches always go through exactly the same model.
import { readFile } from "node:fs/promises";
import { env, pipeline } from "@huggingface/transformers";
import type { LyricIndex } from "../core/lyrics.ts";

export const MODEL = "Xenova/multilingual-e5-base";
export const INDEX_TEXT = "data/lyrics-index.json";
export const INDEX_VECTORS = "data/lyrics-index.bin";

/** The JSON half of the index; the vectors are stored beside it as raw float32. */
export type IndexText = Pick<LyricIndex, "keys" | "passages" | "dim"> & { model: string };

env.cacheDir = ".cache/transformers";

/** Loads the model (a ~200 MB download the first time). The E5 models expect these two prefixes. */
export async function loadEmbedder() {
  const extract = await pipeline("feature-extraction", MODEL, { dtype: "q8" });
  return async (texts: string[], kind: "query" | "passage") => {
    const out = await extract(texts.map((t) => `${kind}: ${t}`), { pooling: "mean", normalize: true });
    return Float32Array.from(out.data as Float32Array);
  };
}

export async function loadIndex(): Promise<(LyricIndex & { model: string }) | null> {
  try {
    const text = JSON.parse(await readFile(INDEX_TEXT, "utf8")) as IndexText;
    const bytes = await readFile(INDEX_VECTORS);
    return { ...text, vectors: new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4) };
  } catch {
    return null;
  }
}
