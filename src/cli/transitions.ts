// What makes the user skip the next song on shuffle: how it fits what came before (sound, tempo, loudness at the
// seam, key) against which song it is. Reads Spotify's Extended Streaming History and prints the comparison.
//
//   pnpm transitions
//
// Needs data/extended-history/ (see AGENTS.md), and data/audio.json, data/vectors.bin, data/edges.bin and
// data/features.json (`pnpm audio`, `pnpm edges`, `pnpm features`) for the songs' sound.
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { positions, similarity, decodeVectors, type AudioIndex } from "../core/audio.ts";
import { camelotSteps, decodeFeatures, KEY_STRENGTH, tempoRatio, type FeaturesFile } from "../core/features.ts";
import { otherReleases, resolveMerges } from "../core/plays.ts";
import { handoff, type Sound } from "../core/setlist.ts";
import { parseExportPlay } from "../core/skips.ts";
import { difference, rate, shuffleSeams, songPersistence, withinSong, type Rate, type Seam } from "../core/transitions.ts";
import { loadLibrary, loadMerges } from "./libraryFiles.ts";

const EXPORT_DIR = "data/extended-history";
const EXPORT_FILE = /^Streaming_History_Audio_.*\.json$/;
/** Songs need this many measured seams to be compared with themselves. */
const MIN_SEAMS = 8;
/** Songs need this many seams to be split in time. */
const MIN_PERSISTENCE = 20;

const readJson = async <T>(path: string) => JSON.parse(await readFile(path, "utf8")) as T;

const files = (await readdir(EXPORT_DIR)).filter((f) => EXPORT_FILE.test(f)).sort();
const rows = (await Promise.all(files.map((f) => readJson<unknown[]>(join(EXPORT_DIR, f))))).flat();
const parsed = rows.map(parseExportPlay).filter((p) => p !== null);
const library = await loadLibrary();
// Plays of another release of a saved song, or of a merged copy, count as the saved song.
const resolved = resolveMerges(parsed, [...otherReleases(parsed, library.tracks), ...(await loadMerges())]);
const plays = parsed.map((p, i) => ({ ...p, trackId: resolved[i]!.trackId })).sort((a, b) => a.at - b.at);
const seams = shuffleSeams(plays);

const index = await readJson<AudioIndex>("data/audio.json");
const readVectors = async (path: string) => {
  const buf = await readFile(path);
  return decodeVectors(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
};
const vectors = await readVectors("data/vectors.bin");
const edges = await readVectors("data/edges.bin");
const sound: Sound = { index, vectors, edges };
const pos = positions(index);
const features = decodeFeatures(await readJson<FeaturesFile>("data/features.json"));

const sim = (a: string, b: string) => {
  const [i, j] = [pos.get(a), pos.get(b)];
  return i === undefined || j === undefined ? null : similarity(vectors, i, j);
};
const pair = (s: Seam) => {
  const [a, b] = [features.get(s.from), features.get(s.to)];
  return a && b ? { a, b } : null;
};

/** Each way a song can fit what came before, as a distance: lower is a closer fit. */
const distances: [label: string, distance: (s: Seam) => number | null][] = [
  ["sound of the song before", (s) => {
    const x = sim(s.from, s.to);
    return x === null ? null : 1 - x;
  }],
  ["end of it vs start of this", (s) => {
    const [i, j] = [pos.get(s.from), pos.get(s.to)];
    return i === undefined || j === undefined ? null : 1 - similarity(edges, 2 * i + 1, 2 * j);
  }],
  ["Build's handoff score", (s) => (pos.has(s.from) && pos.has(s.to) ? 1 - handoff(sound, s.from, s.to) : null)],
  ["sound of the session so far", (s) => {
    const xs = s.recent.map((r) => sim(r, s.to)).filter((x) => x !== null);
    return xs.length < 3 ? null : 1 - xs.reduce((t, x) => t + x, 0) / xs.length;
  }],
  ["tempo change", (s) => {
    const p = pair(s);
    return p && p.a.steady && p.b.steady && p.a.bpm && p.b.bpm ? Math.abs(tempoRatio(p.a.bpm, p.b.bpm) - 1) : null;
  }],
  ["loudness jump at the seam", (s) => {
    const p = pair(s);
    return p ? Math.abs(p.b.intro - p.a.outro) : null;
  }],
  ["key distance", (s) => {
    const p = pair(s);
    return p && p.a.keyStrength >= KEY_STRENGTH && p.b.keyStrength >= KEY_STRENGTH ? camelotSteps(p.a.camelot, p.b.camelot) : null;
  }],
];

const pct = (r: Rate) => `${(rate(r) * 100).toFixed(1)}%`;
const total = (xs: readonly Seam[]): Rate => ({ skips: xs.filter((s) => s.skipped).length, n: xs.length });

function compare(title: string, group: readonly Seam[], measures: typeof distances) {
  console.log(`\n${title}: skipped ${pct(total(group))} of ${group.length}. The same song, after a closer vs a farther fit:`);
  for (const [label, distance] of measures) {
    const { close, far, songs } = withinSong(group, distance, MIN_SEAMS);
    const { points, margin } = difference(close, far);
    console.log(`  ${label.padEnd(28)} ${pct(close).padStart(6)} vs ${pct(far).padStart(6)}  ${points >= 0 ? "+" : ""}${points.toFixed(1)} ± ${margin.toFixed(1)} pts  (${songs} songs)`);
  }
}

const afterListen = seams.filter((s) => !s.afterSkip);
const afterSkip = seams.filter((s) => s.afterSkip);
console.log(`${files.length} export file(s): ${seams.length} shuffle seams where the next song came up on its own`);
compare("After a song played through", afterListen, distances);
compare("After a skip", afterSkip, distances.slice(0, 4));
const { least, most, songs } = songPersistence(afterListen, MIN_PERSISTENCE);
console.log(
  `\nWhich song it is: of ${songs} songs, the fifth skipped least in the earlier half of their seams were later skipped ${pct(least)}, the fifth skipped most ${pct(most)}.`,
);
