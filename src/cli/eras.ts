// Finds the musical eras in the play history and writes data/eras.json (see src/core/eras.ts).
//
//   pnpm eras
//
// Reads the same plays as `pnpm plays` (the Extended Streaming History plus the host's recording, other releases
// credited to the saved song), and the song traits from `pnpm tags` and `pnpm lyrics`. Plays of songs outside the
// library count toward listening time, artists and defining songs, but have no sound or themes; the coverage it
// prints per era says how much of each era's listening the sound and themes describe. Each era's written story comes
// from data/eras-chronicle.json, by era id; it lists eras that have none yet.
import { existsSync } from "node:fs";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Merge } from "../core/dedupe.ts";
import { findEras, type Chronicle, type SongName, type SongTraits } from "../core/eras.ts";
import { parseLanguages } from "../core/languages.ts";
import type { Library } from "../core/library.ts";
import { isListen, joinPlays, otherReleases, parseExport, parseLive, resolveMerges } from "../core/plays.ts";
import type { TagsFile } from "../core/tags.ts";
import type { ThemeData } from "../core/themes.ts";

const OUT = "data/eras.json";
/** Hand-written prose per era, keyed by era id (its first month); copied into the output. */
const CHRONICLE = "data/eras-chronicle.json";
const EXPORT_DIR = "data/extended-history";
const EXPORT_FILE = /^Streaming_History_Audio_.*\.json$/;
/** A live play has no length; it counts as this much when the song's duration isn't known either. */
const FALLBACK_MS = 180_000;

const readJson = async <T>(path: string) => JSON.parse(await readFile(path, "utf8")) as T;
const readLines = async (path: string) => (existsSync(path) ? (await readFile(path, "utf8")).split("\n").filter(Boolean) : []);

const { tracks } = await readJson<Library>("data/library.json");
const exportFiles = existsSync(EXPORT_DIR) ? (await readdir(EXPORT_DIR)).filter((f) => EXPORT_FILE.test(f)).sort() : [];
const exportRows = (await Promise.all(exportFiles.map((f) => readJson<Record<string, unknown>[]>(join(EXPORT_DIR, f))))).flat();
const liveRows = (await readLines("data/listening-history.jsonl")).map((line): unknown => {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
});

const recorded = liveRows.map(parseLive).filter((p) => p !== null);
const history = exportRows.map(parseExport).filter((p) => p !== null);
const merges = [...otherReleases([...recorded, ...history], tracks), ...(existsSync("data/merges.json") ? await readJson<Merge[]>("data/merges.json") : [])];
const { plays } = joinPlays(resolveMerges(recorded, merges), resolveMerges(history, merges));
const listens = plays.filter(isListen).map((p) => ({ trackId: p.trackId, at: p.at, ms: p.msPlayed ?? tracks[p.trackId]?.durationMs ?? FALLBACK_MS }));

// Names: the library's for saved songs, the export's for the rest (credited ids are saved songs, so the library has them).
const names = new Map<string, SongName>();
for (const row of exportRows) {
  const [uri, name, artist] = [row.spotify_track_uri, row.master_metadata_track_name, row.master_metadata_album_artist_name];
  if (typeof uri === "string" && typeof name === "string" && typeof artist === "string") names.set(uri.split(":").at(-1)!, { name, artist, saved: false });
}
for (const [id, t] of Object.entries(tracks)) names.set(id, { name: t.name, artist: t.artists[0]?.name ?? "", saved: true });

const tags = existsSync("data/tags.json") ? await readJson<TagsFile>("data/tags.json") : { genres: [], moods: [], songs: {} };
const themes = existsSync("data/themes.json") ? await readJson<ThemeData>("data/themes.json") : { themes: [], songs: [] };
const themeOf = new Map(themes.songs.map((s) => [s.key, s.scores]));
const languages = parseLanguages((await readLines("data/languages.jsonl")).join("\n"));
const traits = new Map<string, SongTraits>();
for (const [id, t] of Object.entries(tracks)) {
  const key = t.isrc ?? id;
  const tagged = tags.songs[id];
  const genres = tagged && tags.genres.map(() => 0);
  tagged?.[0].forEach((g, i) => (genres![g] = tagged[1][i]!));
  traits.set(id, { genres, moods: tagged?.[2], themes: themeOf.get(key), language: languages.get(key) });
}

const file = findEras(listens, traits, { genres: tags.genres, moods: tags.moods, themes: themes.themes }, names, new Date());
const chronicle = existsSync(CHRONICLE) ? await readJson<Chronicle>(CHRONICLE) : null;
if (chronicle) {
  file.intro = chronicle.intro;
  for (const era of file.eras) era.story = chronicle.eras[era.id];
}
await writeFile(OUT, JSON.stringify(file, null, 1));

const pct = (v: number) => `${Math.round(v * 100)}%`;
console.log(`${OUT}: ${file.eras.length} eras from ${listens.length} listens`);
if (file.before) console.log(`  before: ${file.before.from} to ${file.before.to}, ${file.before.hours} h (too thin to read)`);
console.log(`  split gains: ${file.gains.map(pct).join(" ")}`);
const unwritten = file.eras.filter((era) => !era.story).map((era) => era.id);
if (unwritten.length) console.log(`  no story in ${CHRONICLE} for: ${unwritten.join(", ")}`);
for (const era of file.eras) {
  const c = era.concentration;
  console.log(
    `  ${era.from}..${era.to}  ${Math.round(era.hours)} h  sound ${pct(era.coverage.sound)} lyrics ${pct(era.coverage.lyrics)}  busiest week ${pct(c.topWeek.share)}  top song ${pct(c.topSong.share)}`,
  );
}
