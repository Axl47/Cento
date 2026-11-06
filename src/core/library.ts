// The local snapshot of the Spotify library that the scripts and the app work from,
// and the sync that refreshes it from Spotify.
import { config } from "./config.ts";
import type { SpotifyClient } from "./spotify.ts";

export type Track = {
  id: string;
  name: string;
  artists: { id: string; name: string }[];
  album: { name: string; imageUrl: string | null };
  isrc: string | null;
  durationMs: number;
};

export type Playlist = {
  id: string;
  name: string;
  imageUrl: string | null;
  trackIds: string[];
};

export type Library = {
  fetchedAt: string;
  userId: string;
  /** Playlists the user owns. */
  playlists: Playlist[];
  liked: { id: string; addedAt: string }[];
  tracks: Record<string, Track>;
};

/** Playlists that can be suggested: owned, not the all-songs playlist, not ignored. */
export const sortTargets = (lib: Library) =>
  lib.playlists.filter((p) => p.id !== config.allPlaylistId && !config.ignoredPlaylistIds.includes(p.id));

/** Liked songs that are in no sort target yet: the inbox. */
export function inbox(lib: Library) {
  const sorted = new Set(sortTargets(lib).flatMap((p) => p.trackIds));
  return lib.liked.filter((l) => !sorted.has(l.id));
}

type ApiImage = { url: string; width: number | null };
type ApiTrack = {
  id: string | null;
  name: string;
  type: string;
  is_local: boolean;
  duration_ms: number;
  external_ids?: { isrc?: string };
  artists: { id: string; name: string }[];
  album?: { name: string; images: ApiImage[] };
};
type ApiPlaylist = {
  id: string;
  name: string;
  owner: { id: string };
  images: ApiImage[] | null;
};

const TRACK_FIELDS =
  "id,name,type,is_local,duration_ms,external_ids(isrc),artists(id,name),album(name,images(url,width))";

/** Smallest image at least 64px wide, or the first one. */
const pickImage = (images: ApiImage[] | null | undefined) =>
  images?.toSorted((a, b) => (a.width ?? 0) - (b.width ?? 0)).find((i) => (i.width ?? 640) >= 64)?.url ??
  images?.[0]?.url ??
  null;

/**
 * Fetches owned playlists and Liked Songs. Every playlist is refetched: Spotify's
 * snapshot_id and list totals can stay stale after edits, so they can't gate caching.
 */
export async function syncLibrary(
  client: SpotifyClient,
  onProgress: (message: string) => void = () => {},
): Promise<Library> {
  const tracks: Record<string, Track> = {};
  const keep = (t: ApiTrack | null): string | null => {
    if (!t?.id || t.is_local || t.type !== "track") return null;
    tracks[t.id] ??= {
      id: t.id,
      name: t.name,
      artists: t.artists.map(({ id, name }) => ({ id, name })),
      album: { name: t.album?.name ?? "", imageUrl: pickImage(t.album?.images) },
      isrc: t.external_ids?.isrc?.toUpperCase() ?? null,
      durationMs: t.duration_ms,
    };
    return t.id;
  };

  const me = await client.get<{ id: string }>("/me");
  const owned = (await client.getAll<ApiPlaylist>("/me/playlists?limit=50")).filter((p) => p.owner.id === me.id);

  const playlists: Playlist[] = [];
  for (const p of owned) {
    onProgress(`Fetching ${p.name}`);
    const items = await client.getAll<{ track: ApiTrack | null }>(
      `/playlists/${p.id}/tracks?limit=100&fields=next,items(track(${TRACK_FIELDS}))`,
    );
    const trackIds = [...new Set(items.map((i) => keep(i.track)).filter((id) => id !== null))];
    playlists.push({ id: p.id, name: p.name, imageUrl: pickImage(p.images), trackIds });
  }

  onProgress("Fetching Liked Songs");
  const likedItems = await client.getAll<{ added_at: string; track: ApiTrack }>("/me/tracks?limit=50");
  const liked = likedItems.flatMap((i) => {
    const id = keep(i.track);
    return id ? [{ id, addedAt: i.added_at }] : [];
  });

  return { fetchedAt: new Date().toISOString(), userId: me.id, playlists, liked, tracks };
}
