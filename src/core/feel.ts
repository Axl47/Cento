// Finding songs by feel: mood, genre, tempo, vocals, language and era, from each song's tags and features.
import type { Vectors } from "./audio.ts";
import type { SongFeatures } from "./features.ts";
import type { SongTags } from "./tags.ts";

/** Tempo bands over the 80–160 BPM that every song's tempo is moved into, so half and double time land in the same band. */
export const TEMPOS = { "<100": [0, 100], "100–130": [100, 130], "130+": [130, Infinity] } as const;
export type Tempo = keyof typeof TEMPOS;

/** Release years, as [from, before). */
export const ERAS = { "2020s": [2020, Infinity], "2010s": [2010, 2020], "2000s": [2000, 2010], "Before 2000": [0, 2000] } as const;
export type Era = keyof typeof ERAS;

export type Feel = {
  /** Every one of these moods has to be likely. */
  moods: string[];
  genre: string | null;
  tempo: Tempo | null;
  instrumental: boolean;
  /** A language code, as in data/languages.jsonl. */
  language: string | null;
  era: Era | null;
};

export const ANY_FEEL: Feel = { moods: [], genre: null, tempo: null, instrumental: false, language: null, era: null };

export const hasFeel = (feel: Feel) => feel.moods.length > 0 || !!feel.genre || !!feel.tempo || feel.instrumental || !!feel.language || !!feel.era;

/** A mood counts once the tagger gives it at least an even chance; a genre, which shares its probability with 400 others, far less. */
const MOOD_MIN = 0.5;
const GENRE_MIN = 0.1;
/** A song with vocals in less than this share of it counts as instrumental. */
const INSTRUMENTAL = 0.05;

/**
 * How strongly a song has the feel: 0 when it lacks any part of it (or the data to tell), otherwise up to 1,
 * higher the surer its moods and genre are.
 */
export function feelMatch(feel: Feel, song: { features?: SongFeatures; tags?: SongTags; language?: string; year?: number }): number {
  let match = 1;
  for (const mood of feel.moods) {
    const p = song.tags?.moods[mood] ?? 0;
    if (p < MOOD_MIN) return 0;
    match *= p;
  }
  if (feel.genre) {
    const p = song.tags?.genres.find(([name]) => name === feel.genre)?.[1] ?? 0;
    if (p < GENRE_MIN) return 0;
    match *= p;
  }
  if (feel.tempo) {
    const [from, to] = TEMPOS[feel.tempo];
    const bpm = song.features?.steady ? song.features.bpm : null;
    if (!bpm || bpm < from || bpm >= to) return 0;
  }
  if (feel.instrumental && !(song.features && song.features.vocals < INSTRUMENTAL)) return 0;
  if (feel.language && song.language !== feel.language) return 0;
  if (feel.era) {
    const [from, before] = ERAS[feel.era];
    if (!song.year || song.year < from || song.year >= before) return 0;
  }
  return match;
}

/** How much any song sounds like the songs at `rows` taken together: the cosine between it and their average. */
export function likeness({ dim, scale, q }: Vectors, rows: number[]): (row: number) => number {
  const center = new Float32Array(dim);
  for (const r of rows) for (let i = 0; i < dim; i++) center[i]! += q[r * dim + i]! * scale[r]!;
  const norm = Math.hypot(...center) || 1;
  return (row) => {
    let dot = 0;
    for (let i = 0; i < dim; i++) dot += q[row * dim + i]! * center[i]!;
    return (dot * scale[row]!) / norm;
  };
}
