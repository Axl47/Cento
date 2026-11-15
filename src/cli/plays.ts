// Builds data/plays.json: how often each library song was played and skipped, and when it last played.
//
//   pnpm plays
//
// Joins the host's recording (data/listening-history.jsonl) with Spotify's Extended Streaming History, when its
// Streaming_History_Audio_*.json files are in data/extended-history/, counting plays from days both cover once.
// Plays of copies `pnpm merge-copies` replaced count for the copy it kept, and plays of another release of a saved
// song (same ISRC, or same title and artist in the export) count for the saved one; a replaced copy still in the
// library shows the counts of the one kept. Runs with either source alone.
import { existsSync } from "node:fs";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Merge } from "../core/dedupe.ts";
import type { Library } from "../core/library.ts";
import { joinPlays, otherReleases, parseExport, parseLive, playsFile, resolveMerges, shareWithCopies, type Play } from "../core/plays.ts";

const OUT = "data/plays.json";
const HISTORY = "data/listening-history.jsonl";
const EXPORT_DIR = "data/extended-history";
const EXPORT_FILE = /^Streaming_History_Audio_.*\.json$/;

const readJson = async <T>(path: string) => JSON.parse(await readFile(path, "utf8")) as T;
const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const span = (plays: readonly Play[]) => (plays.length ? `${day(plays[0]!.at)} to ${day(plays.at(-1)!.at)}` : "none");
const byTime = (plays: Play[]) => plays.sort((a, b) => a.at - b.at);

/** Parses rows, warning about any that aren't plays of a track: podcasts and local files in the export, damaged lines in the history. */
function parseAll(rows: unknown[], parse: (row: unknown) => Play | null, what: string) {
  const plays = rows.map(parse).filter((play) => play !== null);
  if (plays.length < rows.length) console.log(`  ${what}: skipped ${rows.length - plays.length} row(s) that aren't track plays`);
  return byTime(plays);
}

const liveLines = existsSync(HISTORY) ? (await readFile(HISTORY, "utf8")).split("\n").filter(Boolean) : [];
const liveRows = liveLines.map((line): unknown => {
  try {
    return JSON.parse(line);
  } catch {
    return null; // a half-written row; counted as skipped below
  }
});
const exportFiles = existsSync(EXPORT_DIR) ? (await readdir(EXPORT_DIR)).filter((f) => EXPORT_FILE.test(f)).sort() : [];
const exportRows = (await Promise.all(exportFiles.map((f) => readJson<unknown[]>(join(EXPORT_DIR, f))))).flat();

const { tracks } = await readJson<Library>("data/library.json");
const recorded = parseAll(liveRows, parseLive, "live");
const history = parseAll(exportRows, parseExport, "export");
const merges = [...otherReleases([...recorded, ...history], tracks), ...(existsSync("data/merges.json") ? await readJson<Merge[]>("data/merges.json") : [])];
const live = resolveMerges(recorded, merges);
const exported = resolveMerges(history, merges);
const { plays, matched } = joinPlays(live, exported);
const { file, outside } = playsFile(plays, tracks, new Date());
shareWithCopies(file, merges, tracks);
await writeFile(OUT, JSON.stringify(file));

console.log(`${OUT}: ${plays.length} plays of ${Object.keys(file.songs).length} songs, ${file.from?.slice(0, 10) ?? "none"} to ${file.to?.slice(0, 10) ?? "none"}`);
console.log(`  live: ${live.length} plays (${span(live)})`);
console.log(
  exportFiles.length
    ? `  export: ${exported.length} plays (${span(exported)}) from ${exportFiles.length} file(s); ${matched} live plays were already in it`
    : `  export: none yet (put its Streaming_History_Audio_*.json files in ${EXPORT_DIR}/)`,
);
console.log(`  not in the library: ${outside} plays`);
const [exportEnd, liveStart] = [exported.at(-1)?.at, live[0]?.at];
if (exportEnd !== undefined && liveStart !== undefined && liveStart > exportEnd) {
  console.log(`  gap: nothing recorded between the export's last play (${new Date(exportEnd).toISOString()}) and the first live one (${new Date(liveStart).toISOString()})`);
}
