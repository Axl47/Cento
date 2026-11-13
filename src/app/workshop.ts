// The Playlists tab's work in progress: how each playlist is being split into groups. Kept in this browser, so
// switching playlists or tabs, or reloading, keeps it.
import { create } from "zustand";
import { persist } from "zustand/middleware";

export type Group = {
  /** Stable across edits, for React keys. */
  key: number;
  /** Most typical song first, after any moved in by hand. */
  ids: string[];
  /** What the user typed; null shows the default name. */
  name: string | null;
  /** What the group was made around, for a group made by lyrics (its theme) or by genre. */
  theme?: string;
  /** Set when Save is clicked; the button shows Saving… while writes are pending. */
  saving?: boolean;
  /** The playlist made from the group, once Spotify has created it. */
  playlistId?: string;
  /** The `signature` of what that playlist was last filled with; edits since then can be saved again. */
  savedAs?: string;
};

/** A name and songs as one string, to tell whether a group still matches what was saved. */
export const signature = (name: string, ids: string[]) => [name, ...ids].join("\n");
/** The songs in a `signature`. */
export const savedIds = (savedAs: string) => savedAs.split("\n").slice(1);

/**
 * What the playlist saved from a group should hold when the group is saved again: the group's songs, then the songs
 * the playlist gained elsewhere since the last save (`saved`), without the ones it lost elsewhere. `now` is what it holds.
 */
export function merged(group: readonly string[], saved: readonly string[], now: readonly string[]): string[] {
  const was = new Set(saved);
  const has = new Set(now);
  const mine = new Set(group);
  return [...group.filter((id) => !was.has(id) || has.has(id)), ...now.filter((id) => !was.has(id) && !mine.has(id))];
}

export type By = "sound" | "lyrics" | "genre";

/** `unplaced` are the songs in no group: no sound yet (by sound), no clear theme (by lyrics), or none of the genres (by genre). */
/** `rest` is set when only the playlist's songs in none of its parts were grouped. */
export type Split = { by: By; k: number; rest?: boolean; groups: Group[]; unplaced: string[] };

let nextKey = 0;

/** Fresh groups (no name, not saved) for these song lists; `themes` is parallel to `lists`. */
export const groupsOf = (lists: string[][], themes?: string[]): Group[] => lists.map((ids, i) => ({ key: nextKey++, ids, name: null, theme: themes?.[i] }));

/** `split` with group `key` changed by `fn`; a group left with no songs is dropped. */
export const updateGroup = (split: Split, key: number, fn: (g: Group) => Partial<Group>): Split => ({
  ...split,
  groups: split.groups.map((g) => (g.key === key ? { ...g, ...fn(g) } : g)).filter((g) => g.ids.length > 0),
});

/** `split` with song `id` taken out of its group and left in no group; a group it leaves empty is dropped. */
export const dropSong = (split: Split, id: string): Split => ({
  ...split,
  groups: split.groups.map((g) => ({ ...g, ids: g.ids.filter((x) => x !== id) })).filter((g) => g.ids.length > 0),
  unplaced: split.unplaced.includes(id) ? split.unplaced : [...split.unplaced, id],
});

/** `split` with song `id` moved to the top of group `key`, from another group or from the unplaced; a group it leaves empty is dropped. */
export function moveSong(split: Split, id: string, key: number): Split {
  const to = split.groups.find((g) => g.key === key);
  if (!to || to.ids.includes(id)) return split;
  const without = (g: Group) => (g.ids.includes(id) ? { ...g, ids: g.ids.filter((x) => x !== id) } : g);
  return {
    ...split,
    groups: split.groups.map((g) => (g.key === key ? { ...g, ids: [id, ...g.ids] } : without(g))).filter((g) => g.ids.length > 0),
    unplaced: split.unplaced.filter((x) => x !== id),
  };
}

/**
 * `split` brought in line with the library: songs that no longer belong leave their groups (`belongs` gets the group
 * a song is in, or none for an unplaced one), and a group whose saved playlist is gone (`exists`) is a draft again.
 * The same object when nothing changed.
 */
export function synced(split: Split, belongs: (id: string, group?: Group) => boolean, exists: (playlistId: string) => boolean): Split {
  const lost = (g: Group) => !!g.savedAs && !!g.playlistId && !exists(g.playlistId);
  if (split.groups.every((g) => !lost(g) && g.ids.every((id) => belongs(id, g))) && split.unplaced.every((id) => belongs(id))) return split;
  return {
    ...split,
    groups: split.groups
      .map((g) => {
        const { playlistId: _, savedAs: __, ...draft } = g;
        return { ...(lost(g) ? draft : g), ids: g.ids.filter((id) => belongs(id, g)) };
      })
      .filter((g) => g.ids.length > 0),
    unplaced: split.unplaced.filter((id) => belongs(id)),
  };
}

/** `split` with group `key` replaced, in its place, by fresh groups for `parts`. */
export const replaceGroup = (split: Split, key: number, parts: string[][]): Split => ({
  ...split,
  groups: split.groups.flatMap((g) => (g.key === key ? groupsOf(parts) : [g])),
});

type WorkshopState = {
  /** playlistId -> its split. */
  splits: Record<string, Split>;
  /** Changes a playlist's split, reading the latest one (callbacks that land after a Spotify write can't go stale). */
  change: (playlistId: string, fn: (split: Split | undefined) => Split) => void;
};

/** `splits` as a reload finds them: any save in flight died with the page, so no group is still saving. */
export const restored = (splits: Record<string, Split>): Record<string, Split> =>
  Object.fromEntries(Object.entries(splits).map(([id, split]) => [id, { ...split, groups: split.groups.map(({ saving: _, ...g }) => g) }]));

const STORED = "playlists-tab-splits";

export const useWorkshop = create<WorkshopState>()(
  persist(
    (set) => ({
      splits: {},
      change: (playlistId, fn) => set((s) => ({ splits: { ...s.splits, [playlistId]: fn(s.splits[playlistId]) } })),
    }),
    {
      name: STORED,
      partialize: ({ splits }) => ({ splits }),
      merge: (saved, current) => {
        const splits = restored((saved as Partial<Pick<WorkshopState, "splits">> | undefined)?.splits ?? {});
        // New groups take keys past the restored ones.
        nextKey = Math.max(nextKey, ...Object.values(splits).flatMap((split) => split.groups.map((g) => g.key + 1)));
        return { ...current, splits };
      },
    },
  ),
);

// Another tab's changes replace this tab's copy, instead of being overwritten by it on the next edit here.
if (typeof window !== "undefined") window.addEventListener("storage", (e) => e.key === STORED && void useWorkshop.persist.rehydrate());
