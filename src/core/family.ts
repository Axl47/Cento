// Playlist families: "Future Bass is part of EDM". A part's songs all belong in the playlist it's part of, so
// sorting a song into a part also puts it in that playlist, and a song that's only in the part is a stray to fix.
// Saved in data/parents.json as part -> the playlists it's part of.
import type { Playlist } from "./library.ts";

/** playlistId -> the playlists it's a part of. */
export type Parents = Record<string, string[]>;

/** Every playlist `id` is part of, directly or through another part. */
export function ancestors(parents: Parents, id: string): string[] {
  const out: string[] = [];
  const visit = (child: string) => {
    for (const p of parents[child] ?? []) {
      if (p === id || out.includes(p)) continue;
      out.push(p);
      visit(p);
    }
  };
  visit(id);
  return out;
}

/** `ids` plus every playlist they're part of, in the same order with the added ones last. */
export const withAncestors = (parents: Parents, ids: readonly string[]): string[] => [...new Set([...ids, ...ids.flatMap((id) => ancestors(parents, id))])];

/** playlistId -> its direct parts. */
export function partsOf(parents: Parents): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const [child, ps] of Object.entries(parents)) for (const p of ps) out.set(p, [...(out.get(p) ?? []), child]);
  return out;
}

/** `parents` with `child` made a part of `parent` (or no longer one). Refused, returning the same object, if it would make a loop. */
export function setPart(parents: Parents, child: string, parent: string, on: boolean): Parents {
  const current = parents[child] ?? [];
  if (on === current.includes(parent)) return parents;
  if (on && (child === parent || ancestors(parents, parent).includes(child))) return parents;
  const next = on ? [...current, parent] : current.filter((p) => p !== parent);
  const { [child]: _, ...rest } = parents;
  return next.length ? { ...rest, [child]: next } : rest;
}

/** `parents` without playlists that no longer exist. The same object when nothing changed. */
export function knownParents(parents: Parents, exists: (id: string) => boolean): Parents {
  const entries = Object.entries(parents).flatMap(([child, ps]) => {
    const kept = ps.filter(exists);
    return exists(child) && kept.length ? [[child, kept] as const] : [];
  });
  const same = entries.length === Object.keys(parents).length && entries.every(([child, ps]) => ps.length === parents[child]?.length);
  return same ? parents : Object.fromEntries(entries);
}

type Songs = Pick<Playlist, "id" | "trackIds">;

/** The songs of `part` that `whole` doesn't hold. */
export function strays(part: Songs, whole: Songs): string[] {
  const held = new Set(whole.trackIds);
  return part.trackIds.filter((id) => !held.has(id));
}

/** The songs of `whole` that none of its `parts` hold. */
export function unplaced(whole: Songs, parts: readonly Songs[]): string[] {
  const placed = new Set(parts.flatMap((p) => p.trackIds));
  return whole.trackIds.filter((id) => !placed.has(id));
}

/** A playlist that could be a part of another: how many of its songs that one already holds. */
export type Candidate = { id: string; shared: number; size: number };

/** Parts smaller than this are too small to tell overlap from coincidence. */
const MIN_CANDIDATE = 5;
/** The share of a playlist's songs the bigger one must already hold to be offered as a likely part. */
export const LIKELY_PART = 0.5;

/**
 * Playlists among `others` that look like parts of `whole`: smaller than it, with at least LIKELY_PART of their
 * songs already in it. Most contained first. Its current parts, and anything it's part of itself, are left out.
 */
export function likelyParts(parents: Parents, whole: Songs, others: readonly Songs[]): Candidate[] {
  const held = new Set(whole.trackIds);
  const above = new Set(ancestors(parents, whole.id));
  return others
    .filter((p) => p.id !== whole.id && !above.has(p.id) && !parents[p.id]?.includes(whole.id))
    .filter((p) => p.trackIds.length >= MIN_CANDIDATE && p.trackIds.length < whole.trackIds.length)
    .map((p) => ({ id: p.id, size: p.trackIds.length, shared: p.trackIds.filter((id) => held.has(id)).length }))
    .filter((c) => c.shared >= LIKELY_PART * c.size)
    .sort((a, b) => b.shared / b.size - a.shared / a.size || b.size - a.size);
}

/**
 * Playlists among `others` that `part` looks like a part of: bigger than it, already holding at least LIKELY_PART of
 * its songs. Most of it held first, then the smaller (closer-fitting) playlist. What it's already part of, and its
 * own parts, are left out. `shared` and `size` are still about `part`'s songs.
 */
export function likelyWholes(parents: Parents, part: Songs, others: readonly Songs[]): Candidate[] {
  if (part.trackIds.length < MIN_CANDIDATE) return [];
  const above = new Set(ancestors(parents, part.id));
  const sizes = new Map(others.map((p) => [p.id, p.trackIds.length]));
  return others
    .filter((p) => p.id !== part.id && !above.has(p.id) && !ancestors(parents, p.id).includes(part.id) && p.trackIds.length > part.trackIds.length)
    .map((p) => {
      const held = new Set(p.trackIds);
      return { id: p.id, size: part.trackIds.length, shared: part.trackIds.filter((id) => held.has(id)).length };
    })
    .filter((c) => c.shared >= LIKELY_PART * c.size)
    .sort((a, b) => b.shared - a.shared || sizes.get(a.id)! - sizes.get(b.id)!);
}
