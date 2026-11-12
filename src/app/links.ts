// Turns pasted Spotify links into songs for the Build tab. Songs in the library are taken from it; others are
// fetched from Spotify, and one that is another release of a library song (same ISRC) becomes that song.
import { TRACK_FIELDS, trackFrom, type ApiTrack, type Library, type Track } from "../core/library.ts";
import type { SpotifyLink } from "../core/spotify.ts";
import { client } from "./auth.ts";

type ApiAlbum = { name: string; images: { url: string; width: number | null }[]; tracks: { items: ApiTrack[]; next: string | null } };

/** The songs behind each link, in order: library ids, plus the tracks of songs the library doesn't have. */
export async function resolveLinks(lib: Library, onMap: ReadonlySet<string>, links: SpotifyLink[]) {
  const byIsrc = new Map<string, string>();
  for (const t of Object.values(lib.tracks)) if (t.isrc && (!byIsrc.has(t.isrc) || onMap.has(t.id))) byIsrc.set(t.isrc, t.id);
  const ids: string[] = [];
  const extra: Track[] = [];
  const take = (t: Track | null) => {
    if (!t) return;
    const known = lib.tracks[t.id] ? t.id : t.isrc ? byIsrc.get(t.isrc) : undefined;
    ids.push(known ?? t.id);
    if (!known) extra.push(t);
  };

  for (const { kind, id } of links) {
    if (kind === "track") {
      if (lib.tracks[id]) ids.push(id);
      else take(trackFrom(await client.get<ApiTrack>(`/tracks/${id}`)));
    } else if (kind === "album") {
      const album = await client.get<ApiAlbum>(`/albums/${id}`);
      const rest = album.tracks.next ? await client.getAll<ApiTrack>(album.tracks.next) : [];
      // An album's track list leaves the album out of each track.
      for (const t of [...album.tracks.items, ...rest]) take(trackFrom({ ...t, album: { name: album.name, images: album.images } }));
    } else {
      const owned = lib.playlists.find((p) => p.id === id);
      if (owned) ids.push(...owned.trackIds);
      else {
        const items = await client.getAll<{ track: ApiTrack | null }>(`/playlists/${id}/tracks?limit=100&fields=next,items(track(${TRACK_FIELDS}))`);
        for (const item of items) take(trackFrom(item.track));
      }
    }
  }
  return { ids, extra };
}
