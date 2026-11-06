// App state: the library, the sorting queue, the current song's picks, and the Spotify
// writes that sorting a song triggers (serialized, with undo). Every sort is also recorded in
// the ledger (data/ledger.json), which is applied over whatever library is loaded or resynced.
import { create } from "zustand";
import { config } from "../core/config.ts";
import { inbox, type Library } from "../core/library.ts";
import { neighborsFrom, type AudioIndex, type Vectors } from "../core/audio.ts";
import { applyLedger, unconfirmed, type LedgerEntry } from "../core/ledger.ts";
import { buildModel, prechecked, suggest, type ArtistRules, type Model, type Neighbors } from "../core/suggest.ts";
import { addToPlaylist, createPlaylist, removeFromPlaylist, setLiked } from "../core/spotify.ts";
import { client } from "./auth.ts";


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
  /** Exact sound vectors, loaded in the background after `audio`; null until then or if missing. */
  vectors: Vectors | null;
  rules: ArtistRules;
  /** Playlists hidden from suggestions (and ignored when deciding what's sorted). */
  hidden: string[];
  /** Sorts made here that a resync hasn't confirmed yet. */
  ledger: LedgerEntry[];
  queue: string[];
  picked: string[];
  order: Order;
  removeFromLikes: boolean;
  history: Sorted[];
  status: Status;
  pendingWrites: number;

  setVectors: (vectors: Vectors) => void;
  load: (lib: Library, audio: AudioIndex | null, rules: ArtistRules, hidden: string[], ledger: LedgerEntry[]) => void;
  /** Sets (or with [] clears) a playlist's artist rule, saves it, and updates the current picks. */
  setRule: (playlistId: string, artists: ArtistRules[string]) => void;
  /** Hides a playlist from suggestions (or shows it again), saves, and rebuilds the queue. */
  setHidden: (playlistId: string, hide: boolean) => void;
  /** Creates a private Spotify playlist, adds it to the library, and checks it for the current song. */
  createPlaylist: (name: string) => Promise<void>;
  /** Takes freshly synced data, keeping sorts Spotify doesn't show yet. */
  replaceLibrary: (lib: Library) => void;
  setOrder: (order: Order) => void;
  togglePick: (playlistId: string) => void;
  sortCurrent: () => void;
  skip: () => void;
  undo: () => void;
  jumpTo: (trackId: string) => void;
  setRemoveFromLikes: (on: boolean) => void;
};

/** Playlists checked when a song comes up: confident cold suggestions for known artists. */
function initialPicks(s: Pick<State, "lib" | "model" | "neighbors">, trackId: string | undefined): string[] {
  const track = trackId ? s.lib?.tracks[trackId] : undefined;
  if (!track || !s.model) return [];
  return prechecked(s.model, track, suggest(s.model, track, [], s.neighbors));
}

