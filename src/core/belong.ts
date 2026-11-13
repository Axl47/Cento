// Checking a playlist against the rest of the library: sorted songs that probably belong in it but aren't
// there, and songs in it that probably don't belong.
import { positions, similarity, type AudioIndex, type Vectors } from "./audio.ts";
import type { SoundClassifier } from "./classifier.ts";
import type { Playlist } from "./library.ts";
import { additions, fits } from "./setlist.ts";

/** `score` runs from 0 (nothing like the playlist) to 1 (certainly belongs), for drawing a bar. */
export type Scored = { id: string; score: number };

export type Evidence = {
  /** The playlist's classifier is used when it has one: it also knows lyrics and language, and scores each sorted song without having seen it. */
  classifier: SoundClassifier | undefined;
  /** The fallback for playlists too new or too small to have a classifier. */
  sound: { index: AudioIndex; vectors: Vectors } | undefined;
  /**
   * For a playlist with an artist rule: whether a song is by one of its artists. Such a playlist wants exactly
   * those songs whatever they sound like, so the rule decides alone and every score is 1 (missing) or 0 (doubted).
   */
  byRule?: (id: string) => boolean;
};

const clamp = (x: number) => Math.min(Math.max(x, 0), 1);

/**
 * Songs among `candidates` that aren't in the playlist but probably belong there, best first.
 * Without a classifier for the playlist they're the songs that sound closest to it.
 */
export function missing({ classifier, sound, byRule }: Evidence, playlist: Pick<Playlist, "id" | "trackIds">, candidates: Iterable<string>, limit: number): Scored[] {
  const members = new Set(playlist.trackIds);
  if (byRule) return [...new Set(candidates)].filter((id) => !members.has(id) && byRule(id)).slice(0, limit).map((id) => ({ id, score: 1 }));
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
export function doubted({ classifier, sound, byRule }: Evidence, playlist: Pick<Playlist, "id" | "trackIds">): Scored[] {
  const ids = [...new Set(playlist.trackIds)];
  if (byRule) return ids.filter((id) => !byRule(id)).map((id) => ({ id, score: 0 }));
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

/** How many of a part's songs a song is compared with: its closest few, so it can fit one corner of the part. */
const CLOSEST = 3;

/** One of a playlist's parts, as `placements` needs it: its songs, and its artist rule if it has one. */
export type Part = Pick<Playlist, "id" | "trackIds"> & { byRule?: (id: string) => boolean };

/**
 * Where songs could go among a playlist's parts: for each of `ids`, the parts it sounds closest to, closest
 * first. Every part is scored the same way (the song's closest few songs in it, 0 to 1 from the random-pair
 * baseline), so the scores compare across parts whether or not a part is big enough to have a classifier.
 * A part with an artist rule takes exactly its artists' songs. Songs with no sound yet get only rule matches.
 */
export function placements(sound: NonNullable<Evidence["sound"]>, parts: readonly Part[], ids: readonly string[]): Map<string, { partId: string; score: number }[]> {
  const pos = positions(sound.index);
  const { baseline } = sound.index;
  const rows = parts.map((p) => p.trackIds.flatMap((id) => pos.get(id) ?? []));
  return new Map(
    ids.map((id) => {
      const row = pos.get(id);
      const scored = parts.flatMap((part, i) => {
        if (part.byRule) return part.byRule(id) ? [{ partId: part.id, score: 1 }] : [];
        if (row === undefined || rows[i]!.length === 0) return [];
        const closest = rows[i]!.map((member) => similarity(sound.vectors, row, member)).sort((a, b) => b - a).slice(0, CLOSEST);
        const mean = closest.reduce((sum, x) => sum + x, 0) / closest.length;
        return [{ partId: part.id, score: clamp((mean - baseline) / (1 - baseline)) }];
      });
      return [id, scored.sort((a, b) => b.score - a.score)] as const;
    }),
  );
}
