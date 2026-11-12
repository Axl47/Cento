// The Playlists tab's work in progress: how each playlist is being split into groups. Kept in memory only, so
// switching playlists or tabs keeps it and a reload starts over.
import { create } from "zustand";

export type Group = {
  /** Stable across edits, for React keys. */
  key: number;
  /** Most typical song first. */
  ids: string[];
  /** What the user typed; null shows the default name. */
  name: string | null;
  /** What the group's lyrics are about, for a group made by lyrics. */
  theme?: string;
  /** Set when Save is clicked; the button shows Saving… while writes are pending. */
  saving?: boolean;
  saved?: boolean;
};

export type By = "sound" | "lyrics";

/** `unplaced` are the songs in no group: no sound yet (by sound), or no clear theme (by lyrics). */
export type Split = { by: By; k: number; groups: Group[]; unplaced: string[] };

let nextKey = 0;

/** Fresh groups (no name, not saved) for these song lists; `themes` is parallel to `lists`. */
export const groupsOf = (lists: string[][], themes?: string[]): Group[] => lists.map((ids, i) => ({ key: nextKey++, ids, name: null, theme: themes?.[i] }));

/** `split` with group `key` changed by `fn`; a group left with no songs is dropped. */
export const updateGroup = (split: Split, key: number, fn: (g: Group) => Partial<Group>): Split => ({
  ...split,
  groups: split.groups.map((g) => (g.key === key ? { ...g, ...fn(g) } : g)).filter((g) => g.ids.length > 0),
});

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

export const useWorkshop = create<WorkshopState>()((set) => ({
  splits: {},
  change: (playlistId, fn) => set((s) => ({ splits: { ...s.splits, [playlistId]: fn(s.splits[playlistId]) } })),
}));
