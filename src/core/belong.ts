// Checking a playlist against the rest of the library: sorted songs that probably belong in it but aren't
// there, and songs in it that probably don't belong.
import { positions, type AudioIndex, type Vectors } from "./audio.ts";
import type { SoundClassifier } from "./classifier.ts";
import type { Playlist } from "./library.ts";
import { additions, fits } from "./setlist.ts";

/** `score` runs from 0 (nothing like the playlist) to 1 (certainly belongs), for drawing a bar. */
export type Scored = { id: string; score: number };

type Evidence = {
  /** The playlist's classifier is used when it has one: it also knows lyrics and language, and scores each sorted song without having seen it. */
  classifier: SoundClassifier | undefined;
  /** The fallback for playlists too new or too small to have a classifier. */
  sound: { index: AudioIndex; vectors: Vectors } | undefined;
};

const clamp = (x: number) => Math.min(Math.max(x, 0), 1);

/**
 * Songs among `candidates` that aren't in the playlist but probably belong there, best first.
 * Without a classifier for the playlist they're the songs that sound closest to it.
 */
export function missing({ classifier, sound }: Evidence, playlist: Pick<Playlist, "id" | "trackIds">, candidates: Iterable<string>, limit: number): Scored[] {
  const members = new Set(playlist.trackIds);
  if (classifier?.fit(playlist.id)) {
    const out: Scored[] = [];
    for (const id of candidates) {
      const score = members.has(id) ? undefined : classifier.score(id, playlist.id);
      if (score !== undefined) out.push({ id, score: clamp(score) });
    }
    return out.sort((a, b) => b.score - a.score).slice(0, limit);
  }
  if (!sound) return [];
  const allowed = new Set(candidates);
  const { baseline } = sound.index;
  return additions({ ...sound, edges: undefined }, playlist.trackIds, (id) => allowed.has(id), limit).map(({ id, sim }) => ({
    id,
    score: clamp((sim - baseline) / (1 - baseline)),
  }));
}

/**
 * The playlist's own songs, the ones least likely to belong first. Without a classifier for the playlist
 * that's the songs least like the rest of it by sound.
 */
export function doubted({ classifier, sound }: Evidence, playlist: Pick<Playlist, "id" | "trackIds">): Scored[] {
  const ids = [...new Set(playlist.trackIds)];
  let scored: Scored[] = [];
  if (classifier?.fit(playlist.id)) {
    scored = ids.flatMap((id) => {
      const score = classifier.score(id, playlist.id);
      return score === undefined ? [] : [{ id, score: clamp(score) }];
    });
  } else if (sound) {
    const { baseline } = sound.index;
    const pos = positions(sound.index);
    const known = ids.filter((id) => pos.has(id));
    const fit = fits({ ...sound, edges: undefined }, known);
    scored = known.map((id, i) => ({ id, score: clamp((fit[i]! - baseline) / (1 - baseline)) }));
  }
  return scored.sort((a, b) => a.score - b.score);
}
