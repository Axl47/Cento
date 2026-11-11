// Merging copies of one recording: the same song saved from a single, an EP and the album is several Spotify
// tracks with identical audio. One copy (the main one) takes the place of the others in every playlist and in
// Liked Songs. Each merge is logged in data/merges.json with the dates its copies were first added, so a resync
// keeps those instead of the day of the merge.
import type { Library } from "./library.ts";

/** The release a track copy comes from, and whether the copy is the explicit (uncensored) one. */
export type Release = { albumType: string; releaseDate: string; totalTracks: number; explicit: boolean };

/** Albums first, then singles and EPs, then compilations (greatest hits and the like) last. */
const TYPE_RANK: Record<string, number> = { album: 0, single: 1, compilation: 2 };

/**
 * The copy to keep: explicit over clean (a clean edit sounds the same to the vectors), then from a full album over a
 * single or EP, then the newest release, then the biggest one.
 */
export function pickMain(copies: readonly string[], releases: ReadonlyMap<string, Release>): string {
  const rank = (id: string) => TYPE_RANK[releases.get(id)?.albumType ?? ""] ?? 3;
  return copies.toSorted((a, b) => {
    const [ra, rb] = [releases.get(a), releases.get(b)];
    return (
      +(rb?.explicit ?? false) - +(ra?.explicit ?? false) ||
      rank(a) - rank(b) ||
      (rb?.releaseDate ?? "").localeCompare(ra?.releaseDate ?? "") ||
      (rb?.totalTracks ?? 0) - (ra?.totalTracks ?? 0)
    );
  })[0]!;
}

/** One merge, as logged: `addedAt` maps a playlist id, or "liked", to when any copy first arrived there. */
export type Merge = { main: string; copies: string[]; addedAt: Record<string, string>; at?: string };

export type DedupePlan = {
  merges: Merge[];
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
  const places = [
    ...lib.playlists.filter((p) => !skip.includes(p.id)).map((p) => [p.id, p.addedAt ?? {}] as const),
    ["liked", Object.fromEntries(lib.liked.map((l) => [l.id, l.addedAt]))] as const,
  ];
  const merges = groups.filter((g) => g.length > 1).map((g): Merge => {
    const main = pickMain(g, releases);
    const addedAt: Record<string, string> = {};
    for (const [place, dates] of places) {
      const first = g.map((id) => dates[id]).filter((d) => !!d).sort()[0];
      if (first) addedAt[place] = first;
    }
    return { main, copies: g.filter((id) => id !== main), addedAt };
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

/** `lib` with each merged song's added dates set back to the logged ones (only ever earlier), wherever it still is. */
export function restoreDates(lib: Library, log: readonly Merge[]): Library {
  if (log.length === 0) return lib;
  const earlier = (place: string, id: string, current: string | undefined) => {
    const logged = log.find((m) => m.main === id && m.addedAt[place])?.addedAt[place];
    return logged && (!current || logged < current) ? logged : current;
  };
  const playlists = lib.playlists.map((p) => {
    const addedAt = { ...p.addedAt };
    for (const m of log) {
      const at = p.trackIds.includes(m.main) ? earlier(p.id, m.main, addedAt[m.main]) : undefined;
      if (at) addedAt[m.main] = at;
    }
    return { ...p, addedAt };
  });
  const liked = lib.liked.map((l) => ({ ...l, addedAt: earlier("liked", l.id, l.addedAt) ?? l.addedAt }));
  return { ...lib, playlists, liked };
}
