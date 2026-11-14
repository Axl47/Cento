// Analyzes skips in Spotify's Extended Streaming History and writes data/skips.json.
//
//   pnpm skips
//
// Reads the export's Streaming_History_Audio_*.json files (data/extended-history/), the library, and from Stemma's
// cache (~/.cache/audio-embed-engine, or ENGINE_CACHE) each song's per-second loudness and vocal span
// (features/features.jsonl), its 2 s mix embeddings (patches/), and its lyrics status (lyrics.jsonl).
// Plays of other releases of a saved song count for the saved one, as in `pnpm plays`. Prints the findings.
import { existsSync, openSync, readSync } from "node:fs";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Merge } from "../core/dedupe.ts";
import type { EngineFeatures } from "../core/features.ts";
import type { Library } from "../core/library.ts";
import { isListen, otherReleases, resolveMerges } from "../core/plays.ts";
import {
  autoStarted,
  baselineHazard,
  chainedSkips,
  crowding,
  familiarity,
  histogram,
  INSTANT_MS,
  isBail,
  liftBy,
  novelty,
  parseExportPlay,
  peaks,
  phaseOf,
  PHASES,
  profileAround,
  SAMPLED_MS,
  seeded,
  songCurves,
  startsAtTop,
  strataLift,
  TAIL_SHARE,
  type ExportPlay,
  type Lift,
  type ScoredPlay,
  type SkipsFile,
} from "../core/skips.ts";
import { decodeTags, type TagsFile } from "../core/tags.ts";

const OUT = "data/skips.json";
const EXPORT_DIR = "data/extended-history";
const ENGINE = process.env.ENGINE_CACHE ?? join(homedir(), ".cache/audio-embed-engine");
/** Seconds per patch row: 128 mel frames at a 256-sample hop of 16 kHz audio. */
const PATCH_S = (128 * 256) / 16_000;
const PATCH_DIM = 1280;
/** The engine's audio is matched to the Spotify track by ISRC; a version this far off in length isn't the same cut. */
const ALIGN_S = 2;
/** How many seconds a reaction takes: signals are read this long before the second the skip landed in. */
const LAG = 3;
const CROWD_MIN_BAILS = 8;
const CROWD_WIDTH = 10;

const readJson = async <T>(path: string) => JSON.parse(await readFile(path, "utf8")) as T;
const lines = async <T>(path: string) => (await readFile(path, "utf8")).split("\n").filter(Boolean).map((l) => JSON.parse(l) as T);
const pct = (x: number) => `${(100 * x).toFixed(1)}%`;
/** Lift with a rough 95% band from the Poisson noise of the observed count (too narrow where one song's repeat plays dominate). */
const fmtLift = (l: Lift) => `${l.lift.toFixed(2)} ±${((1.96 * l.lift) / Math.sqrt(Math.max(l.observed, 1))).toFixed(2)}`;
const orderOf = (lifts: Map<string, Lift>, order?: readonly string[]) =>
  order ? order.filter((k) => lifts.has(k)) : [...lifts.keys()].sort((a, b) => lifts.get(b)!.expected - lifts.get(a)!.expected);
const printLifts = (title: string, lifts: Map<string, Lift>, order?: readonly string[]) => {
  console.log(`\n${title}`);
  for (const k of orderOf(lifts, order)) {
    const l = lifts.get(k)!;
    console.log(`  ${k.padEnd(22)} ${fmtLift(l)}  (${l.observed} vs ${l.expected.toFixed(0)} expected)`);
  }
};
/** A trait's lift against context alone, then also against the song's standing (its lifetime listens). */
const printTrait = (title: string, plain: Map<string, Lift & { plays: number }>, controlled: Map<string, Lift>, order?: readonly string[]) => {
  console.log(`\n${title}  [plays, skips, lift vs context, lift vs context + standing]`);
  for (const k of orderOf(plain, order)) {
    const [a, b] = [plain.get(k)!, controlled.get(k)!];
    console.log(`  ${k.padEnd(22)} ${String(a.plays).padStart(6)} ${String(a.observed).padStart(5)}   ${fmtLift(a)}   ${fmtLift(b)}`);
  }
};

// ---- Plays ----

