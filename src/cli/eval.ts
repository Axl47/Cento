// Offline check of the suggestion model on songs that are already sorted. 5-fold
// cross-validation: each song's memberships are hidden and predicted from the other 80%.
// Uses the same `suggest` as the app, with audio neighbors when data/audio.json exists.
//
// Scenarios:
//   cold        nothing picked yet: rank all playlists
//   first pick  one true playlist is revealed (you picked it): rank the rest
// "most common" is the baseline: every song gets the playlists with the most training songs.
import { readFile } from "node:fs/promises";
import { loadLibrary } from "./libraryFiles.ts";
import { neighborsFrom, type AudioIndex } from "../core/audio.ts";
import { classifierFrom, type ClassifierData } from "../core/classifier.ts";
import { inbox, sortTargets } from "../core/library.ts";
import { buildModel, knownArtistSongs, prechecked, suggest, type ArtistRules, type Neighbors } from "../core/suggest.ts";
import { PRECHECK } from "../core/config.ts";

const FOLDS = 5;
const lib = await loadLibrary();
const audio = await readFile("data/audio.json", "utf8")
  .then((s) => neighborsFrom(JSON.parse(s) as AudioIndex))
  .catch(() => undefined);

// A sorted song's classifier score comes from models that never saw it or its artists, so it's fair to use here.
const classifier = await readFile("data/classifier.json", "utf8")
  .then((s) => classifierFrom(JSON.parse(s) as ClassifierData))
  .catch(() => undefined);

const rules = await readFile("data/rules.json", "utf8")
  .then((s) => JSON.parse(s) as ArtistRules)
  .catch(() => ({}));
const hidden = await readFile("data/hidden.json", "utf8")
  .then((s) => JSON.parse(s) as string[])
  .catch(() => []);
const full = buildModel(lib, { rules, hidden });

const sorted = [...full.membership.keys()].filter((id) => lib.tracks[id]);

let seed = 42;
const rand = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
const shuffled = sorted.map((id) => ({ id, r: rand() })).sort((a, b) => a.r - b.r).map((x) => x.id);

const results = new Map<string, { sum: number; count: number }>();
function record(key: string, value: number) {
  const r = results.get(key) ?? { sum: 0, count: 0 };
  r.sum += value;
  r.count++;
  results.set(key, r);
}
const recall = (ranked: string[], truth: string[], k: number) =>
  ranked.slice(0, k).filter((p) => truth.includes(p)).length / truth.length;

const variants: [string, Neighbors | undefined][] = [["no audio", undefined]];
if (audio) variants.push(["with audio", audio]);
if (audio && classifier) variants.push(["classifier", audio]);

for (let f = 0; f < FOLDS; f++) {
  const test = shuffled.filter((_, i) => i % FOLDS === f);
  const trainIds = new Set(shuffled.filter((_, i) => i % FOLDS !== f));
  const plain = buildModel(lib, { rules, hidden, trainIds });
  const withClassifier = buildModel(lib, { rules, hidden, trainIds, classifier });
  const sizes = new Map<string, number>();
  for (const id of trainIds) for (const p of full.membership.get(id)!) sizes.set(p, (sizes.get(p) ?? 0) + 1);
  const mostCommon = [...sizes].sort((a, b) => b[1] - a[1]).map(([p]) => p);

  for (const id of test) {
    const track = lib.tracks[id]!;
    const truth = full.membership.get(id)!;
    const bucket = knownArtistSongs(plain, track).size > 0 ? "known" : "new";
    const picked = truth[Math.floor(rand() * truth.length)]!;
    const hasAudio = audio ? audio(id).length > 0 : false;
    for (const k of [1, 3, 5]) for (const b of ["all", bucket]) record(`cold|most common|R@${k}|${b}`, recall(mostCommon, truth, k));

    for (const [name, nb] of variants) {
      if (nb && !hasAudio) continue; // compare like with like: only songs that have audio
      const model = name === "classifier" ? withClassifier : plain;
      const scored = suggest(model, track, [], nb);
      const cold = scored.map((s) => s.playlistId);
      // Prechecked suggestions (what the app checks for you): how many, and how many are right.
      const checked = prechecked(model, track, scored);
      for (const b of ["all", bucket]) {
        record(`pre|${name}|count|${b}`, checked.length);
        if (checked.length) record(`pre|${name}|precision|${b}`, checked.filter((p) => truth.includes(p)).length / checked.length);
        record(`pre|${name}|recall|${b}`, checked.filter((p) => truth.includes(p)).length / truth.length);
      }
      for (const k of [1, 3, 5]) for (const b of ["all", bucket]) record(`cold|${name}|R@${k}|${b}`, recall(cold, truth, k));

      if (truth.length < 2) continue;
      const rest = truth.filter((p) => p !== picked);
      const after = suggest(model, track, [picked], nb).map((s) => s.playlistId).filter((p) => p !== picked);
      for (const k of [2, 3]) for (const b of ["all", bucket]) record(`pick|${name}|R@${k}|${b}`, recall(after, rest, k));
    }
  }
}

