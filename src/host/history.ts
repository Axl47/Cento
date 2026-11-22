// Records every Spotify play to an append-only file, with or without a screen connected. Spotify only keeps
// the last 50 plays, so anything not written down in time is gone. The history file is the only state: the
// cursor and the set of known plays are rebuilt from it, so a restart can neither repeat nor skip a play.
import { execFile } from "node:child_process";
import { appendFile, readFile } from "node:fs/promises";
import { promisify } from "node:util";
import type { SpotifyClient } from "../core/spotify.ts";

export const HISTORY_FILE = "data/listening-history.jsonl";
export const GAPS_FILE = "data/listening-gaps.jsonl";

const RECENTLY_PLAYED = "/me/player/recently-played";
/** The most Spotify returns, and all it remembers. */
const WINDOW = 50;
/** Far inside the window: 50 plays take at least 25 minutes even at 30 seconds each. */
const POLL_MS = 5 * 60_000;
/** Asks a day behind the cursor, because a phone that was offline reports its plays late. Repeats are dropped. */
const OVERLAP_MS = 24 * 60 * 60_000;
const BACKUP_MS = 60 * 60_000;

const MISSING_SCOPE = "Not recording: this Spotify login lacks the user-read-recently-played permission. Log out and back in from Cento on this Mac. Still retrying.";

/** One item of Spotify's response. Rows keep every field Spotify sent, not only these. */
export type Play = { played_at: string; track: { uri: string }; context?: unknown };

export type RecorderOptions = { file: string; gapsFile: string; backup: () => Promise<unknown>; append?: typeof appendFile };

const isPlay = (value: unknown): value is Play => {
  const play = value as Partial<Play> | null;
  return typeof play?.track?.uri === "string" && !Number.isNaN(Date.parse(play.played_at ?? ""));
};

const playedAt = (play: Play) => Date.parse(play.played_at);
const keyOf = (play: Play) => `${play.track.uri}@${playedAt(play)}`;
const iso = (ms: number) => new Date(ms).toISOString();
const toLines = (rows: unknown[]) => rows.map((row) => `${JSON.stringify(row)}\n`).join("");

function parseLine(line: string): Play | null {
  try {
    const row: unknown = JSON.parse(line);
    return isPlay(row) ? row : null;
  } catch {
    return null;
  }
}

/**
 * Reads a file, creating it if missing. Only a missing file counts as empty: any other read error must not look like one.
 * A crash or full disk can leave half a row, so this ends that line to keep the next row from being glued to it.
 */
export async function readRepaired(path: string) {
  const text = await readFile(path, "utf8").catch((e: NodeJS.ErrnoException) => {
    if (e.code === "ENOENT") return "";
    throw e;
  });
  await appendFile(path, text && !text.endsWith("\n") ? "\n" : "");
  return text;
}

/** Rebuilds what's already recorded. A play lost to a half-written row isn't counted, so the overlap brings it back. */
async function loadRecorded(file: string, gapsFile: string) {
  const text = await readRepaired(file);
  await readRepaired(gapsFile);
  const lines = text.split("\n").filter(Boolean);
  const plays = lines.map(parseLine).filter((play) => play !== null);
  if (plays.length < lines.length) console.warn(`History: ignoring ${lines.length - plays.length} unreadable row(s) in ${file}`);
  return { seen: new Set(plays.map(keyOf)), cursor: plays.length ? plays.reduce((latest, play) => Math.max(latest, playedAt(play)), 0) : null };
}

/** Copies append-only files to the backup. `--append` sends only bytes past the copy's end, so a damaged local file can't rewrite it. */
export const rsyncBackup = (files: string[], destination: string) => () => promisify(execFile)("rsync", ["--append", ...files, destination], { timeout: 120_000 });

/**
 * The recorder behind `pnpm host`. Takes the client rather than importing the host's, so that the login stays
 * out of its tests. No failure here can reach the login: a poll only reads, and reports what went wrong.
 */
export function createRecorder(client: SpotifyClient, { file, gapsFile, backup, append = appendFile }: RecorderOptions) {
  let recorded: Awaited<ReturnType<typeof loadRecorded>> | undefined;
  let polling = false;
  let unsaved = false;
  let lastBackupAt = 0;
  const status = { lastPollAt: null as string | null, plays: 0, error: null as string | null, backupError: null as string | null };

  /** Logs only when the problem changes, because a login can stay wrong for days. */
  function report(error: string | null) {
    if (error !== status.error) {
      if (error) console.error(`History: ${error}`);
      else console.log("History: recording.");
    }
    status.error = error;
  }

  /** After a failed write the file may end mid-row, so the next poll reloads and repairs it before writing again. */
  async function write(path: string, rows: unknown[]) {
    try {
      await append(path, toLines(rows));
    } catch (e) {
      recorded = undefined;
      throw e;
    }
  }

  async function record() {
    if (client.limited(RECENTLY_PLAYED)) return report("Waiting for Spotify's rate limit to end. Still retrying.");
    if (!recorded) {
      recorded = await loadRecorded(file, gapsFile);
      unsaved = recorded.seen.size > 0; // anything recorded before a restart may not have reached the backup
    }
    const known = recorded;
    const { cursor, seen } = known;
    const after = cursor === null ? "" : `&after=${cursor - OVERLAP_MS}`;
    const { items } = await client.get<{ items: unknown[] }>(`${RECENTLY_PLAYED}?limit=${WINDOW}${after}`);
    const plays = items.filter(isPlay);

    // Every play in a full window is new, so the window may have started after plays we never saw.
    if (cursor !== null && items.length === WINDOW && plays.every((play) => playedAt(play) > cursor)) {
      const gap = { detected_at: iso(Date.now()), last_recorded: iso(cursor), oldest_returned: iso(Math.min(...plays.map(playedAt))) };
      console.warn(`History: plays between ${gap.last_recorded} and ${gap.oldest_returned} may be missing.`);
      await write(gapsFile, [gap]);
      unsaved = true;
    }

    const fresh = [...new Map(plays.map((play) => [keyOf(play), play])).entries()]
      .filter(([key]) => !seen.has(key))
      .sort(([, a], [, b]) => playedAt(a) - playedAt(b));
    if (fresh.length > 0) {
      await write(file, fresh.map(([, play]) => play));
      for (const [key, play] of fresh) {
        seen.add(key);
        known.cursor = Math.max(known.cursor ?? 0, playedAt(play));
      }
      unsaved = true;
      console.log(`History: recorded ${fresh.length} play(s).`);
    }
    status.plays = seen.size;
    status.lastPollAt = iso(Date.now());
    report(null);
  }

  async function backUp() {
    if (!unsaved || Date.now() - lastBackupAt < BACKUP_MS) return;
    try {
      await backup();
      unsaved = false;
      lastBackupAt = Date.now();
      status.backupError = null;
    } catch (e) {
      status.backupError = e instanceof Error ? e.message : String(e);
      console.error(`History: backup failed: ${status.backupError}`);
    }
  }

  async function poll() {
    if (polling) return;
    polling = true;
    try {
      await record();
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      report(message.includes(" 403 ") && /scope/i.test(message) ? MISSING_SCOPE : message);
    }
    await backUp();
    polling = false;
  }

  function start() {
    const tick = () => void poll().finally(() => setTimeout(tick, POLL_MS).unref());
    tick();
  }

  return { poll, start, status };
}
