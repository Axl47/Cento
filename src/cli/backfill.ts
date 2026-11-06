// Adds every song in a sort-target playlist to the all-songs playlist if it's missing.
// Dry run by default; pass --apply to write to Spotify. Backs up the library first.
import { copyFile, mkdir } from "node:fs/promises";
import { client, LIBRARY_PATH, loadLibrary } from "./auth.ts";
import { config } from "../core/config.ts";
import { sortTargets } from "../core/library.ts";
import { addToPlaylist } from "../core/spotify.ts";

const apply = process.argv.includes("--apply");
const lib = await loadLibrary();
const all = lib.playlists.find((p) => p.id === config.allPlaylistId);
if (!all) throw new Error(`All-songs playlist ${config.allPlaylistId} not found; run \`pnpm export\``);

const present = new Set(all.trackIds);
const missing = [...new Set(sortTargets(lib).flatMap((p) => p.trackIds))].filter((id) => !present.has(id));
console.log(`"${all.name}" has ${all.trackIds.length} songs; ${missing.length} sorted songs are missing from it.`);

if (!apply) {
  console.log("Dry run. Re-run with --apply to add them.");
} else if (missing.length) {
  await mkdir("data/backups", { recursive: true });
  const backup = `data/backups/library-${lib.fetchedAt.replace(/[:.]/g, "-")}.json`;
  await copyFile(LIBRARY_PATH, backup);
  console.log(`Backed up library to ${backup}`);
  await addToPlaylist(client, all.id, missing);
  console.log(`Added ${missing.length} songs. Run \`pnpm export\` to refresh the local library.`);
}
