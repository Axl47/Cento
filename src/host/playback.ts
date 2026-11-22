// Watches what's playing for as long as at least one screen is connected, and pushes it to all of them.
// One poller however many screens are open, so a screen left on can't run up Spotify's rate limits.
// Segue reports its own playback (`updateSegue`), and the screens show whichever source `pickSource` picks; the
// player commands go to that source.
import type { ServerResponse } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { neighborsFrom, type AudioIndex } from "../core/audio.ts";
import type { Library } from "../core/library.ts";
import { NOTHING_PLAYING, nextPollMs, nowPanels, readPlayback, type ApiPlayback, type NowState, type Playback } from "../core/now.ts";
import { pickSource, type SegueCommand, type SegueNow } from "../core/segue.ts";
import { themeIndex, type ThemeData } from "../core/themes.ts";
import { trackIdsByIsrc } from "./segue.ts";
import { spotify } from "./spotify.ts";

const KEEP_ALIVE_MS = 25_000;
/** Spotify needs a moment before a command shows up in what it reports. */
const AFTER_COMMAND_MS = 300;
/** How long Segue's last report holds without another; it sends one every 5 s while running. */
const SEGUE_STALE_MS = 15_000;
const WITH_SEGUE_POLL_MS = 15_000;

const readJson = async <T>(path: string): Promise<T | null> => JSON.parse(await readFile(path, "utf8").catch(() => "null")) as T | null;

let loaded: { stamp: string; lib: Library | null; audio: AudioIndex | null; hidden: string[]; themes: ReturnType<typeof themeIndex> | null } | undefined;

/** The library files, reread only when a resync or `pnpm lyrics` has changed them. */
export async function libraryData() {
  const paths = ["data/library.json", "data/audio.json", "data/themes.json", "data/hidden.json"];
  const times = await Promise.all(paths.map((p) => stat(p).then((s) => s.mtimeMs, () => 0)));
  const stamp = times.join();
  if (loaded?.stamp !== stamp) {
    const [lib, audio, themes, hidden] = await Promise.all([
      readJson<Library>("data/library.json"),
      readJson<AudioIndex>("data/audio.json"),
      readJson<ThemeData>("data/themes.json"),
      readJson<string[]>("data/hidden.json"),
    ]);
    loaded = { stamp, lib, audio, hidden: hidden ?? [], themes: themes ? themeIndex(themes) : null };
  }
  return loaded;
}

/** What Spotify reported last, and why the last poll or command failed. */
let spotifyNow: Playback = NOTHING_PLAYING;
let spotifyError: string | null = null;
/** What Segue sent last, and when; gone after `SEGUE_STALE_MS` without a word. */
let segueNow: SegueNow | null = null;
let segueAt = 0;
let segueTimer: ReturnType<typeof setTimeout> | undefined;
/** Segue's open command streams: normally one. */
const segueStreams = new Set<ServerResponse>();

/** What the screens see, composed from both sources by `compose`. */
let state: NowState = { ...NOTHING_PLAYING, source: null, segue: null, panels: null, error: null };
let composing = 0;
const screens = new Set<ServerResponse>();
let timer: ReturnType<typeof setTimeout> | undefined;
let polling = false;

const send = (screen: ServerResponse) => screen.write(`data: ${JSON.stringify(state)}\n\n`);
const broadcast = () => screens.forEach(send);

async function panelsFor(trackId: string | null) {
  if (!trackId) return null;
  if (trackId === state.trackId && state.panels) return state.panels;
  const { lib, audio, themes } = await libraryData();
  return lib ? nowPanels(lib, audio, audio ? neighborsFrom(audio) : undefined, themes, trackId) : null;
}

const freshSegue = () => (segueNow?.key && Date.now() - segueAt < SEGUE_STALE_MS ? segueNow : null);

/** The library keeps 64 px covers; Spotify serves the same cover at 640 px under this other size code. */
const largeCover = (url: string | null) => url?.replace("ab67616d00004851", "ab67616d0000b273") ?? null;

/** Segue's song as playback: the library track with its ISRC, or just Segue's "Artist - Title" for one that isn't saved. */
async function seguePlayback(now: SegueNow): Promise<Playback> {
  const { lib } = await libraryData();
  const trackId = (lib && now.key && trackIdsByIsrc(lib).get(now.key.toUpperCase())) || null;
  const track = trackId ? lib?.tracks[trackId] : undefined;
  const [artist = "", title = now.label ?? ""] = (now.label ?? "").split(/ - (.*)/s);
  return {
    trackId,
    paused: !now.playing,
    position: now.position_ms,
    duration: now.duration_ms,
    current: track
      ? { name: track.name, artists: track.artists.map((a) => a.name), album: track.album.name, imageUrl: largeCover(track.album.imageUrl) }
      : { name: title, artists: artist ? [artist] : [], album: "", imageUrl: null },
  };
}