// ---- report ----
const counts = sorted.map((id) => full.membership.get(id)!.length);
const dist = [1, 2, 3, 4].map((k) => counts.filter((c) => (k === 4 ? c >= 4 : c === k)).length);
const pct = (x: number) => `${(x * 100).toFixed(0)}%`.padStart(5);
const cell = (key: string) => {
  const r = results.get(key);
  return r ? `${pct(r.sum / r.count)} (n=${r.count})`.padEnd(15) : "-".padEnd(15);
};

console.log(`Sort playlists: ${sortTargets(lib, hidden).length}   sorted songs: ${sorted.length}   liked & unsorted: ${inbox(lib, hidden).length}`);
console.log(`Playlists per sorted song: 1→${dist[0]}  2→${dist[1]}  3→${dist[2]}  4+→${dist[3]}`);
console.log(`Artist rules: ${Object.values(rules).filter((a) => a.length).length} playlists (data/rules.json)   hidden: ${hidden.length} (data/hidden.json)`);

console.log(audio ? "Audio index: loaded (with-audio rows use only songs that have audio)" : "Audio index: none (data/audio.json missing)");
console.log(`\nRecall@k = share of a song's true playlists in the top k suggestions.`);
console.log(`"known" = other songs by the artist were in training; "new" = none were.\n`);

const avg = (key: string) => {
  const r = results.get(key);
  return r ? (r.sum / r.count).toFixed(2).padEnd(15) : "-".padEnd(15);
};
console.log(`PRECHECKED (score >= ${PRECHECK})`.padEnd(28) + "all".padEnd(15) + "known".padEnd(15) + "new");
for (const [name] of variants) {
  console.log(`  ${name} checked/song`.padEnd(28) + ["all", "known", "new"].map((b) => avg(`pre|${name}|count|${b}`)).join(""));
  console.log(`  ${name} precision`.padEnd(28) + ["all", "known", "new"].map((b) => cell(`pre|${name}|precision|${b}`)).join(""));
  console.log(`  ${name} recall`.padEnd(28) + ["all", "known", "new"].map((b) => cell(`pre|${name}|recall|${b}`)).join(""));
}
console.log();

for (const [scenario, title, ks] of [["cold", "COLD (nothing picked yet)", [1, 3, 5]], ["pick", "AFTER FIRST PICK (songs in 2+)", [2, 3]]] as const) {
  console.log(title.padEnd(28) + "all".padEnd(15) + "known".padEnd(15) + "new");
  for (const name of [...(scenario === "cold" ? ["most common"] : []), ...variants.map(([n]) => n)])
    for (const k of ks)
      console.log(`  ${name} R@${k}`.padEnd(28) + ["all", "known", "new"].map((b) => cell(`${scenario}|${name}|R@${k}|${b}`)).join(""));
  console.log();
}
