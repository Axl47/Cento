// Watches what's playing for as long as at least one screen is connected, and pushes it to all of them.
// One poller however many screens are open, so a screen left on can't run up Spotify's rate limits.
import type { ServerResponse } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { neighborsFrom, type AudioIndex } from "../core/audio.ts";
import type { Library } from "../core/library.ts";
import { NOTHING_PLAYING, nextPollMs, nowPanels, readPlayback, type ApiPlayback, type NowState } from "../core/now.ts";
import { themeIndex, type ThemeData } from "../core/themes.ts";
import { spotify } from "./spotify.ts";

const KEEP_ALIVE_MS = 25_000;
/** Spotify needs a moment before a command shows up in what it reports. */
const AFTER_COMMAND_MS = 300;

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

let state: NowState = { ...NOTHING_PLAYING, panels: null, error: null };
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

export async function poll() {
  if (polling || screens.size === 0) return;
  polling = true;
  clearTimeout(timer);
  try {
    if (!spotify.limited("/me/player")) {
      const playback = readPlayback(await spotify.get<ApiPlayback | undefined>("/me/player"));
      state = { ...playback, panels: await panelsFor(playback.trackId), error: null };
    }
  } catch (e) {
    state = { ...state, error: e instanceof Error ? e.message : String(e) };
  } finally {
    polling = false;
  }
  broadcast();
  if (screens.size > 0) timer = setTimeout(() => void poll(), nextPollMs(state));
}

/** Keeps a server-sent-events response open and streams playback to it until the screen goes away. */
export function addScreen(res: ServerResponse) {
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive" });
  const others = screens.size > 0;
  screens.add(res);
  if (others) send(res);
  else void poll();
  const keepAlive = setInterval(() => res.write(": still here\n\n"), KEEP_ALIVE_MS);
  res.on("close", () => {
    clearInterval(keepAlive);
    screens.delete(res);
    if (screens.size === 0) clearTimeout(timer);
  });
}

const SPOTIFY_COMMANDS = {
  next: () => spotify.request("POST", "/me/player/next"),
  previous: () => spotify.request("POST", "/me/player/previous"),
  toggle: () => spotify.request("PUT", state.paused ? "/me/player/play" : "/me/player/pause"),
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
    state = { ...state, error: message.includes(" 404 ") ? "Spotify has no active device to control. Start playing something first." : message };
    broadcast();
  }
}

export const runCommand = (name: PlayerCommand) => attempt(SPOTIFY_COMMANDS[name]);

export function seek(ms: number) {
  state = { ...state, position: ms };
  broadcast();
  return attempt(() => spotify.request("PUT", `/me/player/seek?position_ms=${Math.round(ms)}`));
}