const exportFiles = (await readdir(EXPORT_DIR)).filter((f) => /^Streaming_History_Audio_.*\.json$/.test(f)).sort();
const rows = (await Promise.all(exportFiles.map((f) => readJson<unknown[]>(join(EXPORT_DIR, f))))).flat();
const { tracks } = await readJson<Library>("data/library.json");
const parsed = rows.map(parseExportPlay).filter((p) => p !== null);
const merges = [...otherReleases(parsed, tracks), ...(existsSync("data/merges.json") ? await readJson<Merge[]>("data/merges.json") : [])];
const plays: ExportPlay[] = resolveMerges(parsed, merges)
  .map((p, i) => ({ ...parsed[i]!, trackId: p.trackId }))
  .sort((a, b) => a.at - b.at);
const durationMs = new Map(Object.entries(tracks).map(([id, t]) => [id, t.durationMs]));
const inLibrary = plays.filter((p) => durationMs.has(p.trackId));
const bails = plays.filter(isBail);

// ---- 1. Where in a song ----

console.log(`${plays.length} track plays, ${bails.length} ended with the forward button; ${inLibrary.length} plays are of library songs`);
const firstMinute = histogram(
  bails.map((p) => p.msPlayed / 1000),
  [0, 1, 2, 3, 5, 10, 15, 20, 30, 45, 60, 90, 120, 180, 240],
);
console.log("\nSkips by seconds played (all plays):");
firstMinute.edges.forEach((e, i) => console.log(`  ${String(e).padStart(4)} s+  ${String(firstMinute.counts[i]).padStart(6)}  ${pct(firstMinute.counts[i]! / bails.length)}`));
console.log(`  skips that came straight after another skip (skimming the queue): ${chainedSkips(plays)}`);

const libraryBails = inLibrary.filter((p) => isBail(p) && startsAtTop(p));
const phaseCounts = (ps: readonly ExportPlay[]) => {
  const counts = Object.fromEntries(PHASES.map((ph) => [ph, 0])) as Record<(typeof PHASES)[number], number>;
  for (const p of ps) counts[phaseOf(p.msPlayed, durationMs.get(p.trackId)!)]++;
  return counts;
};
const phases = phaseCounts(libraryBails);
console.log(`\nLibrary skips from the top of the song (${libraryBails.length}) by phase:`);
for (const ph of PHASES) console.log(`  ${ph.padEnd(8)} ${String(phases[ph]).padStart(6)}  ${pct(phases[ph] / libraryBails.length)}`);
for (const [label, filter] of [
  ["shuffle on", (p: ExportPlay) => p.shuffle],
  ["shuffle off", (p: ExportPlay) => !p.shuffle],
  ["queue moved on (auto)", autoStarted],
  ["picked (clickrow)", (p: ExportPlay) => p.reasonStart === "clickrow"],
] as const) {
  const sub = libraryBails.filter(filter);
  const c = phaseCounts(sub);
  console.log(`  ${label.padEnd(22)} n=${sub.length}: ${PHASES.map((ph) => `${ph} ${pct(c[ph] / sub.length)}`).join(", ")}`);
}
for (const key of ["year", "device"] as const) {
  const groups = new Map<string, ExportPlay[]>();
  for (const p of libraryBails) {
    const k = key === "year" ? String(new Date(p.at).getUTCFullYear()) : p.device;
    groups.set(k, [...(groups.get(k) ?? []), p]);
  }
  console.log(`  by ${key}: ` + [...groups].sort().filter(([, ps]) => ps.length >= 500).map(([k, ps]) => {
    const c = phaseCounts(ps);
    return `${k} n=${ps.length} instant ${pct(c.instant / ps.length)} mid ${pct(c.mid / ps.length)}`;
  }).join("; "));
}
const midBails = libraryBails.filter((p) => phaseOf(p.msPlayed, durationMs.get(p.trackId)!) === "mid");
const fraction = histogram(
  midBails.map((p) => p.msPlayed / durationMs.get(p.trackId)!),
  Array.from({ length: 9 }, (_, i) => i / 10),
);
console.log("\nMid-song skips by share of the song played:");
fraction.edges.forEach((e, i) => console.log(`  ${pct(e).padStart(6)}+  ${String(fraction.counts[i]).padStart(6)}  ${pct(fraction.counts[i]! / midBails.length)}`));

// ---- 2. When in a song: per-second signals from the engine ----

type EngineLine = EngineFeatures & { dur: number };
const engineByKey = new Map<string, EngineLine>();
for (const line of await lines<EngineLine | { key: string; error: string }>(join(ENGINE, "features/features.jsonl")))
  if (!("error" in line)) engineByKey.set(line.key, line);
const keyOf = (id: string) => tracks[id]?.isrc ?? id;
/** Songs whose engine audio has the Spotify track's length, so its seconds line up with the play's. */
const aligned = new Map<string, EngineLine>();
for (const [id, t] of Object.entries(tracks)) {
  const e = engineByKey.get(keyOf(id));
  if (e && Math.abs(e.dur - t.durationMs / 1000) <= ALIGN_S) aligned.set(id, e);
}