/** Orders the inbox. "similar" chains each song to its nearest unsorted neighbor by sound. */
function buildQueue(lib: Library, model: Model, neighbors: Neighbors | undefined, order: Order, hidden: string[]): string[] {
  const items = inbox(lib, hidden);
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

/** Saves the ledger to data/ledger.json; throws if the dev server didn't take it. */
async function saveLedger(ledger: LedgerEntry[]) {
  const res = await fetch("/api/ledger", { method: "PUT", body: JSON.stringify(ledger) });
  if (!res.ok) throw new Error(`dev server replied ${res.status}`);
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

  /** Records the ledger in state and on disk; a failed save shows in the header. */
  const setLedger = (ledger: LedgerEntry[]) => {
    set({ ledger });
    saveLedger(ledger).catch((e: unknown) =>
      set({ status: { kind: "error", message: `Saving the sort locally failed (is \`pnpm dev\` running?): ${e instanceof Error ? e.message : String(e)}` } }),
    );
  };

  const setLib = (lib: Library, keepQueue: boolean) => {
    const s = get();
    const model = buildModel(lib, { rules: s.rules, hidden: s.hidden });
    const stillInbox = new Set(inbox(lib, s.hidden).map((l) => l.id));
    const queue = keepQueue ? s.queue.filter((id) => stillInbox.has(id)) : buildQueue(lib, model, s.neighbors, s.order, s.hidden);
    set({ lib, model, queue });
    persist(lib);
  };

  return {
    lib: null,
    model: null,
    audio: null,
    neighbors: undefined,
    vectors: null,
    rules: {},
    hidden: [],
    ledger: [],
    queue: [],
    picked: [],
    order: "confident",
    removeFromLikes: true,
    history: [],
    status: { kind: "idle" },
    pendingWrites: 0,

    setVectors: (vectors) => set({ vectors }),

    load: (synced, audio, rules, hidden, ledger) => {
      const lib = applyLedger(synced, ledger);
      const neighbors = audio ? neighborsFrom(audio) : undefined;
      const model = buildModel(lib, { rules, hidden });
      const order: Order = audio ? "similar" : "confident";
      const queue = buildQueue(lib, model, neighbors, order, hidden);
      set({ lib, model, audio, neighbors, rules, hidden, ledger, order, queue, picked: initialPicks({ lib, model, neighbors }, queue[0]) });
    },

    setHidden: (playlistId, hide) => {
      const s = get();
      const hidden = hide ? [...new Set([...s.hidden, playlistId])] : s.hidden.filter((p) => p !== playlistId);
      void fetch("/api/hidden", { method: "PUT", body: JSON.stringify(hidden) });
      if (!s.lib) return set({ hidden });
      const model = buildModel(s.lib, { rules: s.rules, hidden });
      // The inbox can change (songs only in a hidden playlist count as unsorted); keep the current song up.
      const current = s.queue[0];
      const rebuilt = buildQueue(s.lib, model, s.neighbors, s.order, hidden);
      const queue = current && rebuilt.includes(current) ? [current, ...rebuilt.filter((id) => id !== current)] : rebuilt;
      const picked = queue[0] === current ? s.picked.filter((p) => !(hide && p === playlistId)) : initialPicks({ ...s, model }, queue[0]);
      set({ hidden, model, queue, picked });
    },

    setRule: (playlistId, artists) => {
      const { lib, queue, picked, neighbors, hidden } = get();
      const rules = { ...get().rules };
      if (artists.length) rules[playlistId] = artists;
      else delete rules[playlistId];
      void fetch("/api/rules", { method: "PUT", body: JSON.stringify(rules) });
      if (!lib) return set({ rules });

      const model = buildModel(lib, { rules, hidden });
      const track = queue[0] ? lib.tracks[queue[0]] : undefined;
      if (!track) return set({ rules, model });
      // Keep your picks except ones the rules now rule out, and check new rule matches.
      const ranked = suggest(model, track, [], neighbors);
      const allowed = new Set(ranked.map((s) => s.playlistId));
      const matches = ranked.filter((s) => s.parts.rule > 0).map((s) => s.playlistId);
      set({ rules, model, picked: [...new Set([...picked.filter((p) => allowed.has(p)), ...matches])] });
    },

    createPlaylist: async (name) => {
      set({ status: { kind: "saving" } });
      try {
        const created = await createPlaylist(client, name);
        const lib = get().lib;
        if (!lib) return;
        // A resync would pick it up from Spotify anyway; adding it here means no resync is needed.
        setLib({ ...lib, playlists: [...lib.playlists, { id: created.id, name: created.name, imageUrl: null, trackIds: [] }] }, true);
        set((s) => ({
          picked: [...s.picked, created.id],
          status: s.pendingWrites || s.status.kind === "error" ? s.status : { kind: "idle" },
        }));
      } catch (e) {
        set({ status: { kind: "error", message: `Creating "${name}": ${e instanceof Error ? e.message : String(e)}` } });
      }
    },

    replaceLibrary: (fresh) => {
      const ledger = unconfirmed(fresh, get().ledger);
      setLedger(ledger);
      setLib(applyLedger(fresh, ledger), false);
      set((s) => ({ history: [], picked: initialPicks(s, s.queue[0]) }));
    },

    setOrder: (order) => {
      const { lib, model, neighbors, hidden } = get();
      if (!lib || !model) return;
      const queue = buildQueue(lib, model, neighbors, order, hidden);
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

      const entry: LedgerEntry = {
        trackId,
        added: [...added, ...(addedToAll ? [config.allPlaylistId] : [])],
        unliked: unliked !== null,
        at: new Date().toISOString(),
      };
      setLedger([...get().ledger, entry]);
      setLib(applyLedger(lib, [entry]), true);
      // Drop it from the queue even if it's still technically unsorted (e.g. only put in hidden playlists).
      const rest = get().queue.filter((id) => id !== trackId);
      set((s) => ({
        queue: rest,
        history: [...s.history, { trackId, picked, added, addedToAll, unliked }],
        picked: initialPicks(s, rest[0]),
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
      setLedger(get().ledger.filter((e) => e.trackId !== trackId));
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
