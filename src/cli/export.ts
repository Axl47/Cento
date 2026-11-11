// Refreshes data/library.json from Spotify and writes Stemma input: data/tracks.jsonl (every track).
import { client } from "./auth.ts";
import { exportLibrary, LIBRARY_PATH } from "./libraryFiles.ts";
import { inbox, sortTargets } from "../core/library.ts";

const lib = await exportLibrary(client, (m) => console.log(`  ${m}`));
console.log(
  `\n${lib.playlists.length} owned playlists (${sortTargets(lib).length} sort targets), ` +
    `${lib.liked.length} liked (${inbox(lib).length} unsorted), ${Object.keys(lib.tracks).length} unique tracks` +
    `\nWrote ${LIBRARY_PATH} and data/tracks.jsonl`,
);
