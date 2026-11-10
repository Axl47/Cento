// Which language each song is sung in (data/languages.jsonl, from the engine's `audio-embed languages`).
// Only songs with lyrics have one. Pure code, shared by the scripts and the app.
import type { Library, Playlist } from "./library.ts";

/** ISRC, or the track id if it has none -> language code. */
export type Languages = Map<string, string>;

export const parseLanguages = (jsonl: string): Languages =>
  new Map(
    jsonl
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const { key, language } = JSON.parse(line) as { key: string; language: string };
        return [key, language];
      }),
  );

const names = new Intl.DisplayNames(["en"], { type: "language" });

/** "es" -> "Spanish"; a code Intl doesn't recognize stays as it is. */
function languageName(code: string) {
  try {
    return names.of(code) ?? code;
  } catch {
    return code;
  }
}

export type PlaylistLanguages = {
  /** Songs whose language is known; the rest are instrumental or have no lyrics found. */
  detected: number;
  /** Most common first; `share` is of the detected songs. */
  shares: { name: string; songs: number; share: number }[];
};

export function playlistLanguages(languages: Languages, lib: Library, playlist: Pick<Playlist, "trackIds">): PlaylistLanguages {
  const counts = new Map<string, number>();
  for (const id of new Set(playlist.trackIds)) {
    const track = lib.tracks[id];
    const code = track && languages.get(track.isrc ?? track.id);
    if (code) counts.set(code, (counts.get(code) ?? 0) + 1);
  }
  const detected = [...counts.values()].reduce((sum, n) => sum + n, 0);
  const shares = [...counts].map(([code, songs]) => ({ name: languageName(code), songs, share: songs / detected })).sort((a, b) => b.songs - a.songs);
  return { detected, shares };
}
