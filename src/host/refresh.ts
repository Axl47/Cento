// The daily data refresh the host runs: resync the library from Spotify, then `pnpm audio` (embeds new songs, rebuilds
// the map), `pnpm edges` (how songs start and end), `pnpm features` (tempo, key and loudness, skipped until Stemma's
// extractor has written them) and `pnpm classify` (retrains on the new sorts). Due once a day from 12:01 AM local time; the host checks
// every minute and at startup, so a day the Mac slept through or was off for still gets its run as soon as it can.
import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { exportLibrary } from "../cli/libraryFiles.ts";
import { spotify } from "./spotify.ts";

const STATE_FILE = "data/refresh.json";
const RUN_AFTER_MINUTES = 1; // past midnight
const RETRY_MS = 60 * 60 * 1000;
const CHECK_MS = 60 * 1000;

export type RefreshState = {
  /** Local date (YYYY-MM-DD) of the last run that finished. */
  lastDay?: string;
  /** When the last run started (ISO), and why it failed if it did. */
  lastAttempt?: string;
  error?: string;
};

const localDay = (d: Date) => d.toLocaleDateString("en-CA"); // YYYY-MM-DD

/** Whether today's run is still owed: past 12:01 AM, not done today, and no failed attempt in the last hour. */
export function isDue(state: RefreshState, now: Date): boolean {
  if (now.getHours() * 60 + now.getMinutes() < RUN_AFTER_MINUTES) return false;
  if (state.lastDay === localDay(now)) return false;
  return !state.lastAttempt || now.getTime() - Date.parse(state.lastAttempt) >= RETRY_MS;
}

let state: RefreshState = await readFile(STATE_FILE, "utf8").then((s) => JSON.parse(s) as RefreshState, () => ({}));
let running = false;

const save = (next: RefreshState) => writeFile(STATE_FILE, JSON.stringify((state = next)));

const pnpm = (script: string) =>
  new Promise<void>((done, fail) =>
    spawn("pnpm", [script], { stdio: "inherit" }).on("close", (code) => (code === 0 ? done() : fail(new Error(`pnpm ${script} exited with ${code}`)))),
  );

/** Runs the refresh if it's due; never throws (a failure is kept in the status and retried in an hour). */
export async function refreshIfDue(now = new Date()) {
  if (running || !isDue(state, now)) return;
  running = true;
  const lastAttempt = now.toISOString();
  console.log(`Data refresh: starting (${lastAttempt})`);
  try {
    await save({ ...state, lastAttempt });
    await exportLibrary(spotify);
    await pnpm("audio");
    await pnpm("edges");
    await pnpm("features");
    await pnpm("classify");
    await save({ lastDay: localDay(now), lastAttempt });
    console.log("Data refresh: done");
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    await save({ ...state, lastAttempt, error });
    console.error(`Data refresh failed: ${error}`);
  } finally {
    running = false;
  }
}

/** Checks every minute from now on. */
export const scheduleRefresh = () => setInterval(() => void refreshIfDue(), CHECK_MS);

export const refreshStatus = () => ({ ...state, running });
