// Per-playlist sound classifiers (data/classifier.json, trained by `pnpm classify`): one score for
// each song and playlist. A sorted song's score comes from models that never saw that song or its
// artists; other songs are scored by a model trained on everything sorted.

export type ClassifierData = {
  /** The chance of belonging needed for an auto-check. */
  confidence: number;
  /** Spotify track ids; `scores` is parallel to this. */
  keys: string[];
  playlists: {
    id: string;
    /** How well sound separates this playlist from the rest, on new artists (0.5 is chance, 1 is perfect). */
    auc: number | null;
    /** The score at which sound alone can check this playlist; null if sound is never reliable enough. */
    cutoff: number | null;
  }[];
  /** songs x playlists */
  scores: number[][];
  /** For each song, the index in `playlists` that sound alone should check, if any. At most one per song. */
  picks: (number | null)[];
};

export type SoundClassifier = {
  /** Roughly the chance the song belongs (can stray slightly past 0 and 1); undefined if unscored. */
  score: (trackId: string, playlistId: string) => number | undefined;
  /** Whether this is the one playlist that sound alone should check for this song. */
  confident: (trackId: string, playlistId: string) => boolean;
  /** The playlist's reliability numbers, for showing why. */
  fit: (playlistId: string) => ClassifierData["playlists"][number] | undefined;
};

export function classifierFrom(data: ClassifierData): SoundClassifier {
  const row = new Map(data.keys.map((k, i) => [k, i]));
  const columns = new Map(data.playlists.map((p, i) => [p.id, i]));
  const score = (trackId: string, playlistId: string) => {
    const column = columns.get(playlistId);
    const r = row.get(trackId);
    return column === undefined || r === undefined ? undefined : data.scores[r]?.[column];
  };
  return {
    score,
    confident: (trackId, playlistId) => {
      const r = row.get(trackId);
      return r !== undefined && data.picks[r] != null && data.picks[r] === columns.get(playlistId);
    },
    fit: (playlistId) => data.playlists[columns.get(playlistId) ?? -1],
  };
}
