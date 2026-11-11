// Trains the per-playlist sound classifiers from the sorted library and the engine's vectors, and
// writes data/classifier.json for the app. Run after `pnpm audio`; the app also runs it after a resync.
//
// Engine command: ENGINE_CLASSIFY in .env, or by default the engine in ENGINE_DIR.
// `--no-sync` because a sync would remove the engine's optional benchmark packages.
import { execSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { loadLibrary } from "./libraryFiles.ts";
import { parseLanguages } from "../core/languages.ts";
import { sortTargets } from "../core/library.ts";
import type { ArtistRules } from "../core/suggest.ts";

const readJson = <T,>(path: string, fallback: T) =>
  readFile(path, "utf8")
    .then((s) => JSON.parse(s) as T)
    .catch(() => fallback);

const { ENGINE_DIR, ENGINE_CLASSIFY } = process.env;
if (!ENGINE_DIR) throw new Error("Set ENGINE_DIR in .env");
const command =
  ENGINE_CLASSIFY ?? `uv run --no-sync --project ${JSON.stringify(ENGINE_DIR)} audio-embed classify {input} --vectors {vectors} --out {output}`;

const lib = await loadLibrary();
const hidden = await readJson<string[]>("data/hidden.json", []);
const rules = await readJson<ArtistRules>("data/rules.json", {});
const MAX_ONE_ALBUM = 0.5;

/** Whether most of the playlist is one album. It's then easy to recognize by production, which says nothing about a new song. */
function isAlbum(trackIds: string[]) {
  const counts = new Map<string, number>();
  for (const id of trackIds) {
    const album = lib.tracks[id]?.album.name ?? "";
    counts.set(album, (counts.get(album) ?? 0) + 1);
  }
  return Math.max(0, ...counts.values()) > MAX_ONE_ALBUM * trackIds.length;
}

// A playlist with an artist rule is decided by the rule, never by sound. Playlists left out here
// fall back to the nearest-neighbor vote.
const targets = sortTargets(lib, hidden).filter((p) => !rules[p.id]?.length && !isAlbum(p.trackIds));
console.log(`Left out as single albums: ${sortTargets(lib, hidden).filter((p) => isAlbum(p.trackIds)).map((p) => p.name).join(", ") || "none"}`);

const labels = new Map<string, string[]>();
for (const p of targets) for (const id of new Set(p.trackIds)) labels.set(id, [...(labels.get(id) ?? []), p.id]);

// From the engine's `audio-embed languages`, keyed by ISRC or, without one, track id. Songs missing here use sound alone.
const languageRows = await readFile("data/languages.jsonl", "utf8").catch(() => "");
const languages = parseLanguages(languageRows);

const input = resolve("data/classifier-input.jsonl");
await writeFile(
  input,
  Object.values(lib.tracks)
    .map((t) =>
      JSON.stringify({
        key: t.id,
        artists: t.artists.map((a) => a.id),
        labels: labels.get(t.id) ?? [],
        language: languages.get(t.isrc ?? t.id),
      }),
    )
    .join("\n"),
);
const cmd = command
  .replaceAll("{input}", JSON.stringify(input))
  .replaceAll("{vectors}", JSON.stringify(resolve("data/vectors.jsonl")))
  .replaceAll("{output}", JSON.stringify(resolve("data/classifier.json")));
execSync(cmd, { cwd: ENGINE_DIR, stdio: "inherit" });