/** Loudness at each second relative to the song's own integrated loudness, LU (`st[k]` is at k + 1 s). */
const relLoud = new Map([...aligned].map(([id, e]) => [id, [null, ...e.loud.st.map((v) => v - e.loud.lufs)]]));
/** Loudness over the last 4 s minus the 8 s before them: negative when the song just got quieter. */
const loudChange = new Map(
  [...relLoud].map(([id, xs]) => {
    const mean = (from: number, to: number) => {
      const vs = xs.slice(Math.max(from, 1), to).filter((v) => v !== null);
      return vs.length ? vs.reduce((a, b) => a + b, 0) / vs.length : null;
    };
    return [id, xs.map((_, s) => (s < 12 ? null : (mean(s - 3, s + 1)! ?? 0) - (mean(s - 11, s - 3) ?? 0)))];
  }),
);

// Section changes from the patch embeddings, read one song at a time out of the 2.6 GB patch file.
const patchIndex = new Map((await lines<{ key: string; start: number; n: number }>(join(ENGINE, "patches/index.jsonl"))).map((r) => [r.key, r]));
const patchFile = openSync(join(ENGINE, "patches/patches.f32"), "r");
const noveltyPerSecond = new Map<string, number[]>();
const sectionStarts = new Map<string, number[]>();
for (const id of aligned.keys()) {
  const at = patchIndex.get(keyOf(id));
  if (!at || at.n < 12) continue;
  const buffer = Buffer.alloc(at.n * PATCH_DIM * 4);
  readSync(patchFile, buffer, 0, buffer.length, at.start * PATCH_DIM * 4);
  const nov = novelty(new Float32Array(buffer.buffer, buffer.byteOffset, at.n * PATCH_DIM), PATCH_DIM);
  const seconds = Math.ceil(at.n * PATCH_S);
  noveltyPerSecond.set(id, Array.from({ length: seconds }, (_, s) => nov[Math.round(s / PATCH_S)] ?? 0));
  sectionStarts.set(id, peaks(nov).map((i) => i * PATCH_S));
}

const curves = new Map([...songCurves(inLibrary, durationMs)].filter(([id]) => aligned.has(id)));
const baseline = baselineHazard(curves.values());
const curveBails = [...curves.values()].reduce((n, c) => n + c.bails.reduce((a, b) => a + b, 0), 0);
console.log(`\nMoments: ${curves.size} songs line up with the engine's audio, with ${curveBails} mid-song skips between them`);
console.log(`  baseline skips per 1000 plays still going, per second: ${[30, 60, 90, 120, 180, 240].map((s) => `${s}s ${(1000 * (baseline[s] ?? NaN)).toFixed(2)}`).join(", ")}`);

const offsets = Array.from({ length: 21 }, (_, i) => i * 2 - 30);
const show = (title: string, rows: ReturnType<typeof profileAround>) => {
  console.log(`\n${title} (offset s: around skips / expected)`);
  console.log("  " + rows.map((r) => `${r.offset}: ${r.observed.toFixed(2)}/${r.expected.toFixed(2)}`).join("  "));
};
show("Loudness vs song average, LU", profileAround(curves, baseline, (id) => relLoud.get(id), offsets));
show("Sound change (patch novelty)", profileAround(curves, baseline, (id) => noveltyPerSecond.get(id), offsets));

