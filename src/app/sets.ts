// The Build tab's sets: lists of songs being made into a playlist. They live in this browser (one current set
// plus any split off from it), so a reload keeps the work; each set's undo history lasts until the reload.
import { create } from "zustand";
import type { Track } from "../core/library.ts";

export type BuildSet = {
  id: string;
  name: string;
  ids: string[];
  /** Songs that keep their slot when the set is smoothed. */
  pinned: string[];
  /** Songs that aren't in the library, as Spotify returned them. */
  extra: Record<string, Track>;
  /** The Spotify playlist it was saved as, and what it held then. */
  saved?: { playlistId: string; ids: string[]; name: string };
};

/** The part of a set that undo restores. */
export type Contents = Pick<BuildSet, "ids" | "pinned" | "extra">;

const KEY = "build-sets-v1";
const UNDO_LIMIT = 50;
export const DEFAULT_NAME = "New set";

const blank = (name = DEFAULT_NAME, contents: Contents = { ids: [], pinned: [], extra: {} }): BuildSet => ({
  id: crypto.randomUUID(),
  name,
  ...contents,
});

function read(): { sets: BuildSet[]; currentId: string } {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? "null") as { sets: BuildSet[]; currentId: string } | null;
    if (saved?.sets.some((s) => s.id === saved.currentId)) return saved;
  } catch {
    // Unreadable or blocked storage starts fresh.
  }
  const first = blank();
  return { sets: [first], currentId: first.id };
}

type SetsState = {
  sets: BuildSet[];
  currentId: string;
  /** Earlier contents of each set, latest last. */
  history: Record<string, Contents[]>;

  /** Changes the current set's songs, remembering what they were for `undo`. */
  change: (fn: (s: Contents) => Partial<Contents>) => void;
  undo: () => void;
  rename: (name: string) => void;
  /** Opens another set; an empty set left behind is dropped. */
  select: (id: string) => void;
  /** Starts an empty set and opens it. */
  add: () => void;
  /** Moves `moved` out of the current set into a new set beside it. Undo can't bring them back, since they now live there. */
  split: (moved: string[]) => void;
  /** Starts a set holding these songs and opens it. */
  open: (name: string, ids: string[]) => void;
  /** Records that set `setId` was saved as `playlistId` holding these songs under this name. */
  markSaved: (setId: string, saved: NonNullable<BuildSet["saved"]>) => void;
};

/** The sets without any empty one but `keep`. */
const pruned = (sets: BuildSet[], keep: string) => sets.filter((s) => s.id === keep || s.ids.length > 0);

export const useSets = create<SetsState>()((set, get) => ({
  ...read(),
  history: {},

  change: (fn) => {
    const { sets, currentId, history } = get();
    const current = sets.find((s) => s.id === currentId)!;
    const before: Contents = { ids: current.ids, pinned: current.pinned, extra: current.extra };
    const next = { ...current, ...fn(before) };
    if (next.ids.join() === current.ids.join() && next.pinned.join() === current.pinned.join()) return;
    set({
      sets: sets.map((s) => (s.id === currentId ? next : s)),
      history: { ...history, [currentId]: [...(history[currentId] ?? []), before].slice(-UNDO_LIMIT) },
    });
  },

  undo: () => {
    const { sets, currentId, history } = get();
    const past = history[currentId] ?? [];
    const before = past.at(-1);
    if (!before) return;
    set({
      sets: sets.map((s) => (s.id === currentId ? { ...s, ...before } : s)),
      history: { ...history, [currentId]: past.slice(0, -1) },
    });
  },

  rename: (name) => set((st) => ({ sets: st.sets.map((s) => (s.id === st.currentId ? { ...s, name } : s)) })),

  select: (id) => set((st) => ({ currentId: id, sets: pruned(st.sets, id) })),

  add: () => {
    const fresh = blank();
    set((st) => ({ sets: [...pruned(st.sets, fresh.id), fresh], currentId: fresh.id }));
  },

  open: (name, ids) => {
    const fresh = blank(name, { ids, pinned: [], extra: {} });
    set((st) => ({ sets: [...pruned(st.sets, fresh.id), fresh], currentId: fresh.id }));
  },

  split: (moved) => {
    const { sets, currentId, history } = get();
    const current = sets.find((s) => s.id === currentId)!;
    const fresh = blank(`${current.name} 2`, {
      ids: moved,
      pinned: current.pinned.filter((id) => moved.includes(id)),
      extra: Object.fromEntries(moved.flatMap((id) => (current.extra[id] ? [[id, current.extra[id]]] : []))),
    });
    const kept = { ...current, ids: current.ids.filter((id) => !moved.includes(id)), pinned: current.pinned.filter((id) => !moved.includes(id)) };
    set({ sets: [...sets.map((s) => (s.id === currentId ? kept : s)), fresh], history: { ...history, [currentId]: [] } });
  },

  markSaved: (setId, saved) => set((st) => ({ sets: st.sets.map((s) => (s.id === setId ? { ...s, saved } : s)) })),
}));

useSets.subscribe(({ sets, currentId }) => {
  try {
    localStorage.setItem(KEY, JSON.stringify({ sets, currentId }));
  } catch {
    // Blocked storage only means the sets don't survive a reload.
  }
});
