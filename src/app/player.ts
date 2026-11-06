// In-browser Spotify playback (Web Playback SDK; needs Premium). The page registers as a
// Spotify Connect device; `play` starts a track partway in so you land near the hook.
//
// Browsers only allow audio after a user gesture on the page. Until the first click or key
// press (`unlock`, wired up in App), `play` just remembers the track and the UI shows a hint;
// the gesture then activates the SDK's audio element and starts the remembered track.
import { create } from "zustand";
import { accessToken, client } from "./auth.ts";

/** Where previews start, as a share of the track's length. */
export const START_AT = 0.35;

/** `auth` errors need a new login; the rest are fixed by retrying or switching browser. */
export type PlayerError = { kind: "auth" | "account" | "init" | "playback"; message: string };

type PlayerState = {
  deviceId: string | null;
  error: PlayerError | null;
  /** Whether a user gesture has unlocked audio on this page. */
  unlocked: boolean;
  /** A track waiting for the first gesture (or for the device to come up). */
  pending: { trackId: string; durationMs: number } | null;
  paused: boolean;
  trackId: string | null;
  position: number;
  duration: number;
  /** performance.now() when `position` was read, for smooth progress between events. */
  updatedAt: number;

  init: () => void;
  /** Call synchronously from a click/keydown handler. */
  unlock: () => void;
  play: (trackId: string, durationMs: number) => Promise<void>;
  toggle: () => void;
  seekBy: (ms: number) => void;
  seekTo: (ms: number) => void;
};

let player: Spotify.Player | null = null;

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export const usePlayer = create<PlayerState>()((set, get) => ({
  deviceId: null,
  error: null,
  unlocked: false,
  pending: null,
  paused: true,
  trackId: null,
  position: 0,
  duration: 0,
  updatedAt: 0,

  init: () => {
    if (document.getElementById("spotify-sdk")) return;
    window.onSpotifyWebPlaybackSDKReady = () => {
      player = new window.Spotify.Player({
        name: "Playlist Sorter",
        getOAuthToken: (cb) => void accessToken().then(cb),
        volume: 0.6,
      });
      const fail =
        (kind: PlayerError["kind"]) =>
        ({ message }: Spotify.Error) =>
          set({ error: { kind, message } });
      player.addListener("initialization_error", fail("init"));
      player.addListener("authentication_error", fail("auth"));
      player.addListener("account_error", () => set({ error: { kind: "account", message: "Playback needs Spotify Premium." } }));
      player.addListener("playback_error", fail("playback"));
      // Not in the SDK's type definitions yet: fired when the browser blocks audio.
      (player.addListener as (event: string, cb: () => void) => void)("autoplay_failed", () =>
        set({ unlocked: false, error: null }),
      );
      player.addListener("ready", ({ device_id }) => {
        set({ deviceId: device_id, error: null });
        const { pending, unlocked } = get();
        if (pending && unlocked) void get().play(pending.trackId, pending.durationMs);
      });
      player.addListener("not_ready", () => set({ deviceId: null }));
      player.addListener("player_state_changed", (state) => {
        if (!state) return;
        set({
          paused: state.paused,
          trackId: state.track_window.current_track?.id ?? null,
          position: state.position,
          duration: state.duration,
          updatedAt: performance.now(),
        });
      });
      void player.connect();
    };
    const script = document.createElement("script");
    script.id = "spotify-sdk";
    script.src = "https://sdk.scdn.co/spotify-player.js";
    document.body.appendChild(script);
  },

  unlock: () => {
    if (get().unlocked || !player) return;
    void player.activateElement(); // must run inside the gesture
    set({ unlocked: true });
    const { pending } = get();
    if (pending) void get().play(pending.trackId, pending.durationMs);
  },

  play: async (trackId, durationMs) => {
    const { deviceId, unlocked } = get();
    if (!deviceId || !unlocked) return void set({ pending: { trackId, durationMs } });
    set({ pending: null, error: null });
    const body = { uris: [`spotify:track:${trackId}`], position_ms: Math.round(durationMs * START_AT) };
    try {
      await client.request("PUT", `/me/player/play?device_id=${deviceId}`, body);
    } catch (first) {
      // A just-registered device can briefly 404 ("Device not found"); retry once.
      await new Promise((r) => setTimeout(r, 1000));
      try {
        await client.request("PUT", `/me/player/play?device_id=${deviceId}`, body);
      } catch {
        set({ error: { kind: "playback", message: errorText(first) } });
      }
    }
  },

  toggle: () => void player?.togglePlay(),

  seekBy: (ms) => {
    const { position, duration, updatedAt, paused } = get();
    const now = paused ? position : position + (performance.now() - updatedAt);
    get().seekTo(Math.min(Math.max(now + ms, 0), duration));
  },

  seekTo: (ms) => {
    void player?.seek(ms);
    set({ position: ms, updatedAt: performance.now() });
  },
}));
