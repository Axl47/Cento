// What the sound map can color songs by besides their playlist: a category per song for each mode, from its tags,
// features or release year. Pure; the map gives each category a color.
import { ERAS, TEMPOS } from "./feel.ts";
import type { SongFeatures } from "./features.ts";
import { MOODS, type SongTags } from "./tags.ts";

export const COLOR_BY = ["playlist", "mood", "tempo", "genre", "era"] as const;
export type ColorBy = (typeof COLOR_BY)[number];
export type CategoryMode = Exclude<ColorBy, "playlist">;

/** What a song's category is read from; any part can be missing. */
export type SongTraits = { tags?: SongTags; features?: SongFeatures; year?: number };

/** A mood colors a song once the tagger gives it at least an even chance (as in feel.ts). */
const MOOD_MIN = 0.5;
/** Genres the tagger hands out as catch-alls, so a song's next genre says more. */
const CATCH_ALL = new Set(["Cloud Rap", "K-pop"]);
/** How many genres get a color: the ones that lead the most songs. */
export const TOP_GENRES = 10;

const capitalize = (s: string) => s[0]!.toUpperCase() + s.slice(1);

/** A song's category in an ordered or fixed-list mode, or null when it has none (or the data to tell). */
function categoryOf(mode: Exclude<CategoryMode, "genre">, song: SongTraits): string | null {
  switch (mode) {
    case "mood": {
      const [mood, p] = MOODS.map((m) => [m, song.tags?.moods[m] ?? 0] as const).reduce((a, b) => (b[1] > a[1] ? b : a));
      return p >= MOOD_MIN ? capitalize(mood) : null;
    }
    case "tempo": {
      const bpm = song.features?.steady ? song.features.bpm : null;
      if (!bpm) return null;
      const band = Object.entries(TEMPOS).find(([, [from, to]]) => bpm >= from && bpm < to)?.[0];
      return band ? `${band} BPM` : null;
    }
    case "era": {
      const year = song.year;
      if (!year) return null;
      return Object.entries(ERAS).find(([, [from, before]]) => year >= from && year < before)?.[0] ?? null;
    }
  }
}

/** A song's likeliest genre that isn't a catch-all. */
const topGenre = (song: SongTraits) => song.tags?.genres.find(([name]) => !CATCH_ALL.has(name))?.[0] ?? null;

/**
 * Each song's category in `mode` (songs with none are left out) and the categories in legend order: slow to fast
 * and old to new for tempo and era, the most common first for genre.
 */
export function categorize(mode: CategoryMode, ids: readonly string[], traitsOf: (id: string) => SongTraits) {
  const of = new Map<string, string>();
  if (mode === "genre") {
    const top = new Map(ids.map((id) => [id, topGenre(traitsOf(id))]));
    const counts = new Map<string, number>();
    for (const g of top.values()) if (g) counts.set(g, (counts.get(g) ?? 0) + 1);
    const categories = [...counts].sort((a, b) => b[1] - a[1]).slice(0, TOP_GENRES).map(([g]) => g);
    const kept = new Set(categories);
    for (const [id, g] of top) if (g && kept.has(g)) of.set(id, g);
    return { categories, of };
  }
  for (const id of ids) {
    const c = categoryOf(mode, traitsOf(id));
    if (c) of.set(id, c);
  }
  const categories =
    mode === "mood" ? MOODS.map(capitalize) : mode === "tempo" ? Object.keys(TEMPOS).map((t) => `${t} BPM`) : Object.keys(ERAS).toReversed();
  return { categories, of };
}
