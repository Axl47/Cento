// Merging copies of one recording: the same song saved from a single, an EP and the album is several Spotify
// tracks with identical audio. One copy (the main one) takes the place of the others in every playlist and in
// Liked Songs.
import type { Library } from "./library.ts";

/** The release a track copy comes from. */
export type Release = { albumType: string; releaseDate: string; totalTracks: number };

/** Albums first, then singles and EPs, then compilations (greatest hits and the like) last. */
const TYPE_RANK: Record<string, number> = { album: 0, single: 1, compilation: 2 };

/** The copy to keep: from a full album over a single or EP, then the newest release, then the biggest one. */
export function pickMain(copies: readonly string[], releases: ReadonlyMap<string, Release>): string {
  const rank = (id: string) => TYPE_RANK[releases.get(id)?.albumType ?? ""] ?? 3;
  return copies.toSorted((a, b) => {
    const [ra, rb] = [releases.get(a), releases.get(b)];
    return (
      rank(a) - rank(b) ||
      (rb?.releaseDate ?? "").localeCompare(ra?.releaseDate ?? "") ||
      (rb?.totalTracks ?? 0) - (ra?.totalTracks ?? 0)
    );
  })[0]!;
}

export type DedupePlan = {
  merges: { main: string; copies: string[] }[];
  /** playlistId -> tracks to add (main copies), then remove (the other copies). */
  playlists: Map<string, { add: string[]; remove: string[] }>;
  like: string[];
  unlike: string[];
};

/**
 * What it takes to keep only each group's main copy: wherever any copy is (a playlist not in `skip`, or Liked
 * Songs), the main one is added and the rest removed. `groups` are sets of tracks with identical audio.
 */
export function planDedupe(lib: Library, groups: readonly string[][], releases: ReadonlyMap<string, Release>, skip: readonly string[] = []): DedupePlan {
  const merges = groups.filter((g) => g.length > 1).map((g) => {
    const main = pickMain(g, releases);
    return { main, copies: g.filter((id) => id !== main) };
  });
  const replace = (has: ReadonlySet<string>) => {
    const add: string[] = [];
    const remove: string[] = [];
    for (const { main, copies } of merges) {
      const present = copies.filter((id) => has.has(id));
      if (!present.length) continue;
      if (!has.has(main)) add.push(main);
      remove.push(...present);
    }
    return { add, remove };
  };
  const playlists = new Map(
    lib.playlists
      .filter((p) => !skip.includes(p.id))
      .map((p) => [p.id, replace(new Set(p.trackIds))] as const)
      .filter(([, change]) => change.remove.length > 0),
  );
  const liked = replace(new Set(lib.liked.map((l) => l.id)));
  return { merges, playlists, like: liked.add, unlike: liked.remove };
}