const lagged = (s: number) => s - LAG;
const vocalPhase = (id: string, s: number) => {
  const { first, last, share } = aligned.get(id)!.voc;
  const t = lagged(s);
  if (share < 0.1 || first === null || last === null) return null;
  if (t < first) return "before vocals";
  if (t < first + 10) return "0-10 s into vocals";
  if (t > last) return "after vocals end";
  return "vocal section";
};
printLifts("Skips by where the vocals are (lift vs where in the song time alone puts them):", liftBy(curves, baseline, vocalPhase), [
  "before vocals",
  "0-10 s into vocals",
  "vocal section",
  "after vocals end",
]);
const loudBucket = (id: string, s: number) => {
  const v = relLoud.get(id)![lagged(s)];
  if (v === null || v === undefined) return null;
  return v < -10 ? "< -10 LU" : v < -5 ? "-10..-5 LU" : v < -2 ? "-5..-2 LU" : v < 2 ? "-2..+2 LU" : "> +2 LU";
};
printLifts("Skips by loudness vs the song's average:", liftBy(curves, baseline, loudBucket), ["< -10 LU", "-10..-5 LU", "-5..-2 LU", "-2..+2 LU", "> +2 LU"]);
const changeBucket = (id: string, s: number) => {
  const v = loudChange.get(id)![lagged(s)];
  if (v === null || v === undefined) return null;
  return v <= -6 ? "dropped 6+ LU" : v <= -3 ? "dropped 3-6 LU" : v < 3 ? "steady" : v < 6 ? "rose 3-6 LU" : "rose 6+ LU";
};
printLifts("Skips by loudness change over the last ~12 s:", liftBy(curves, baseline, changeBucket), [
  "dropped 6+ LU",
  "dropped 3-6 LU",
  "steady",
  "rose 3-6 LU",
  "rose 6+ LU",
]);
const sinceSection = (id: string, s: number) => {
  const starts = sectionStarts.get(id);
  if (!starts) return null;
  const t = lagged(s);
  const last = starts.filter((x) => x <= t).at(-1);
  if (last === undefined) return "first section";
  const d = t - last;
  return d < 4 ? "0-4 s after change" : d < 8 ? "4-8 s after" : d < 16 ? "8-16 s after" : "16+ s after";
};
printLifts("Skips by time since the last section change:", liftBy(curves, baseline, sinceSection), [
  "first section",
  "0-4 s after change",
  "4-8 s after",
  "8-16 s after",
  "16+ s after",
]);

const random = seeded(47);
const crowded = [...curves]
  .filter(([, c]) => c.bails.reduce((a, b) => a + b, 0) >= CROWD_MIN_BAILS)
  .map(([id, c]) => ({ id, ...crowding(c, baseline, CROWD_WIDTH, 200, random) }));
const significant = crowded.filter((c) => c.p < 0.05);
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? NaN;
console.log(
  `\nCrowding: ${crowded.length} songs with ${CROWD_MIN_BAILS}+ mid-song skips; ${significant.length} (${pct(significant.length / crowded.length)}, 5% by chance) ` +
    `crowd into one ${CROWD_WIDTH} s window more than chance. Median peak share ${pct(median(crowded.map((c) => c.observed)))} vs ${pct(median(crowded.map((c) => c.expected)))} simulated.`,
);

// ---- 3. Which songs: traits against familiarity, standing, era, device and shuffle ----

const listensBefore: number[] = [];
const lifetime = new Map<string, number>();
{
  const seen = new Map<string, number>();
  plays.forEach((p, i) => {
    listensBefore[i] = seen.get(p.trackId) ?? 0;
    if (isListen(p)) seen.set(p.trackId, listensBefore[i]! + 1);
  });
  for (const [id, n] of seen) lifetime.set(id, n);
}
/** What a play is compared within: familiarity when it came up, year, device, shuffle. */
const contextOf = (p: ExportPlay, i: number) =>
  [
    familiarity(listensBefore[i]!),
    new Date(p.at).getUTCFullYear(),
    p.device,
    p.shuffle,
  ].join("|");
// Early: of auto-started plays that got past 3 s (quicker skips are skimming, before any audio could matter), the ones
// skipped by 30 s. Mid: of those that got past 30 s, the ones skipped before the last 10%.
const early: ScoredPlay[] = [];
const mid: ScoredPlay[] = [];
plays.forEach((p, i) => {
  const duration = durationMs.get(p.trackId);
  if (duration === undefined || !autoStarted(p) || p.msPlayed < INSTANT_MS) return;
  const base = {
    trackId: p.trackId,
    shuffle: p.shuffle,
    context: contextOf(p, i),
    standing: familiarity((lifetime.get(p.trackId) ?? 0) - Number(isListen(p))),
  };
  early.push({ ...base, skipped: isBail(p) && p.msPlayed < SAMPLED_MS });
  if (p.msPlayed >= SAMPLED_MS) mid.push({ ...base, skipped: isBail(p) && p.msPlayed < TAIL_SHARE * duration });
});
const byContext = (p: ScoredPlay) => p.context;
const byStanding = (p: ScoredPlay) => `${p.context}|${p.standing}`;

const features = engineByKey;
const lyricStatus = new Map(
  existsSync(join(ENGINE, "lyrics.jsonl")) ? (await lines<{ key: string; status: string }>(join(ENGINE, "lyrics.jsonl"))).map((l) => [l.key, l.status]) : [],
);
const language = new Map((await lines<{ key: string; language: string }>("data/languages.jsonl")).map((l) => [l.key, l.language]));
const tags = decodeTags(await readJson<TagsFile>("data/tags.json"));
const topGenres = new Set(
  Array.from(
    [...tags.values()]
    .map((t) => t.genres[0]![0])
    .reduce((m, g) => m.set(g, (m.get(g) ?? 0) + 1), new Map<string, number>())
    .entries(),
  )
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([g]) => g),
);

