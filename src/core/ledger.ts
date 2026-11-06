// The app's own record of the sorts it made (data/ledger.json). It's applied on top of every
// library the app loads or resyncs, so a sort is never forgotten because the local save was
// lost or because Spotify still returns the old state. An entry is dropped once a resync shows
// Spotify has it (or after a day, so changes you make in Spotify later aren't overridden).
import type { Library } from "./library.ts";

const MAX_AGE_MS = 24 * 60 * 60 * 1000;

export type LedgerEntry = {
  trackId: string;
  /** Playlists the song was added to (the all-songs playlist included). */
  added: string[];
  unliked: boolean;
  /** ISO time of the sort. */
  at: string;
};

/** `lib` with every entry's additions and unlikes applied (entries already reflected are no-ops). */
export function applyLedger(lib: Library, entries: readonly LedgerEntry[]): Library {
  if (entries.length === 0) return lib;
  const playlists = lib.playlists.map((p) => {
    const add = entries.filter((e) => e.added.includes(p.id) && !p.trackIds.includes(e.trackId)).map((e) => e.trackId);
    return add.length ? { ...p, trackIds: [...p.trackIds, ...new Set(add)] } : p;
  });
  const unliked = new Set(entries.filter((e) => e.unliked).map((e) => e.trackId));
  return { ...lib, playlists, liked: lib.liked.filter((l) => !unliked.has(l.id)) };
}

/** Entries that fresh Spotify data (`fresh`) doesn't show yet and that are less than a day old. */
export function unconfirmed(fresh: Library, entries: readonly LedgerEntry[], now = Date.now()): LedgerEntry[] {
  const inPlaylist = (playlistId: string, trackId: string) =>
    fresh.playlists.find((p) => p.id === playlistId)?.trackIds.includes(trackId) ?? false;
  const liked = new Set(fresh.liked.map((l) => l.id));
  return entries.filter((e) => {
    const confirmed = e.added.every((p) => inPlaylist(p, e.trackId)) && !(e.unliked && liked.has(e.trackId));
    return !confirmed && now - Date.parse(e.at) < MAX_AGE_MS;
  });
}
