// Playback by remote control: the app tells one of your Spotify apps (Spotify Connect device,
// e.g. the Mac desktop app) what to play, and shows the position Spotify reports. Audio never
// plays in the page, so there's no DRM, no browser autoplay policy, and your output device
// stays where it is. Needs Premium and Spotify open on at least one device.
import { create } from "zustand";
import { client } from "./auth.ts";

/** Where previews start, as a share of the track's length. */
export const START_AT = 0.35;

const POLL_MS = 1000;
const DEVICES_MS = 15_000;
const DEVICE_KEY = "spotify-device-name"; // device ids change between app restarts; names don't
/** The in-page player earlier versions registered; Spotify lists it for a while after. */
const OLD_IN_PAGE_DEVICE = "Playlist Sorter";

export type Device = { id: string; name: string; type: string; is_active: boolean; is_restricted: boolean };

type ApiPlayback = {
  is_playing: boolean;
  progress_ms: number | null;
  device: { id: string } | null;
  item: { id: string; duration_ms: number; linked_from?: { id: string } } | null;
};

type PlayerState = {
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
  setDevice: (id: string) => void;
  /** Explicit play (Space, Play button, clicking a song); also arms autoplay. */
  play: (trackId: string, durationMs: number) => Promise<void>;
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
const savedDeviceName = () => {
  try {
    return localStorage.getItem(DEVICE_KEY);
  } catch {
    return null;
  }
};

export const usePlayer = create<PlayerState>()((set, get) => {
  /** Re-reads playback state from Spotify. */
  const poll = async () => {
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
    } catch {
      // Transient; the next poll retries.
    }
  };

  /** Refreshes the device list and keeps a sensible target selected. */
  const loadDevices = async () => {
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
    } catch (e) {
      set({ error: message(e) });
    }
  };

  /** Sends a player command to the target device; on failure explains and refreshes devices. */
  const command = async (method: string, path: string, body?: unknown) => {
    const { deviceId, devices } = get();
    if (!deviceId) {
      await loadDevices();
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
      set({ error: notFound ? `Spotify isn't reachable on ${name}. Open Spotify there, or pick another device.` : message(e) });
      void loadDevices();
    }
  };

  return {
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
      void loadDevices();
      void poll();
      // Poll only while the tab is visible.
      setInterval(() => document.visibilityState === "visible" && void poll(), POLL_MS);
      setInterval(() => document.visibilityState === "visible" && void loadDevices(), DEVICES_MS);
    },

    setDevice: (id) => {
      const device = get().devices.find((d) => d.id === id);
      try {
        if (device) localStorage.setItem(DEVICE_KEY, device.name);
      } catch {}
      set({ deviceId: id, error: null });
    },

    play: async (trackId, durationMs) => {
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
        position_ms: Math.round(durationMs * START_AT),
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
