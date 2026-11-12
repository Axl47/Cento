// What each song sounds like in words: genres and moods, from Essentia's pretrained taggers run on the engine's
// sound vectors (Stemma's bench/tags.py), condensed by `pnpm tags` into data/tags.json.

export type SongTags = {
  /** The song's likeliest genres, likeliest first, each with its probability. */
  genres: [name: string, p: number][];
  /** Mood name -> probability, for every mood in `MOODS`. */
  moods: Record<string, number>;
};

export type Tags = ReadonlyMap<string, SongTags>;

/** data/tags.json: the genre and mood names once, then per library track id its genres (as indices into `genres`), their probabilities, and a probability per mood. */
export type TagsFile = {
  genres: string[];
  moods: string[];
  songs: Record<string, [genres: number[], probabilities: number[], moods: number[]]>;
};

export const decodeTags = (file: TagsFile): Tags =>
  new Map(
    Object.entries(file.songs).map(([id, [genres, probabilities, moods]]) => [
      id,
      {
        genres: genres.map((g, i): [string, number] => [file.genres[g]!, probabilities[i]!]),
        moods: Object.fromEntries(file.moods.map((name, i) => [name, moods[i]!])),
      },
    ]),
  );
