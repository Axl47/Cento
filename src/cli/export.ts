// Refreshes data/library.json from Spotify and
// writes Stemma input: data/tracks.jsonl (every track).
import { writeFile } from "node:fs/promises";
import { client, LIBRARY_PATH, saveLibrary } from "./auth.ts";
import { inbox, syncLibrary, sortTargets, type Track } from "../core/library.ts";

const lib = await syncLibrary(client, (m) => console.log(`  ${m}`));
await saveLibrary(lib);

const toJsonl = (tracks: Track[]) =>
  tracks
    .map((t) =>
      JSON.stringify({ isrc: t.isrc, title: t.name, artists: t.artists.map((a) => a.name), durationMs: t.durationMs, key: t.id }),
    )
    .join("\n") + "\n";
await writeFile("data/tracks.jsonl", toJsonl(Object.values(lib.tracks)));

console.log(
  `\n${lib.playlists.length} owned playlists (${sortTargets(lib).length} sort targets), ` +
    `${lib.liked.length} liked (${inbox(lib).length} unsorted), ${Object.keys(lib.tracks).length} unique tracks` +
    `\nWrote ${LIBRARY_PATH} and data/tracks.jsonl`,
);
