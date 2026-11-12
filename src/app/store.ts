// App state: the library, the sorting queue, the current song's picks, and the Spotify
// writes that sorting a song triggers (serialized, with undo). Every sort is also recorded in
// the ledger (data/ledger.json), which is applied over whatever library is loaded or resynced.
import { create } from "zustand";
import { config } from "../core/config.ts";
import { inbox, type Library } from "../core/library.ts";
import { decodeVectors, neighborsFrom, type AudioIndex, type Vectors } from "../core/audio.ts";
import { classifierFrom, type ClassifierData, type SoundClassifier } from "../core/classifier.ts";
import { applyLedger, unconfirmed, type LedgerEntry } from "../core/ledger.ts";
import type { Languages } from "../core/languages.ts";
import { themeIndex, type ThemeData, type ThemeIndex } from "../core/themes.ts";
import { buildModel, prechecked, suggest, type ArtistRules, type Model, type Neighbors } from "../core/suggest.ts";
import type { Edges } from "../core/setlist.ts";
import { decodeFeatures, type FeaturesFile, type SongFeatures } from "../core/features.ts";
import { decodeTags, type Tags, type TagsFile } from "../core/tags.ts";
import { addToPlaylist, createPlaylist, removeFromPlaylist, replacePlaylist, setLiked } from "../core/spotify.ts";
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
  /** How each song starts and ends (data/edges.bin), loaded by `loadEdges`; null until then or if missing. */
  edges: Edges | null;
  /** Each song's tempo, key, loudness and vocals (data/features.json), loaded by `loadFeatures`; null until then or if missing. */
  features: ReadonlyMap<string, SongFeatures> | null;
  /** Per-playlist sound classifiers (data/classifier.json); undefined until trained. */
  classifier: SoundClassifier | undefined;
  /** What songs are about (data/themes.json), loaded in the background; null until then or if missing. */
  themes: ThemeIndex | null;
  /** Each song's lyric language (data/languages.jsonl), loaded in the background; null until then or if missing. */
  languages: Languages | null;
  rules: ArtistRules;
  /** Playlists hidden from suggestions (and ignored when deciding what's sorted). */
  hidden: string[];
  /** Playlists currently not counting as sorted: their songs are back in the queue, and they aren't suggested. */
  uncounted: string[];
  /** Playlists kept in the sort screen's on/off row, whether or not they're uncounted right now. */
  shelf: string[];
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
  /** Fetches the edge vectors once, for the Build tab; without them, handoffs use whole songs. */
  loadEdges: () => void;
  /** Fetches the song features once, for the Build tab. */
  loadFeatures: () => void;
  /** Each song's genres and moods (data/tags.json), loaded by `loadTags`; null until then or if missing. */
  tags: Tags | null;
  /** Fetches the song tags once. */
  loadTags: () => void;
  setThemes: (data: ThemeData) => void;
  setLanguages: (languages: Languages) => void;
  /** Takes freshly trained classifiers and re-ranks the queue. */
  setClassifier: (data: ClassifierData) => void;
  load: (lib: Library, audio: AudioIndex | null, rules: ArtistRules, hidden: string[], ledger: LedgerEntry[], classifier: ClassifierData | null) => void;
  /** Sets (or with [] clears) a playlist's artist rule, saves it, and updates the current picks. */
  setRule: (playlistId: string, artists: ArtistRules[string]) => void;
  /** Hides a playlist from suggestions (or shows it again), saves, and rebuilds the queue. */
  setHidden: (playlistId: string, hide: boolean) => void;
  /** Switches whether a playlist counts as sorted, and keeps it in the on/off row. */
  setUncounted: (playlistId: string, on: boolean) => void;
  /** Takes a playlist out of the on/off row, so it counts as sorted again. */
  dropFromShelf: (playlistId: string) => void;
  /** Creates a private Spotify playlist, adds it to the library, and checks it for the current song. */
  createPlaylist: (name: string) => Promise<void>;
  /**
   * Saves these songs, in order, as a private playlist that stays out of sorting: a new one, or `playlistId`
   * renamed and refilled. `onSaved` gets the playlist's id once Spotify has it.
   */
  saveList: (name: string, trackIds: string[], playlistId?: string, onSaved?: (id: string) => void) => void;
  /** Saves these songs, in order, as a new private playlist that counts for sorting like any other; `onSaved` runs once Spotify has it. */
  savePlaylist: (name: string, trackIds: string[], onSaved?: () => void) => void;
  /** Adds songs to one of your playlists, here and on Spotify. */
  addToPlaylist: (playlistId: string, trackIds: string[]) => void;
  /** Takes songs out of one of your playlists, here and on Spotify; they stay in your other playlists. */
  removeFromPlaylist: (playlistId: string, trackIds: string[]) => void;
  /** Takes freshly synced data, keeping sorts Spotify doesn't show yet. */
  replaceLibrary: (lib: Library) => void;
  setOrder: (order: Order) => void;
  togglePick: (playlistId: string) => void;
  /** Sorts these songs (normally the current one, plus a run of alike ones) into the checked playlists. */
  sort: (trackIds: string[]) => void;
  skip: () => void;
  /** Undoes the sort of `trackId` (default: the latest) and brings it back up. */
  undo: (trackId?: string) => void;
  jumpTo: (trackId: string) => void;
  setRemoveFromLikes: (on: boolean) => void;
};

