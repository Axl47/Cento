// App state: the library, the sorting queue, the current song's picks, and the Spotify
// writes that sorting a song triggers (serialized, with undo).
import { create } from "zustand";
import { config } from "../core/config.ts";
import { inbox, type Library } from "../core/library.ts";
import { neighborsFrom, type AudioIndex } from "../core/audio.ts";
import { buildModel, suggest, type Model, type Neighbors } from "../core/suggest.ts";
import { addToPlaylist, removeFromPlaylist, setLiked } from "../core/spotify.ts";
import { client } from "./auth.ts";

/** Suggestions at or above this score start out checked. */
export const PRECHECK = 0.4;

export type Order = "confident" | "similar" | "newest";

type Sorted = {
  trackId: string;
  /** Everything that was checked, to restore on undo. */
  picked: string[];
  /** The subset actually added (the song wasn't already there). */
  added: string[];
  addedToAll: boolean;
  unliked: { addedAt: string } | null;
};

type Status = { kind: "idle" | "saving" | "error"; message?: string };

type State = {
  lib: Library | null;
  model: Model | null;
  audio: AudioIndex | null;
  neighbors: Neighbors | undefined;
  queue: string[];
  picked: string[];
  order: Order;
  removeFromLikes: boolean;
  history: Sorted[];
  status: Status;
  pendingWrites: number;

  load: (lib: Library, audio: AudioIndex | null) => void;
  replaceLibrary: (lib: Library) => void;
  setOrder: (order: Order) => void;
  togglePick: (playlistId: string) => void;
  sortCurrent: () => void;
  skip: () => void;
  undo: () => void;
  jumpTo: (trackId: string) => void;
  setRemoveFromLikes: (on: boolean) => void;
};

/** Playlists checked when a song comes up: confident cold suggestions. */
function initialPicks(s: Pick<State, "lib" | "model" | "neighbors">, trackId: string | undefined): string[] {
  const track = trackId ? s.lib?.tracks[trackId] : undefined;
  if (!track || !s.model) return [];
  return suggest(s.model, track, [], s.neighbors)
    .filter((x) => x.score >= PRECHECK)
    .map((x) => x.playlistId);
}

/** Orders the inbox. "similar" chains each song to its nearest unsorted neighbor by sound. */
function buildQueue(lib: Library, model: Model, neighbors: Neighbors | undefined, order: Order): string[] {
  const items = inbox(lib);
  if (order === "newest") return items.toSorted((a, b) => b.addedAt.localeCompare(a.addedAt)).map((l) => l.id);

  const confidence = new Map(
    items.map((l) => [l.id, suggest(model, lib.tracks[l.id]!, [], neighbors)[0]?.score ?? 0] as const),
  );
  const byConfidence = items.map((l) => l.id).toSorted((a, b) => confidence.get(b)! - confidence.get(a)!);
  if (order === "confident" || !neighbors) return byConfidence;

  const remaining = new Set(byConfidence);
  const chain: string[] = [];
  let cur = byConfidence[0];
  while (cur) {
    chain.push(cur);
    remaining.delete(cur);
    cur = neighbors(cur).find((n) => remaining.has(n.id))?.id ?? remaining.values().next().value;
  }
  return chain;
}

let writes: Promise<void> = Promise.resolve();
let saveTimer: ReturnType<typeof setTimeout> | undefined;

/** Persists the library to data/library.json (debounced). */
function persist(lib: Library) {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    void fetch("/api/library", { method: "PUT", body: JSON.stringify(lib) });
  }, 800);
}

/** Returns a copy of `lib` with `fn` applied to a cloned playlists/liked structure. */
function edit(lib: Library, fn: (draft: { playlists: Map<string, string[]>; liked: Library["liked"] }) => void): Library {
  const playlists = new Map(lib.playlists.map((p) => [p.id, [...p.trackIds]]));
  const draft = { playlists, liked: [...lib.liked] };
  fn(draft);
  return {
    ...lib,
    liked: draft.liked,
    playlists: lib.playlists.map((p) => ({ ...p, trackIds: playlists.get(p.id) ?? p.trackIds })),
  };
}