const traits: [string, (id: string) => string | null, string[]?][] = [
  [
    "vocal share",
    (id) => {
      const v = features.get(keyOf(id))?.voc.share;
      return v === undefined ? null : v < 0.1 ? "none (<10%)" : v < 0.4 ? "low (10-40%)" : v < 0.7 ? "mid (40-70%)" : "high (70%+)";
    },
    ["none (<10%)", "low (10-40%)", "mid (40-70%)", "high (70%+)"],
  ],
  [
    "vocals start",
    (id) => {
      const f = features.get(keyOf(id))?.voc;
      if (!f) return null;
      if (f.first === null || f.share < 0.1) return "never";
      return f.first < 5 ? "0-5 s" : f.first < 15 ? "5-15 s" : f.first < 30 ? "15-30 s" : "30 s+";
    },
    ["0-5 s", "5-15 s", "15-30 s", "30 s+", "never"],
  ],
  [
    "opening loudness",
    (id) => {
      const l = features.get(keyOf(id))?.loud;
      if (!l) return null;
      const intro = l.st.slice(0, 10).reduce((a, b) => a + b, 0) / Math.min(10, l.st.length) - l.lufs;
      return intro < -8 ? "quiet open (< -8 LU)" : intro < -3 ? "softer open" : "full open";
    },
    ["quiet open (< -8 LU)", "softer open", "full open"],
  ],
  ["lyrics", (id) => lyricStatus.get(keyOf(id)) ?? null, ["ok", "instrumental", "not_found"]],
  [
    "language",
    (id) => {
      const status = lyricStatus.get(keyOf(id));
      if (status === "instrumental") return "instrumental";
      const l = language.get(keyOf(id));
      return l === undefined ? null : ["en", "es", "ja"].includes(l) ? l : "other";
    },
    ["en", "es", "ja", "other", "instrumental"],
  ],
  [
    "top genre",
    (id) => {
      const g = tags.get(id)?.genres[0]?.[0];
      return g === undefined ? null : topGenres.has(g) ? g : "other";
    },
  ],
];
for (const [label, set] of [
  ["early skip (3-30 s), shuffle on", early.filter((p) => p.shuffle)],
  ["early skip (3-30 s), shuffle off", early.filter((p) => !p.shuffle)],
  ["mid-song skip given 30 s heard, shuffle on", mid.filter((p) => p.shuffle)],
  ["mid-song skip given 30 s heard, shuffle off", mid.filter((p) => !p.shuffle)],
] as const) {
  const rate = set.filter((p) => p.skipped).length / set.length;
  console.log(`\n==== ${label}: ${set.length} auto-started plays, ${pct(rate)} skipped`);
  for (const [name, trait, order] of traits) printTrait(`${name}:`, strataLift(set, byContext, trait), strataLift(set, byStanding, trait), order);
}
{
  const byFamiliarity = new Map<string, [number, number]>();
  early.forEach((p) => {
    const k = p.context.split("|")[0]!;
    const [s, n] = byFamiliarity.get(k) ?? [0, 0];
    byFamiliarity.set(k, [s + Number(p.skipped), n + 1]);
  });
  console.log(`\nRaw early-skip rate (3-30 s) by earlier listens: ${["new", "1-2", "3-9", "10-29", "30+"].map((k) => `${k} ${pct(byFamiliarity.get(k)![0] / byFamiliarity.get(k)![1])}`).join(", ")}`);
}

// ---- data/skips.json ----

const earlyBySong = strataLift(early, byStanding, (id) => id);
const midBySong = strataLift(mid, byStanding, (id) => id);
const peakBySong = new Map(significant.map((c) => [c.id, c.peakAt]));
const round2 = (x: number) => Math.round(x * 100) / 100;
const file: SkipsFile = {
  generatedAt: new Date().toISOString(),
  songs: Object.fromEntries(
    [...earlyBySong].map(([id, e]) => {
      const m = midBySong.get(id);
      return [id, [e.plays, e.observed, round2(e.expected), m?.observed ?? 0, round2(m?.expected ?? 0), peakBySong.get(id) ?? null]];
    }),
  ),
};
await writeFile(OUT, JSON.stringify(file));
console.log(`\n${OUT}: ${Object.keys(file.songs).length} songs`);
