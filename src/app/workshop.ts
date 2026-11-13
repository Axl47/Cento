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

/** `split` without the songs that have left the playlist (`members` is what it holds now); the same object when none have. */
export const pruned = (split: Split, members: ReadonlySet<string>): Split => {
  const kept = (ids: string[]) => ids.filter((id) => members.has(id));
  if ([...split.groups.flatMap((g) => g.ids), ...split.unplaced].every((id) => members.has(id))) return split;
  return { ...split, groups: split.groups.map((g) => ({ ...g, ids: kept(g.ids) })).filter((g) => g.ids.length > 0), unplaced: kept(split.unplaced) };
};

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

export const useWorkshop = create<WorkshopState>()(
  persist(
    (set) => ({
      splits: {},
      change: (playlistId, fn) => set((s) => ({ splits: { ...s.splits, [playlistId]: fn(s.splits[playlistId]) } })),
    }),
    {
      name: "playlists-tab-splits",
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
