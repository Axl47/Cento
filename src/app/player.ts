// Playback by remote control: the app tells one of your Spotify apps (Spotify Connect device,
// e.g. the Mac desktop app) what to play, and shows the position Spotify reports. Audio never
// plays in the page, so there's no DRM, no browser autoplay policy, and your output device
// stays where it is. Needs Premium and Spotify open on at least one device.
import { create } from "zustand";
import { SpotifyBlockedError } from "../core/spotify.ts";
import { client } from "./auth.ts";

/** Where previews start, as a share of the track's length. */
export const START_AT = 0.35;

// Spotify rate-limits per app across every open tab, so poll gently; the progress bar
// animates between polls, and every command polls right after it lands.
const POLL_MS = 3000;
const DEVICES_MS = 60_000;
const RATE_LIMITED = "Spotify is rate-limiting this app. Playback controls come back in a moment.";
const DEVICE_KEY = "spotify-device-name"; // device ids change between app restarts; names don't
const ENABLED_KEY = "player-enabled";
/** The in-page player earlier versions registered; Spotify lists it for a while after. */
const OLD_IN_PAGE_DEVICE = "Playlist Sorter";

/** Hands the song to the Spotify app itself: listening without the player API. */
export const openInSpotify = (trackId: string) => location.assign(`spotify:track:${trackId}`);

export type Device = { id: string; name: string; type: string; is_active: boolean; is_restricted: boolean };

type ApiPlayback = {
  is_playing: boolean;
  progress_ms: number | null;
  device: { id: string } | null;
  item: { id: string; duration_ms: number; linked_from?: { id: string } } | null;
};

type PlayerState = {
  /** Off: no polling or player requests, the controls are hidden, and Play opens the song in Spotify. */
  enabled: boolean;
  devices: Device[];
  /** Device the app plays on. */
  deviceId: string | null;
  error: string | null;
  /** False until you start playback once; after that, each new song starts automatically. */
  armed: boolean;
  /** Latest state Spotify reported. */
  paused: boolean;
  trackId: string | null;
  position: number;
  duration: number;
  /** performance.now() when `position` was reported, to animate between polls. */
  updatedAt: number;

  init: () => void;
  setEnabled: (on: boolean) => void;
  setDevice: (id: string) => void;
  /** Explicit play (Space, Play button, clicking a song); also arms autoplay. `startAt` is a share of the track, a preview by default. */
  play: (trackId: string, durationMs: number, startAt?: number) => Promise<void>;
  /** Plays only once armed: used when the next song comes up. */
  autoplay: (trackId: string, durationMs: number) => void;
  toggle: () => void;
  seekBy: (ms: number) => void;
  seekTo: (ms: number) => void;
};

