// The local snapshot of the Spotify library that every other script reads.
import { readFile } from "node:fs/promises";

export const LIBRARY_PATH = "data/library.json";

export type Track = {
  id: string;
  name: string;
  artists: { id: string; name: string }[];
  isrc: string | null;
  durationMs: number;
};

export type Playlist = {
  id: string;
  name: string;
  snapshotId: string;
  trackIds: string[];
};

export type Library = {
  fetchedAt: string;
  userId: string;
  /** Playlists the user can edit (owned or collaborative), i.e. sort targets. */
  playlists: Playlist[];
  liked: { id: string; addedAt: string }[];
  tracks: Record<string, Track>;
};

export const loadLibrary = async (path = LIBRARY_PATH): Promise<Library> =>
  JSON.parse(await readFile(path, "utf8")) as Library;

/**
 * The catch-all playlist that holds every song. It carries no sorting signal, so it is
 * never suggested. Picked by name via ALL_PLAYLIST, else the playlist covering the
 * largest share (>= 80%) of all tracks found in any playlist.
 */
export function findAllPlaylist(lib: Library, byName = process.env.ALL_PLAYLIST): Playlist | undefined {
  if (byName) return lib.playlists.find((p) => p.name === byName);
  const union = new Set(lib.playlists.flatMap((p) => p.trackIds));
  const largest = lib.playlists.toSorted((a, b) => b.trackIds.length - a.trackIds.length)[0];
  return largest && largest.trackIds.length / union.size >= 0.8 ? largest : undefined;
}
