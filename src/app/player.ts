// In-browser Spotify playback (Web Playback SDK; needs Premium). The page registers as a
// Spotify Connect device; `play` starts a track partway in so you land near the hook.
import { create } from "zustand";
import { accessToken, client } from "./auth.ts";

/** Where previews start, as a share of the track's length. */
export const START_AT = 0.35;

type PlayerState = {
  deviceId: string | null;
  error: string | null;
  paused: boolean;
  trackId: string | null;
  position: number;
  duration: number;
  /** performance.now() when `position` was read, for smooth progress between events. */
  updatedAt: number;

  init: () => void;
  play: (trackId: string, durationMs: number) => Promise<void>;
  toggle: () => void;
  seekBy: (ms: number) => void;
  seekTo: (ms: number) => void;
};

let player: Spotify.Player | null = null;

export const usePlayer = create<PlayerState>()((set, get) => ({
  deviceId: null,
  error: null,
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
      const fail = ({ message }: Spotify.Error) => set({ error: message });
      player.addListener("initialization_error", fail);
      player.addListener("authentication_error", fail);
      player.addListener("account_error", () => set({ error: "Playback needs Spotify Premium." }));
      player.addListener("playback_error", fail);
      player.addListener("ready", ({ device_id }) => set({ deviceId: device_id, error: null }));
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

  play: async (trackId, durationMs) => {
    const { deviceId } = get();
    if (!deviceId || !player) return;
    await player.activateElement(); // satisfies browser autoplay rules after a user gesture
    try {
      await client.request("PUT", `/me/player/play?device_id=${deviceId}`, {
        uris: [`spotify:track:${trackId}`],
        position_ms: Math.round(durationMs * START_AT),
      });
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e) });
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