/** Playlists checked when a song comes up: confident cold suggestions for known artists. */
export function initialPicks(s: Pick<State, "lib" | "model" | "neighbors">, trackId: string | undefined): string[] {
  const track = trackId ? s.lib?.tracks[trackId] : undefined;
  if (!track || !s.model) return [];
  return prechecked(s.model, track, suggest(s.model, track, [], s.neighbors));
}

/** Orders the inbox. "similar" chains each song to its nearest unsorted neighbor by sound. */
function buildQueue(lib: Library, model: Model, neighbors: Neighbors | undefined, order: Order, hidden: string[], uncounted: string[]): string[] {
  const items = inbox(lib, hidden, uncounted);
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

/** The model never suggests or learns from hidden or uncounted playlists. */
const modelOf = (lib: Library, rules: ArtistRules, hidden: string[], uncounted: string[], classifier: SoundClassifier | undefined) =>
  buildModel(lib, { rules, hidden: [...hidden, ...uncounted], classifier });

const PASS_KEY = "uncounted-playlists";

/** The uncounted state is a view of the sorting queue, so it stays in this browser and never reaches Spotify. */
function readPass(lib: Library): { uncounted: string[]; shelf: string[] } {
  try {
    const saved = JSON.parse(localStorage.getItem(PASS_KEY) ?? "null") as { uncounted: string[]; shelf: string[] } | null;
    const known = (ids: string[] | undefined) => (ids ?? []).filter((id) => lib.playlists.some((p) => p.id === id));
    return { uncounted: known(saved?.uncounted), shelf: known(saved?.shelf) };
  } catch {
    return { uncounted: [], shelf: [] };
  }
}

function savePass(uncounted: string[], shelf: string[]) {
  try {
    localStorage.setItem(PASS_KEY, JSON.stringify({ uncounted, shelf }));
  } catch {
    // Blocked storage only means the row resets on reload.
  }
}

/** Saves the ledger to data/ledger.json; throws if the dev server didn't take it. */
async function saveLedger(ledger: LedgerEntry[]) {
  const res = await fetch("/api/ledger", { method: "PUT", body: JSON.stringify(ledger) });
  if (!res.ok) throw new Error(`dev server replied ${res.status}`);
}

let writes: Promise<void> = Promise.resolve();
let edgesRequested = false;
let featuresRequested = false;
let tagsRequested = false;
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
    const model = modelOf(lib, s.rules, s.hidden, s.uncounted, s.classifier);
    const stillInbox = new Set(inbox(lib, s.hidden, s.uncounted).map((l) => l.id));
    const queue = keepQueue ? s.queue.filter((id) => stillInbox.has(id)) : buildQueue(lib, model, s.neighbors, s.order, s.hidden, s.uncounted);
    set({ lib, model, queue });
    persist(lib);
  };

  /** Rebuilds the model and queue after playlists stop or start counting; `dropped` leaves the current picks. */
  const applyExclusions = (hidden: string[], uncounted: string[], dropped?: string) => {
    const s = get();
    if (!s.lib) return set({ hidden, uncounted });
    const model = modelOf(s.lib, s.rules, hidden, uncounted, s.classifier);
    // The inbox can change (songs only in such a playlist count as unsorted); keep the current song up.
    const current = s.queue[0];
    const rebuilt = buildQueue(s.lib, model, s.neighbors, s.order, hidden, uncounted);
    const queue = current && rebuilt.includes(current) ? [current, ...rebuilt.filter((id) => id !== current)] : rebuilt;
    const picked = queue[0] === current ? s.picked.filter((p) => p !== dropped) : initialPicks({ ...s, model }, queue[0]);
    set({ hidden, uncounted, model, queue, picked });
  };

  return {
    lib: null,
    model: null,
    audio: null,
    neighbors: undefined,
    vectors: null,
    edges: null,
    features: null,
    tags: null,
    classifier: undefined,
    themes: null,
    languages: null,
    rules: {},
    hidden: [],
    uncounted: [],
    shelf: [],
    ledger: [],
    queue: [],
    picked: [],
    order: "confident",
    removeFromLikes: true,
    history: [],
    status: { kind: "idle" },
    pendingWrites: 0,

    setVectors: (vectors) => set({ vectors }),

    loadEdges: () => {
      if (edgesRequested) return;
      edgesRequested = true;
      fetch("/api/edges")
        .then((res) => (res.ok ? res.arrayBuffer() : null))
        .then((buf) => {
          const edges = buf && decodeVectors(buf);
          // Two rows per song of audio.json; a mismatch means one was rebuilt without the other.
          if (edges && edges.scale.length === 2 * (get().audio?.ids.length ?? -1)) set({ edges });
        })
        .catch(console.error);
    },

    loadFeatures: () => {
      if (featuresRequested) return;
      featuresRequested = true;
      fetch("/api/features")
        .then((res) => (res.ok ? (res.json() as Promise<FeaturesFile>) : null))
        .then((file) => file && set({ features: decodeFeatures(file) }))
        .catch(console.error);
    },

    loadTags: () => {
      if (tagsRequested) return;
      tagsRequested = true;
      fetch("/api/tags")
        .then((res) => (res.ok ? (res.json() as Promise<TagsFile>) : null))
        .then((file) => file && set({ tags: decodeTags(file) }))
        .catch(console.error);
    },

    setThemes: (data) => set({ themes: themeIndex(data) }),

    setLanguages: (languages) => set({ languages }),

    setClassifier: (data) => {
      set({ classifier: classifierFrom(data) });
      const { lib, queue } = get();
      if (!lib) return;
      setLib(lib, false);
      // Keep the song you're on; only what comes after it is re-ranked.
      const current = queue[0];
      const rebuilt = get().queue;
      if (current && rebuilt.includes(current)) set({ queue: [current, ...rebuilt.filter((id) => id !== current)] });
    },

    load: (synced, audio, rules, hidden, ledger, trained) => {
      const lib = applyLedger(synced, ledger);
      const neighbors = audio ? neighborsFrom(audio) : undefined;
      const { uncounted, shelf } = readPass(lib);
      const classifier = trained ? classifierFrom(trained) : undefined;
      const model = modelOf(lib, rules, hidden, uncounted, classifier);
      const order: Order = audio ? "similar" : "confident";
      const queue = buildQueue(lib, model, neighbors, order, hidden, uncounted);
      set({ lib, model, audio, neighbors, classifier, rules, hidden, uncounted, shelf, ledger, order, queue, picked: initialPicks({ lib, model, neighbors }, queue[0]) });
    },

    setHidden: (playlistId, hide) => {
      const s = get();
      const hidden = hide ? [...new Set([...s.hidden, playlistId])] : s.hidden.filter((p) => p !== playlistId);
      void fetch("/api/hidden", { method: "PUT", body: JSON.stringify(hidden) });
      applyExclusions(hidden, s.uncounted, hide ? playlistId : undefined);
    },

    setUncounted: (playlistId, on) => {
      const s = get();
      const uncounted = on ? [...new Set([...s.uncounted, playlistId])] : s.uncounted.filter((p) => p !== playlistId);
      const shelf = [...new Set([...s.shelf, playlistId])];
      savePass(uncounted, shelf);
      set({ shelf });
      applyExclusions(s.hidden, uncounted, on ? playlistId : undefined);
    },

    dropFromShelf: (playlistId) => {
      const s = get();
      const uncounted = s.uncounted.filter((p) => p !== playlistId);
      const shelf = s.shelf.filter((p) => p !== playlistId);
      savePass(uncounted, shelf);
      set({ shelf });
      applyExclusions(s.hidden, uncounted);
    },

    setRule: (playlistId, artists) => {
      const { lib, queue, picked, neighbors, hidden, uncounted, classifier } = get();
      const rules = { ...get().rules };
      if (artists.length) rules[playlistId] = artists;
      else delete rules[playlistId];
      void fetch("/api/rules", { method: "PUT", body: JSON.stringify(rules) });
      if (!lib) return set({ rules });

      const model = modelOf(lib, rules, hidden, uncounted, classifier);
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

    saveList: (name, trackIds, playlistId, onSaved) =>
      write(`Saving "${name}"`, async () => {
        let id = playlistId;
        if (id) {
          await client.request("PUT", `/playlists/${id}`, { name });
          await replacePlaylist(client, id, trackIds);
        } else {
          id = (await createPlaylist(client, name)).id;
          await addToPlaylist(client, id, trackIds);
        }
        // Hidden so the next resync doesn't make a listening list into a sorting suggestion.
        const hidden = [...new Set([...get().hidden, id])];
        set({ hidden });
        await fetch("/api/hidden", { method: "PUT", body: JSON.stringify(hidden) });
        onSaved?.(id);
      }),

    savePlaylist: (name, trackIds, onSaved) =>
      write(`Saving "${name}"`, async () => {
        const { id } = await createPlaylist(client, name);
        await addToPlaylist(client, id, trackIds);
        const lib = get().lib;
        if (lib) setLib({ ...lib, playlists: [...lib.playlists, { id, name, imageUrl: null, trackIds }] }, true);
        onSaved?.();
      }),

    addToPlaylist: (playlistId, trackIds) => {
      const lib = get().lib;
      if (!lib || trackIds.length === 0) return;
      setLib(edit(lib, (d) => d.playlists.set(playlistId, [...(d.playlists.get(playlistId) ?? []), ...trackIds])), true);
      write("Adding to playlist", () => addToPlaylist(client, playlistId, trackIds));
    },

    removeFromPlaylist: (playlistId, trackIds) => {
      const lib = get().lib;
      if (!lib || trackIds.length === 0) return;
      const gone = new Set(trackIds);
      setLib(edit(lib, (d) => d.playlists.set(playlistId, (d.playlists.get(playlistId) ?? []).filter((id) => !gone.has(id)))), true);
      write("Removing from playlist", () => removeFromPlaylist(client, playlistId, trackIds));
    },

    replaceLibrary: (fresh) => {
      const ledger = unconfirmed(fresh, get().ledger);
      setLedger(ledger);
      setLib(applyLedger(fresh, ledger), false);
      set((s) => ({ history: [], picked: initialPicks(s, s.queue[0]) }));
    },

    setOrder: (order) => {
      const { lib, model, neighbors, hidden, uncounted } = get();
      if (!lib || !model) return;
      const queue = buildQueue(lib, model, neighbors, order, hidden, uncounted);
      set({ order, queue, picked: initialPicks(get(), queue[0]) });
    },

    togglePick: (id) => set((s) => ({ picked: s.picked.includes(id) ? s.picked.filter((p) => p !== id) : [...s.picked, id] })),

    sort: (trackIds) => {
      const { lib, picked, removeFromLikes } = get();
      if (!lib || trackIds.length === 0 || picked.length === 0) return;

      const members = new Map(lib.playlists.map((p) => [p.id, new Set(p.trackIds)]));
      const has = (playlistId: string, trackId: string) => members.get(playlistId)?.has(trackId) ?? false;
      const likedAt = new Map(lib.liked.map((l) => [l.id, l.addedAt]));
      const sorted = trackIds.map((trackId): Sorted => {
        const addedAt = likedAt.get(trackId);
        return {
          trackId,
          picked,
          added: picked.filter((p) => !has(p, trackId)),
          addedToAll: !has(config.allPlaylistId, trackId),
          unliked: removeFromLikes && addedAt ? { addedAt } : null,
        };
      });
      const playlistsOf = (s: Sorted) => [...s.added, ...(s.addedToAll ? [config.allPlaylistId] : [])];

      const at = new Date().toISOString();
      const entries = sorted.map((s): LedgerEntry => ({ trackId: s.trackId, added: playlistsOf(s), unliked: s.unliked !== null, at }));
      setLedger([...get().ledger, ...entries]);
      setLib(applyLedger(lib, entries), true);
      // Drop them from the queue even if still technically unsorted (e.g. only put in hidden playlists).
      const done = new Set(trackIds);
      const rest = get().queue.filter((id) => !done.has(id));
      set((s) => ({ queue: rest, history: [...s.history, ...sorted], picked: initialPicks(s, rest[0]) }));

      // One request per playlist, so a run costs about as much as a single song.
      const byPlaylist = new Map<string, string[]>();
      for (const s of sorted) for (const p of playlistsOf(s)) byPlaylist.set(p, [...(byPlaylist.get(p) ?? []), s.trackId]);
      const unlike = sorted.filter((s) => s.unliked).map((s) => s.trackId);
      write("Sorting", async () => {
        for (const [playlistId, ids] of byPlaylist) await addToPlaylist(client, playlistId, ids);
        if (unlike.length) await setLiked(client, unlike, false);
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

    undo: (target) => {
      const { lib, history } = get();
      const last = target ? history.findLast((h) => h.trackId === target) : history.at(-1);
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
        history: s.history.filter((h) => h !== last),
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
