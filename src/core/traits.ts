// What sets a group of songs apart from the rest of a bigger group it belongs to (a playlist within the library, or part of a
// playlist within the playlist), as a few short words: its genres, mood, tempo, loudness, vocals and language.
import { KEY_STRENGTH, type SongFeatures } from "./features.ts";
import type { Languages } from "./languages.ts";
import type { Library } from "./library.ts";
import type { SongTags, Tags } from "./tags.ts";

export type TraitData = {
  lib: Library;
  features: ReadonlyMap<string, SongFeatures> | null;
  languages: Languages | null;
  tags: Tags | null;
};

const MAX_TRAITS = 5;
/** A genre has to be this much more likely in the group than in the rest to describe it; a mood, which varies more, this much. */
const GENRE_LIFT = 0.06;
const MOOD_LIFT = 0.15;
const GENRES = 2;
/** Genres the tagger falls back on for songs it can't place, so they say nothing about a group. */
const CATCH_ALL = new Set(["Cloud Rap", "K-pop"]);
/** The middle tempo has to differ by this share to be worth saying. */
const TEMPO_GAP = 0.1;
/** Loudness has to differ by this many LU. */
const LOUDNESS_GAP = 1.5;
/** A song with vocals in less than this share of it counts as instrumental. */
const INSTRUMENTAL = 0.05;

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[xs.length >> 1];
const languageNames = new Intl.DisplayNames(["en"], { type: "language" });

/** The average probability of each tag over `ids` (songs without tags are skipped). */
function tagMeans(ids: string[], tagsOf: (id: string) => Iterable<[string, number]> | undefined) {
  const sums = new Map<string, number>();
  let songs = 0;
  for (const id of ids) {
    const tags = tagsOf(id);
    if (!tags) continue;
    songs++;
    for (const [name, p] of tags) sums.set(name, (sums.get(name) ?? 0) + p);
  }
  return new Map([...sums].map(([name, sum]) => [name, sum / songs]));
}

/** Tags clearly likelier in `ids` than in `among`, the biggest difference first. */
function lifted(ids: string[], among: string[], least: number, tagsOf: (id: string) => Iterable<[string, number]> | undefined) {
  const around = tagMeans(among, tagsOf);
  return [...tagMeans(ids, tagsOf)]
    .map(([name, p]) => ({ name, lift: p - (around.get(name) ?? 0) }))
    .filter((t) => t.lift >= least)
    .sort((a, b) => b.lift - a.lift)
    .map((t) => t.name);
}

/**
 * Up to five short words for how the songs `ids` differ from the rest of `all` (which includes them):
 * genres first, then mood, tempo, loudness, vocals and language. Empty when nothing sets them apart.
 */
export function traits({ lib, features, languages, tags }: TraitData, ids: string[], all: string[]): string[] {
  const inGroup = new Set(ids);
  const among = all.filter((id) => !inGroup.has(id));
  if (!among.length) return [];
  const out: string[] = [];
  if (tags) {
    const genres = (id: string) => tags.get(id)?.genres.filter(([name]) => !CATCH_ALL.has(name));
    out.push(...lifted(ids, among, GENRE_LIFT, genres).slice(0, GENRES));
    const moods = (id: string) => {
      const song = tags.get(id);
      return song && Object.entries(song.moods);
    };
    out.push(...lifted(ids, among, MOOD_LIFT, moods).slice(0, 1));
  }
  if (features) {
    const of = (list: string[]) => list.flatMap((id) => features.get(id) ?? []);
    const [mine, theirs] = [of(ids), of(among)];
    const tempo = (songs: SongFeatures[]) => median(songs.flatMap((f) => (f.steady && f.bpm ? [f.bpm] : [])));
    const [bpm, around] = [tempo(mine), tempo(theirs)];
    if (bpm && around && Math.abs(bpm / around - 1) >= TEMPO_GAP) out.push(`${Math.round(bpm)} BPM`);
    if (mine.length && theirs.length) {
      const louder = mean(mine.map((f) => f.lufs)) - mean(theirs.map((f) => f.lufs));
      if (Math.abs(louder) >= LOUDNESS_GAP) out.push(louder > 0 ? "louder" : "quieter");
      const instrumental = (songs: SongFeatures[]) => mean(songs.map((f) => (f.vocals < INSTRUMENTAL ? 1 : 0)));
      if (instrumental(mine) >= 0.5 && instrumental(theirs) < 0.5) out.push("instrumental");
    }
  }
  if (languages) {
    const shares = (list: string[]) => {
      const counts = new Map<string, number>();
      let known = 0;
      for (const id of list) {
        const track = lib.tracks[id];
        const code = track && languages.get(track.isrc ?? track.id);
        if (!code) continue;
        known++;
        counts.set(code, (counts.get(code) ?? 0) + 1);
      }
      return new Map([...counts].map(([code, n]) => [code, n / known]));
    };
    const around = shares(among);
    const top = [...shares(ids)].sort((a, b) => b[1] - a[1])[0];
    if (top && top[1] >= 0.6 && top[1] - (around.get(top[0]) ?? 0) >= 0.25) out.push(languageNames.of(top[0]) ?? top[0]);
  }
  return out.slice(0, MAX_TRAITS);
}

/** The artists with the most songs in `ids`, most first. */
export function topArtists(lib: Library, ids: string[], limit: number): string[] {
  const counts = new Map<string, number>();
  for (const id of ids) for (const artist of lib.tracks[id]?.artists ?? []) counts.set(artist.name, (counts.get(artist.name) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1]).slice(0, limit).map(([name]) => name);
}

/** A single song's genre has to be at least this likely to be named, and a mood this likely. */
const SONG_GENRE = 0.15;
const SONG_MOOD = 0.75;

/** One song in a few words: its likeliest genres, its strongest mood, its tempo when the beat is steady, and its key. */
export function songWords(tags: SongTags | undefined, features: SongFeatures | undefined): string[] {
  const out = (tags?.genres ?? []).filter(([name, p]) => p >= SONG_GENRE && !CATCH_ALL.has(name)).slice(0, GENRES).map(([name]) => name);
  const mood = Object.entries(tags?.moods ?? {}).sort((a, b) => b[1] - a[1])[0];
  if (mood && mood[1] >= SONG_MOOD) out.push(mood[0]);
  if (features?.steady && features.bpm) out.push(`${Math.round(features.bpm)} BPM`);
  if (features && features.keyStrength >= KEY_STRENGTH) out.push(features.key);
  return out;
}
