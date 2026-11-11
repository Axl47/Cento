// Merges copies of one recording (identical vectors in data/vectors.jsonl, e.g. a song saved from its single and
// from the album): the album copy replaces the others in every playlist and in Liked Songs. Copies of other
// people's playlists are left alone. Dry run by default; pass --apply to write to Spotify. Backs up the library
// first. Run `pnpm export` before, so it works from what's on Spotify now.
import { copyFile, mkdir, readFile } from "node:fs/promises";
import { client, LIBRARY_PATH, loadLibrary } from "./auth.ts";
import { config } from "../core/config.ts";
import { planDedupe, type Release } from "../core/dedupe.ts";
import { addToPlaylist, chunks, removeFromPlaylist, setLiked } from "../core/spotify.ts";

const apply = process.argv.includes("--apply");
const lib = await loadLibrary();

// Tracks with identical vectors, keyed by the vector's text.
const byVector = new Map<string, string[]>();
for (const line of (await readFile("data/vectors.jsonl", "utf8")).split("\n")) {
  if (!line.trim()) continue;
  const { key, vector } = JSON.parse(line) as { key: string; vector?: number[] };
  if (!vector || !lib.tracks[key]) continue;
  const text = vector.join();
  byVector.set(text, [...(byVector.get(text) ?? []), key]);
}
const groups = [...byVector.values()].filter((g) => g.length > 1);

const releases = new Map<string, Release>();
type ApiAlbum = { album_type: string; release_date: string; total_tracks: number };
for (const batch of chunks(groups.flat(), 50)) {
  const { tracks } = await client.get<{ tracks: ({ id: string; album: ApiAlbum } | null)[] }>(`/tracks?ids=${batch.join(",")}`);
  for (const t of tracks)
    if (t) releases.set(t.id, { albumType: t.album.album_type, releaseDate: t.album.release_date, totalTracks: t.album.total_tracks });
}

const plan = planDedupe(lib, groups, releases, config.ignoredPlaylistIds);
const describe = (id: string) => {
  const r = releases.get(id);
  return `${lib.tracks[id]?.album.name} (${r?.albumType ?? "?"}, ${r?.releaseDate ?? "?"})`;
};
for (const { main, copies } of plan.merges) {
  const t = lib.tracks[main]!;
  console.log(`${t.name} — ${t.artists.map((a) => a.name).join(", ")}\n  keep ${describe(main)}\n  drop ${copies.map(describe).join("; ")}`);
}
console.log(`\n${plan.merges.length} songs with copies.`);
for (const [id, { add, remove }] of plan.playlists)
  console.log(`  ${lib.playlists.find((p) => p.id === id)?.name}: +${add.length} −${remove.length}`);
if (plan.unlike.length) console.log(`  Liked Songs: +${plan.like.length} −${plan.unlike.length}`);

if (!apply) {
  console.log("\nDry run. Re-run with --apply to make these changes on Spotify.");
} else if (plan.merges.length) {
  await mkdir("data/backups", { recursive: true });
  const backup = `data/backups/library-${lib.fetchedAt.replace(/[:.]/g, "-")}.json`;
  await copyFile(LIBRARY_PATH, backup);
  console.log(`\nBacked up library to ${backup}`);
  // Add before removing, so an interrupted run never leaves a song out of a playlist.
  for (const [id, { add, remove }] of plan.playlists) {
    await addToPlaylist(client, id, add);
    await removeFromPlaylist(client, id, remove);
  }
  await setLiked(client, plan.like, true);
  await setLiked(client, plan.unlike, false);
  console.log("Done. Run `pnpm export` to refresh the local library.");
}
