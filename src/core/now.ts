// What's playing and what the library knows about it. Shared by the main app's Now Playing tab and by the
// host, which builds the same picture for screens that have no Spotify login or library of their own.
import type { AudioIndex } from "./audio.ts";
import { firstAdded, sortTargets, type Library } from "./library.ts";
import type { PlanInfo } from "./segue.ts";
import type { Neighbors } from "./suggest.ts";
import { songThemes, type ThemeIndex } from "./themes.ts";

export type ApiPlayback = {
  is_playing: boolean;
  progress_ms: number | null;
  device: { id: string } | null;
  item: {
    id: string;
    duration_ms: number;
    linked_from?: { id: string };
    name: string;
    artists?: { name: string }[];
    album?: { name: string; images: { url: string; width: number | null }[] };
  } | null;
};

export type Playback = {
  trackId: string | null;
  paused: boolean;
  position: number;
  duration: number;
  /** What Spotify says is playing, including songs that aren't in the library, with its largest cover. */
  current: { name: string; artists: string[]; album: string; imageUrl: string | null } | null;
};

export const NOTHING_PLAYING: Playback = { trackId: null, paused: true, position: 0, duration: 0, current: null };

/** Spotify's reply, or nothing at all when no device is active, as the app's picture of playback. */
export function readPlayback(p: ApiPlayback | undefined): Playback {
  if (!p?.item) return NOTHING_PLAYING;
  return {
    trackId: p.item.linked_from?.id ?? p.item.id,
    paused: !p.is_playing,
    position: p.progress_ms ?? 0,
    duration: p.item.duration_ms,
    current: {
      name: p.item.name,
      artists: (p.item.artists ?? []).map((a) => a.name),
      album: p.item.album?.name ?? "",
      imageUrl: p.item.album?.images.toSorted((a, b) => (b.width ?? 0) - (a.width ?? 0))[0]?.url ?? null,
    },
  };
}

export type NowPanels = {
  added: string | null;
  playlists: { id: string; name: string }[];
  about: { names: string[]; passage: string } | null;
  similar: { id: string; name: string; artist: string }[];
  /** Whether the song has a place on the sound map. */
  mapped: boolean;
};

/** Segue's part of Now Playing: the song it blends in next (`in_ms` negative during the blend) and whether +/− would grade one. */
export type SegueInfo = { next: { label: string; kind: PlanInfo["kind"]; in_ms: number | null } | null; markable: boolean };

/** What a screen shows: the playback of `source`, which is Spotify or Segue (see `pickSource` in segue.ts). */
export type NowState = Playback & { source: "spotify" | "segue" | null; segue: SegueInfo | null; panels: NowPanels | null; error: string | null };

const SIMILAR = 5;

/** Everything shown beside the song; null for songs outside the library. */
export function nowPanels(lib: Library, audio: AudioIndex | null, neighbors: Neighbors | undefined, themes: ThemeIndex | null, trackId: string): NowPanels | null {
  const track = lib.tracks[trackId];
  if (!track) return null;
  const about = themes ? songThemes(themes, track) : [];
  return {
    added: firstAdded(lib).get(trackId) ?? null,
    playlists: sortTargets(lib)
      .filter((p) => p.trackIds.includes(trackId))
      .map(({ id, name }) => ({ id, name })),
    about: about[0] ? { names: about.map((m) => m.name), passage: about[0].passage } : null,
    similar: (neighbors?.(trackId) ?? []).slice(0, SIMILAR).flatMap((n) => {
      const t = lib.tracks[n.id];
      return t ? [{ id: t.id, name: t.name, artist: t.artists[0]?.name ?? "" }] : [];
    }),
    mapped: !!audio?.ids.includes(trackId),
  };
}

/** The sound map's data without covers, dates or anything else a screen doesn't need. */
export function mapLibrary(lib: Library, hidden: readonly string[]): Library {
  return {
    fetchedAt: lib.fetchedAt,
    userId: "",
    liked: [],
    playlists: sortTargets(lib, hidden).map(({ id, name, trackIds }) => ({ id, name, imageUrl: null, trackIds })),
    tracks: Object.fromEntries(
      Object.values(lib.tracks).map((t) => [t.id, { id: t.id, name: t.name, artists: t.artists, album: { name: "", imageUrl: null }, isrc: null, durationMs: 0 }]),
    ),
  };
}

const PLAYING_POLL_MS = 15_000;
const PAUSED_POLL_MS = 60_000;
/** How long after a song should have ended to look for the next one. */
const AFTER_END_MS = 800;

/** When to ask Spotify next: rarely, plus right when the song should have ended, so a change shows at once. */
export function nextPollMs({ paused, trackId, duration, position }: Playback) {
  if (paused || !trackId) return PAUSED_POLL_MS;
  return Math.min(PLAYING_POLL_MS, Math.max(duration - position, 0) + AFTER_END_MS);
}
