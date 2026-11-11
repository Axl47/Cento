// The library on disk, shared by the scripts and the host: data/library.json, the engine input data/tracks.jsonl,
// and the merges `pnpm merge-copies` made.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { restoreDates, type Merge } from "../core/dedupe.ts";
import { syncLibrary, type Library, type Track } from "../core/library.ts";
import type { SpotifyClient } from "../core/spotify.ts";

export const LIBRARY_PATH = "data/library.json";
/** Merges `pnpm merge-copies` made (see src/core/dedupe.ts). */
export const MERGES_PATH = "data/merges.json";

export const loadLibrary = async (): Promise<Library> => JSON.parse(await readFile(LIBRARY_PATH, "utf8")) as Library;

export const loadMerges = (): Promise<Merge[]> =>
  readFile(MERGES_PATH, "utf8").then((s) => JSON.parse(s) as Merge[]).catch(() => []);

export async function saveLibrary(lib: Library) {
  await mkdir("data", { recursive: true });
  await writeFile(LIBRARY_PATH, JSON.stringify(lib));
}

const toJsonl = (tracks: Track[]) =>
  tracks
    .map((t) => JSON.stringify({ isrc: t.isrc, title: t.name, artists: t.artists.map((a) => a.name), durationMs: t.durationMs, key: t.id }))
    .join("\n") + "\n";

/** Refreshes data/library.json from Spotify (keeping merged songs' first-added dates) and writes data/tracks.jsonl. */
export async function exportLibrary(client: SpotifyClient, onProgress?: (message: string) => void): Promise<Library> {
  const lib = restoreDates(await syncLibrary(client, onProgress), await loadMerges());
  await saveLibrary(lib);
  await writeFile("data/tracks.jsonl", toJsonl(Object.values(lib.tracks)));
  return lib;
}
