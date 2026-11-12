// What each song sounds like in words: genres and moods, from Essentia's pretrained taggers run on the engine's
// sound vectors (Stemma's bench/tags.py), condensed by `pnpm tags` into data/tags.json.

export type SongTags = {
  /** The song's likeliest genres, likeliest first, each with its probability. */
  genres: [name: string, p: number][];
  /** Mood name -> probability, for every mood in `MOODS`. */
  moods: Record<string, number>;
};

export type Tags = ReadonlyMap<string, SongTags>;