/** Rebuilds `state` from the latest of both sources. When two overlap, the one started last wins. */
async function compose() {
  const run = ++composing;
  const segue = freshSegue();
  const source = pickSource(spotifyNow, segue);
  const playback = source === "segue" ? await seguePlayback(segue!) : spotifyNow;
  const panels = await panelsFor(playback.trackId);
  if (run !== composing) return;
  state = {
    ...playback,
    source,
    segue: source === "segue" ? { next: segue!.next && { label: segue!.next.label, kind: segue!.next.kind, in_ms: segue!.next.in_ms }, markable: segue!.markable } : null,
    panels,
    error: source === "segue" ? null : spotifyError,
  };
}

const refresh = () => compose().then(broadcast);

export async function poll() {
  if (polling || screens.size === 0) return;
  polling = true;
  clearTimeout(timer);
  try {
    if (!spotify.limited("/me/player")) {
      spotifyNow = readPlayback(await spotify.get<ApiPlayback | undefined>("/me/player"));
      spotifyError = null;
    }
  } catch (e) {
    spotifyError = e instanceof Error ? e.message : String(e);
  } finally {
    polling = false;
  }
  await refresh();
  // While Segue plays, look often enough that starting Spotify takes over soon.
  if (screens.size > 0) timer = setTimeout(() => void poll(), Math.min(nextPollMs(spotifyNow), freshSegue() ? WITH_SEGUE_POLL_MS : Infinity));
}

/** Keeps a server-sent-events response open and streams playback to it until the screen goes away. */
export function addScreen(res: ServerResponse) {
  openStream(res, screens);
  if (screens.size > 1) send(res);
  else void poll();
  res.on("close", () => {
    if (screens.size === 0) clearTimeout(timer);
  });
}

/** Holds `res` open as a server-sent-events stream in `streams`, with keep-alive comments, until it closes. */
function openStream(res: ServerResponse, streams: Set<ServerResponse>) {
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive" });
  streams.add(res);
  const keepAlive = setInterval(() => res.write(": still here\n\n"), KEEP_ALIVE_MS);
  res.on("close", () => {
    clearInterval(keepAlive);
    streams.delete(res);
  });
}

/** `PUT /host/segue/now`: takes Segue's state and shows it if it's the source; it's dropped once Segue goes quiet. */
export function updateSegue(now: SegueNow) {
  const started = !freshSegue();
  segueNow = now;
  segueAt = Date.now();
  clearTimeout(segueTimer);
  segueTimer = setTimeout(() => void refresh(), SEGUE_STALE_MS);
  // Checks Spotify now, which also moves its next check up from the idle wait (see `poll`).
  if (started && freshSegue()) void poll();
  return refresh();
}

/** `GET /host/segue/commands`: the stream Segue takes its commands from. */
export const addSegueCommands = (res: ServerResponse) => openStream(res, segueStreams);

/** Sends a command to Segue; false when no command stream is open. */
function toSegue(command: SegueCommand) {
  if (segueStreams.size === 0) return false;
  for (const stream of segueStreams) stream.write(`data: ${JSON.stringify(command)}\n\n`);
  return true;
}

const SPOTIFY_COMMANDS = {
  next: () => spotify.request("POST", "/me/player/next"),
  previous: () => spotify.request("POST", "/me/player/previous"),
  toggle: () => spotify.request("PUT", spotifyNow.paused ? "/me/player/play" : "/me/player/pause"),
};

export type PlayerCommand = keyof typeof SPOTIFY_COMMANDS;
export const isPlayerCommand = (name: string): name is PlayerCommand => name in SPOTIFY_COMMANDS;

const pollSoon = () => setTimeout(() => void poll(), AFTER_COMMAND_MS);

/** Sends a command to Spotify; a failure, such as no active device, shows on the screens until the next check. */
async function attempt(send: () => Promise<unknown>) {
  try {
    await send();
    pollSoon();
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    spotifyError = message.includes(" 404 ") ? "Spotify has no active device to control. Start playing something first." : message;
    await refresh();
  }
}

/**
 * The player commands go to whichever source Now Playing shows. Resolves false when that's Segue and it isn't
 * listening for commands.
 */
export async function runCommand(name: PlayerCommand) {
  if (state.source === "segue") return toSegue({ command: name });
  await attempt(SPOTIFY_COMMANDS[name]);
  return true;
}

export async function seek(ms: number) {
  if (state.source === "segue") return toSegue({ command: "seek", ms: Math.round(ms) });
  state = { ...state, position: ms };
  spotifyNow = { ...spotifyNow, position: ms };
  broadcast();
  await attempt(() => spotify.request("PUT", `/me/player/seek?position_ms=${Math.round(ms)}`));
  return true;
}

/** Grades the transition Segue last played; false unless Segue is the source and listening. Segue records the mark itself. */
export const mark = (rating: 1 | -1) => state.source === "segue" && toSegue({ command: "mark", rating });
