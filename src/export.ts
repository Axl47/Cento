// Pulls editable playlists and Liked Songs into data/library.json.
// Playlists whose snapshot_id is unchanged since the last run are not refetched.
// Also writes JSONL track lists in the audio-embed-engine input format.
import { mkdir, writeFile } from "node:fs/promises";
import { get, getAll } from "./spotify.ts";
import { findAllPlaylist, LIBRARY_PATH, loadLibrary, type Library, type Playlist, type Track } from "./library.ts";

type ApiTrack = {
  id: string | null;
  name: string;
  type: string;
  is_local: boolean;
  duration_ms: number;
  external_ids?: { isrc?: string };
  artists: { id: string; name: string }[];
};
type ApiPlaylist = {
  id: string;
  name: string;
  snapshot_id: string;
  collaborative: boolean;
  owner: { id: string };
};

const TRACK_FIELDS = "id,name,type,is_local,duration_ms,external_ids(isrc),artists(id,name)";
const tracks: Record<string, Track> = {};

/** Records a track and returns its id, or null for local files, episodes and removed tracks. */
function keep(t: ApiTrack | null): string | null {
  if (!t?.id || t.is_local || t.type !== "track") return null;
  tracks[t.id] ??= {
    id: t.id,
    name: t.name,
    artists: t.artists.map(({ id, name }) => ({ id, name })),
    isrc: t.external_ids?.isrc?.toUpperCase() ?? null,
    durationMs: t.duration_ms,
  };
  return t.id;
}

const previous = await loadLibrary().catch(() => undefined);
const me = await get<{ id: string }>("/me");

const editable = (await getAll<ApiPlaylist>("/me/playlists?limit=50")).filter(
  (p) => p.owner.id === me.id || p.collaborative,
);

const playlists: Playlist[] = [];
for (const p of editable) {
  const cached = previous?.playlists.find((c) => c.id === p.id && c.snapshotId === p.snapshot_id);
  if (cached) {
    for (const id of cached.trackIds) if (previous?.tracks[id]) tracks[id] ??= previous.tracks[id];
    playlists.push(cached);
    continue;
  }
  const items = await getAll<{ track: ApiTrack | null }>(
    `/playlists/${p.id}/tracks?limit=100&fields=next,total,items(track(${TRACK_FIELDS}))`,
  );
  const trackIds = [...new Set(items.map((i) => keep(i.track)).filter((id) => id !== null))];
  playlists.push({ id: p.id, name: p.name, snapshotId: p.snapshot_id, trackIds });
  console.log(`  ${p.name}: ${trackIds.length} tracks`);
}

const likedItems = await getAll<{ added_at: string; track: ApiTrack }>("/me/tracks?limit=50");
const liked = likedItems.flatMap((i) => {
  const id = keep(i.track);
  return id ? [{ id, addedAt: i.added_at }] : [];
});

const lib: Library = { fetchedAt: new Date().toISOString(), userId: me.id, playlists, liked, tracks };
await mkdir("data", { recursive: true });
await writeFile(LIBRARY_PATH, JSON.stringify(lib));

// Engine input: every track, plus a smaller sample spread round-robin across sort playlists.
const toJsonl = (ids: Iterable<string>) =>
  [...ids]
    .map((id) => tracks[id])
    .filter((t) => t !== undefined)
    .map((t) =>
      JSON.stringify({ isrc: t.isrc, title: t.name, artists: t.artists.map((a) => a.name), durationMs: t.durationMs, key: t.id }),
    )
    .join("\n") + "\n";

const all = findAllPlaylist(lib);
const sortTargets = playlists.filter((p) => p.id !== all?.id && p.trackIds.length > 0);
const sample = new Set<string>();
for (let i = 0; sample.size < 150 && sortTargets.some((p) => i < p.trackIds.length); i++) {
  for (const p of sortTargets) {
    const id = p.trackIds[i];
    if (id && sample.size < 150) sample.add(id);
  }
}
await writeFile("data/tracks.jsonl", toJsonl(Object.keys(tracks)));
await writeFile("data/sample-tracks.jsonl", toJsonl(sample));

console.log(
  `\n${playlists.length} editable playlists, ${liked.length} liked, ${Object.keys(tracks).length} unique tracks` +
    `\nAll-songs playlist: ${all ? `"${all.name}" (${all.trackIds.length})` : "not detected (set ALL_PLAYLIST)"}` +
    `\nWrote ${LIBRARY_PATH}, data/tracks.jsonl, data/sample-tracks.jsonl (${sample.size})`,
);