const albums = new Map<string, string>();
/** The track's album URI (cached), needed to start playback; see `play`. */
async function albumUri(trackId: string): Promise<string> {
  const known = albums.get(trackId);
  if (known) return known;
  const { album } = await client.get<{ album: { uri: string } }>(`/tracks/${trackId}`);
  albums.set(trackId, album.uri);
  return album.uri;
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
/** User-facing text for a failed request: a block says until when, a short 429 says it'll pass. */
const explain = (e: unknown) =>
  e instanceof SpotifyBlockedError ? `${e.message}. Playback controls return then.` : message(e).includes(" 429 ") ? RATE_LIMITED : message(e);
const savedEnabled = () => {
  try {
    return localStorage.getItem(ENABLED_KEY) !== "false";
  } catch {
    return true;
  }
};
const savedDeviceName = () => {
  try {
    return localStorage.getItem(DEVICE_KEY);
  } catch {
    return null;
  }
};

export const usePlayer = create<PlayerState>()((set, get) => {
  let polling = false;
  /** Re-reads playback state from Spotify; skipped while one is in flight or we're rate-limited. */
  const poll = async () => {
    if (polling || !get().enabled || client.limited("/me/player")) return;
    polling = true;
    try {
      const p = await client.get<ApiPlayback | undefined>("/me/player");
      if (!p?.item) return set({ paused: true });
      set({
        paused: !p.is_playing,
        trackId: p.item.linked_from?.id ?? p.item.id,
        position: p.progress_ms ?? 0,
        duration: p.item.duration_ms,
        updatedAt: performance.now(),
      });
    } catch (e) {
      // Transient errors: the next poll retries. A block: say so, since polls now skip until it ends.
      if (e instanceof SpotifyBlockedError) set({ error: explain(e) });
    } finally {
      polling = false;
    }
  };

  /** Refreshes the device list and keeps a sensible target selected; false if Spotify didn't answer. */
  const loadDevices = async (): Promise<boolean> => {
    try {
      const { devices } = await client.get<{ devices: Device[] }>("/me/player/devices");
      const usable = devices.filter((d) => !d.is_restricted && d.name !== OLD_IN_PAGE_DEVICE);
      const current = usable.find((d) => d.id === get().deviceId);
      const pick =
        current ??
        usable.find((d) => d.name === savedDeviceName()) ??
        usable.find((d) => d.is_active) ??
        usable.find((d) => d.type === "Computer") ??
        usable[0];
      set({ devices: usable, deviceId: pick?.id ?? null });
      if (get().error === RATE_LIMITED) set({ error: null });
      return true;
    } catch (e) {
      set({ error: explain(e) });
      return false;
    }
  };

  /** Sends a player command to the target device; on failure explains and refreshes devices. */
  const command = async (method: string, path: string, body?: unknown) => {
    if (!get().enabled) return;
    const { deviceId, devices } = get();
    if (!deviceId) {
      // A failed lookup already explains itself (e.g. rate-limited); don't blame missing devices.
      if (!(await loadDevices())) return;
      if (!get().deviceId) return set({ error: "No Spotify device found. Open Spotify on your Mac or phone." });
    }
    const target = get().deviceId!;
    try {
      await client.request(method, `${path}${path.includes("?") ? "&" : "?"}device_id=${target}`, body);
      set({ error: null });
      setTimeout(() => void poll(), 300);
    } catch (e) {
      const name = devices.find((d) => d.id === target)?.name ?? "the device";
      const notFound = message(e).includes("404");
      set({ error: notFound ? `Spotify isn't reachable on ${name}. Open Spotify there, or pick another device.` : explain(e) });
      void loadDevices();
    }
  };

  return {
    enabled: savedEnabled(),
    devices: [],
    deviceId: null,
    error: null,
    armed: false,
    paused: true,
    trackId: null,
    position: 0,
    duration: 0,
    updatedAt: 0,

    init: () => {
      if (get().enabled) void loadDevices();
      void poll();
      // Poll only while the tab is visible.
      setInterval(() => document.visibilityState === "visible" && void poll(), POLL_MS);
      setInterval(
        () => document.visibilityState === "visible" && get().enabled && !client.limited("/me/player") && void loadDevices(),
        DEVICES_MS,
      );
    },

    setEnabled: (on) => {
      try {
        localStorage.setItem(ENABLED_KEY, String(on));
      } catch {}
      set({ enabled: on, error: null, armed: false });
      if (on) void loadDevices().then(() => poll());
    },

    setDevice: (id) => {
      const device = get().devices.find((d) => d.id === id);
      try {
        if (device) localStorage.setItem(DEVICE_KEY, device.name);
      } catch {}
      set({ deviceId: id, error: null });
    },

    play: async (trackId, durationMs, startAt = START_AT) => {
      if (!get().enabled) return openInSpotify(trackId);
      set({ armed: true });
      // Play the track as a position in its album. A plain `uris: [track]` request is accepted
      // but loads nothing on this account (tested against the Mac app, 2026-11), while
      // album context + offset starts right away at the requested position.
      let context: string;
      try {
        context = await albumUri(trackId);
      } catch (e) {
        return set({ error: message(e) });
      }
      await command("PUT", "/me/player/play", {
        context_uri: context,
        offset: { uri: `spotify:track:${trackId}` },
        position_ms: Math.round(durationMs * startAt),
      });
    },

    autoplay: (trackId, durationMs) => {
      if (get().armed) void get().play(trackId, durationMs);
    },

    toggle: () => void command("PUT", get().paused ? "/me/player/play" : "/me/player/pause"),

    seekBy: (ms) => {
      const { position, duration, updatedAt, paused } = get();
      const now = paused ? position : position + (performance.now() - updatedAt);
      get().seekTo(Math.min(Math.max(now + ms, 0), duration));
    },

    seekTo: (ms) => {
      set({ position: ms, updatedAt: performance.now() }); // optimistic; the next poll corrects it
      void command("PUT", `/me/player/seek?position_ms=${Math.round(ms)}`);
    },
  };
});