export const useApp = create<State>()((set, get) => {
  /** Queues a Spotify write after earlier ones, tracking status. */
  const write = (label: string, fn: () => Promise<void>) => {
    set((s) => ({ pendingWrites: s.pendingWrites + 1, status: { kind: "saving" } }));
    writes = writes
      .then(fn)
      .then(() => set((s) => ({ status: s.status.kind === "error" ? s.status : { kind: "idle" } })))
      .catch((e: unknown) => set({ status: { kind: "error", message: `${label}: ${e instanceof Error ? e.message : String(e)}` } }))
      .finally(() => set((s) => ({ pendingWrites: s.pendingWrites - 1 })));
  };

  const setLib = (lib: Library, keepQueue: boolean) => {
    const model = buildModel(lib);
    const s = get();
    const stillInbox = new Set(inbox(lib).map((l) => l.id));
    const queue = keepQueue ? s.queue.filter((id) => stillInbox.has(id)) : buildQueue(lib, model, s.neighbors, s.order);
    set({ lib, model, queue });
    persist(lib);
  };

  return {
    lib: null,
    model: null,
    audio: null,
    neighbors: undefined,
    queue: [],
    picked: [],
    order: "confident",
    removeFromLikes: true,
    history: [],
    status: { kind: "idle" },
    pendingWrites: 0,

    load: (lib, audio) => {
      const neighbors = audio ? neighborsFrom(audio) : undefined;
      const model = buildModel(lib);
      const order: Order = audio ? "similar" : "confident";
      const queue = buildQueue(lib, model, neighbors, order);
      set({ lib, model, audio, neighbors, order, queue, picked: initialPicks({ lib, model, neighbors }, queue[0]) });
    },

    replaceLibrary: (lib) => {
      setLib(lib, false);
      set((s) => ({ history: [], picked: initialPicks(s, s.queue[0]) }));
    },

    setOrder: (order) => {
      const { lib, model, neighbors } = get();
      if (!lib || !model) return;
      const queue = buildQueue(lib, model, neighbors, order);
      set({ order, queue, picked: initialPicks(get(), queue[0]) });
    },

    togglePick: (id) => set((s) => ({ picked: s.picked.includes(id) ? s.picked.filter((p) => p !== id) : [...s.picked, id] })),

    sortCurrent: () => {
      const { lib, queue, picked, removeFromLikes } = get();
      const trackId = queue[0];
      if (!lib || !trackId || picked.length === 0) return;

      const inPlaylist = (id: string) => lib.playlists.find((p) => p.id === id)?.trackIds.includes(trackId) ?? false;
      const added = picked.filter((id) => !inPlaylist(id));
      const addedToAll = !inPlaylist(config.allPlaylistId);
      const likedEntry = lib.liked.find((l) => l.id === trackId);
      const unliked = removeFromLikes && likedEntry ? { addedAt: likedEntry.addedAt } : null;

      const next = edit(lib, (d) => {
        for (const id of [...added, ...(addedToAll ? [config.allPlaylistId] : [])]) d.playlists.get(id)?.push(trackId);
        if (unliked) d.liked = d.liked.filter((l) => l.id !== trackId);
      });
      setLib(next, true);
      set((s) => ({
        history: [...s.history, { trackId, picked, added, addedToAll, unliked }],
        picked: initialPicks(s, s.queue[0]),
      }));

      write("Sorting", async () => {
        for (const id of added) await addToPlaylist(client, id, [trackId]);
        if (addedToAll) await addToPlaylist(client, config.allPlaylistId, [trackId]);
        if (unliked) await setLiked(client, [trackId], false);
      });
    },

    skip: () =>
      set((s) => {
        const [first, ...rest] = s.queue;
        const queue = first ? [...rest, first] : rest;
        return { queue, picked: initialPicks(s, queue[0]) };
      }),

    jumpTo: (trackId) =>
      set((s) => {
        if (!s.queue.includes(trackId)) return {};
        const queue = [trackId, ...s.queue.filter((id) => id !== trackId)];
        return { queue, picked: initialPicks(s, trackId) };
      }),

    undo: () => {
      const { lib, history } = get();
      const last = history.at(-1);
      if (!lib || !last) return;
      const { trackId, added, addedToAll, unliked } = last;

      const next = edit(lib, (d) => {
        for (const id of [...added, ...(addedToAll ? [config.allPlaylistId] : [])]) {
          const ids = d.playlists.get(id);
          if (ids) d.playlists.set(id, ids.filter((t) => t !== trackId));
        }
        if (unliked) d.liked = [{ id: trackId, addedAt: unliked.addedAt }, ...d.liked];
      });
      setLib(next, true);
      set((s) => ({
        history: s.history.slice(0, -1),
        queue: [trackId, ...s.queue.filter((id) => id !== trackId)],
        picked: last.picked,
      }));

      write("Undo", async () => {
        for (const id of added) await removeFromPlaylist(client, id, [trackId]);
        if (addedToAll) await removeFromPlaylist(client, config.allPlaylistId, [trackId]);
        if (unliked) await setLiked(client, [trackId], true);
      });
    },

    setRemoveFromLikes: (on) => set({ removeFromLikes: on }),
  };
});
