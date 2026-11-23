// Keeps everything Segue reports (see src/core/segue.ts) in an append-only file: transitions, grades, plays and
// rejected pairings, for counting plays and for tuning Segue later. Segue resends whatever it isn't sure arrived, so
// events are kept once per `event_id`. As with the listening history, the file is the only state: the set of stored
// ids is rebuilt from it on start, and it's copied to the storage box hourly.
import { appendFile, readFile, stat } from "node:fs/promises";
import { decodePlays, idsByIsrc, parseLive, type Play, type PlaysFile } from "../core/plays.ts";
import { parseSegue, segueContext, type SegueContext } from "../core/segue.ts";
import type { Library } from "../core/library.ts";
import { HISTORY_FILE, readRepaired } from "./history.ts";

export const SEGUE_FILE = "data/segue.jsonl";
/** The most events one POST may carry. */
export const MAX_EVENTS = 200;
const BACKUP_MS = 60 * 60_000;

export type SegueStoreOptions = { file: string; backup: () => Promise<unknown>; append?: typeof appendFile };

type Stored = { event_id: string; type: string };

const isStorable = (value: unknown): value is Stored => {
  const e = value as Partial<Stored> | null;
  return typeof e?.event_id === "string" && typeof e.type === "string";
};

function parseLine(line: string): Stored | null {
  try {
    const row: unknown = JSON.parse(line);
    return isStorable(row) ? row : null;
  } catch {
    return null;
  }
}

async function loadStored(file: string) {
  const lines = (await readRepaired(file)).split("\n").filter(Boolean);
  const rows = lines.map(parseLine).filter((row) => row !== null);
  if (rows.length < lines.length) console.warn(`Segue: ignoring ${lines.length - rows.length} unreadable row(s) in ${file}`);
  return { seen: new Set(rows.map((r) => r.event_id)), plays: rows.filter((r) => r.type === "play") as unknown[] };
}

/** The store behind `POST /host/segue/events`. `add` stores events not seen before, verbatim, and says how many. */
export function createSegueStore({ file, backup, append = appendFile }: SegueStoreOptions) {
  let stored: Awaited<ReturnType<typeof loadStored>> | undefined;
  let queue = Promise.resolve();
  let unsaved = false;
  const status = { events: 0, backupError: null as string | null };

  async function load() {
    if (stored) return stored;
    stored = await loadStored(file);
    status.events = stored.seen.size;
    return stored;
  }

  async function write(events: unknown[]) {
    const known = await load();
    const batch = new Set<string>(); // a batch can repeat an event; the first copy is kept
    const fresh = events.filter((e): e is Stored => isStorable(e) && !known.seen.has(e.event_id) && !batch.has(e.event_id) && !!batch.add(e.event_id));
    if (fresh.length === 0) return 0;
    try {
      await append(file, fresh.map((e) => `${JSON.stringify(e)}\n`).join(""));
    } catch (e) {
      stored = undefined; // the file may now end mid-row; the next write reloads and repairs it
      throw e;
    }
    for (const e of fresh) {
      known.seen.add(e.event_id);
      if (e.type === "play") known.plays.push(e);
    }
    status.events = known.seen.size;
    unsaved = true;
    return fresh.length;
  }

  /** One write at a time, so a resend racing its original can't store an event twice. */
  function add(events: unknown[]) {
    const run = queue.then(() => write(events));
    queue = run.then(() => undefined, () => undefined);
    return run;
  }

  async function backUp() {
    if (!unsaved) return;
    try {
      await backup();
      unsaved = false;
      status.backupError = null;
    } catch (e) {
      status.backupError = e instanceof Error ? e.message : String(e);
      console.error(`Segue: backup failed: ${status.backupError}`);
    }
  }

  /** Loads the file (anything in it may not have reached the backup yet) and backs it up hourly from then on. */
  async function start() {
    unsaved = (await load()).seen.size > 0;
    setInterval(() => void backUp(), BACKUP_MS).unref();
  }

  /** Every stored `play` event, raw. */
  const plays = async () => (await load()).plays;

  return { add, start, plays, status, backUp };
}

/** A file's parsed content, reread only when it changes; `read` gets null for a missing file. */
export function byMtime<T>(path: string, read: (text: string | null) => T) {
  let cached: { mtime: number; value: T } | undefined;
  return async () => {
    const mtime = await stat(path).then((s) => s.mtimeMs, () => 0);
    if (cached?.mtime !== mtime) cached = { mtime, value: read(mtime ? await readFile(path, "utf8").catch(() => null) : null) };
    return cached.value;
  };
}

const livePlays = byMtime(HISTORY_FILE, (text) =>
  (text ?? "").split("\n").flatMap((line) => {
    try {
      return parseLive(JSON.parse(line)) ?? [];
    } catch {
      return [];
    }
  }),
);
const playCounts = byMtime("data/plays.json", (text) => (text ? decodePlays(JSON.parse(text) as PlaysFile) : new Map()));
const isrcIds = new WeakMap<Library, ReadonlyMap<string, string>>();

/** The library's track id per ISRC, built once per loaded library. */
export function trackIdsByIsrc(lib: Library) {
  const ids = isrcIds.get(lib) ?? idsByIsrc(lib.tracks);
  isrcIds.set(lib, ids);
  return ids;
}

/** `GET /host/segue/context` for a library; files are reread only when they change. */
export async function currentContext(lib: Library | null, store: ReturnType<typeof createSegueStore>): Promise<SegueContext> {
  if (!lib) return { recent: [], rediscover: [], skip_rate: {} };
  const ids = trackIdsByIsrc(lib);
  const segue = (await store.plays()).map((row) => parseSegue(row, ids)).filter((play): play is Play => play !== null);
  return segueContext(await playCounts(), lib.tracks, [...(await livePlays()), ...segue], new Date());
}
