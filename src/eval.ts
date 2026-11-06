// Offline check of how well artist overlap and playlist pairings predict where a song
// belongs, using only songs that are already sorted. 5-fold cross-validation: each
// song's memberships are hidden and predicted from the other 80% of songs.
//
// Two scenarios:
//   cold        nothing known about the song: rank all playlists
//   first pick  one true playlist is revealed (you picked it): rank the rest
import { findAllPlaylist, loadLibrary } from "./library.ts";

const FOLDS = 5;
const ARTIST_SMOOTHING = 1; // pseudo-songs pulling sparse artist counts toward the prior

const lib = await loadLibrary();
const allPlaylist = findAllPlaylist(lib);
const targets = lib.playlists.filter((p) => p.id !== allPlaylist?.id && p.trackIds.length > 0);
const P = targets.length;

// trackId -> indices of the target playlists it is in
const membership = new Map<string, number[]>();
targets.forEach((p, i) => {
  for (const id of p.trackIds) membership.set(id, [...(membership.get(id) ?? []), i]);
});
const sorted = [...membership.keys()].filter((id) => lib.tracks[id]);

// Seeded shuffle so runs are comparable.
let seed = 42;
const rand = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
const shuffled = sorted.map((id) => ({ id, r: rand() })).sort((a, b) => a.r - b.r).map((x) => x.id);

type Model = {
  prior: number[];
  /** artistId -> training songs credited to that artist */
  artist: Map<string, { songs: Set<string> }>;
  /** pair[r][p] = P(song in p | song in r) */
  pair: number[][];
};

function train(ids: string[]): Model {
  const size = Array<number>(P).fill(0);
  const co = Array.from({ length: P }, () => Array<number>(P).fill(0));
  const artist: Model["artist"] = new Map();
  for (const id of ids) {
    const ms = membership.get(id) ?? [];
    for (const r of ms) {
      size[r]!++;
      for (const p of ms) co[r]![p]!++;
    }
    for (const a of lib.tracks[id]?.artists ?? []) {
      const entry = artist.get(a.id) ?? { songs: new Set<string>() };
      entry.songs.add(id);
      artist.set(a.id, entry);
    }
  }
  const total = size.reduce((s, x) => s + x, 0);
  return {
    prior: size.map((s) => s / total),
    artist,
    pair: co.map((row, r) => row.map((c) => (size[r] ? c / size[r]! : 0))),
  };
}

/** Smoothed share of this song's artists' other songs that are in each playlist. */
function artistScores(m: Model, id: string): { scores: number[]; n: number } {
  const songs = new Set<string>();
  for (const a of lib.tracks[id]?.artists ?? []) for (const s of m.artist.get(a.id)?.songs ?? []) songs.add(s);
  const counts = Array<number>(P).fill(0);
  for (const s of songs) for (const p of membership.get(s) ?? []) counts[p]!++;
  const n = songs.size;
  return { n, scores: counts.map((c, p) => (c + ARTIST_SMOOTHING * m.prior[p]!) / (n + ARTIST_SMOOTHING)) };
}

const topK = (scores: number[], k: number, exclude?: number) =>
  scores
    .map((s, p) => ({ s, p }))
    .filter((x) => x.p !== exclude)
    .sort((a, b) => b.s - a.s)
    .slice(0, k)
    .map((x) => x.p);

const recall = (pred: number[], truth: number[]) => pred.filter((p) => truth.includes(p)).length / truth.length;

// Accumulates mean recall per (scenario, scorer, artist-known bucket).
const results = new Map<string, { sum: number; count: number }>();
function record(key: string, value: number) {
  const r = results.get(key) ?? { sum: 0, count: 0 };
  r.sum += value;
  r.count++;
  results.set(key, r);
}

for (let f = 0; f < FOLDS; f++) {
  const test = shuffled.filter((_, i) => i % FOLDS === f);
  const model = train(shuffled.filter((_, i) => i % FOLDS !== f));

  for (const id of test) {
    const truth = membership.get(id)!;
    const { scores: art, n } = artistScores(model, id);
    const bucket = n > 0 ? "known" : "new";

    for (const k of [1, 3, 5]) {
      for (const [name, scores] of [["popularity", model.prior], ["artist", art]] as const) {
        const v = recall(topK(scores, k), truth);
        record(`cold|${name}|R@${k}|all`, v);
        record(`cold|${name}|R@${k}|${bucket}`, v);
      }
    }

    if (truth.length < 2) continue;
    const picked = truth[Math.floor(rand() * truth.length)]!;
    const rest = truth.filter((p) => p !== picked);
    const pairing = model.pair[picked]!;
    const w = n / (n + 2); // trust artist overlap more as we know more of their songs
    const combined = art.map((a, p) => w * a + (1 - w) * pairing[p]!);
    for (const k of [2, 3]) {
      for (const [name, scores] of [["popularity", model.prior], ["artist", art], ["pairing", pairing], ["combined", combined]] as const) {
        const v = recall(topK(scores, k, picked), rest);
        record(`pick|${name}|R@${k}|all`, v);
        record(`pick|${name}|R@${k}|${bucket}`, v);
      }
    }
  }
}

// ---- report ----
const counts = sorted.map((id) => membership.get(id)!.length);
const dist = [1, 2, 3, 4].map((k) => counts.filter((c) => (k === 4 ? c >= 4 : c === k)).length);
const unsortedLiked = lib.liked.filter((l) => !membership.has(l.id));
const pct = (x: number) => `${(x * 100).toFixed(0)}%`.padStart(5);
const cell = (key: string) => {
  const r = results.get(key);
  return r ? `${pct(r.sum / r.count)} (n=${r.count})`.padEnd(15) : "-".padEnd(15);
};

console.log(`All-songs playlist (excluded): ${allPlaylist ? `"${allPlaylist.name}"` : "none detected"}`);
console.log(`Sort playlists: ${P}   sorted songs: ${sorted.length}   liked & unsorted: ${unsortedLiked.length}`);
console.log(`Playlists per sorted song: 1→${dist[0]}  2→${dist[1]}  3→${dist[2]}  4+→${dist[3]}`);
console.log(`Liked songs with an ISRC: ${pct(lib.liked.filter((l) => lib.tracks[l.id]?.isrc).length / lib.liked.length)}`);

console.log(`\nRecall@k = share of a song's true playlists that appear in the top k suggestions.`);
console.log(`"known" = we had other songs by the artist in training; "new" = we didn't.\n`);
console.log("COLD (no playlist picked yet)".padEnd(28) + "all".padEnd(15) + "known".padEnd(15) + "new");
for (const name of ["popularity", "artist"])
  for (const k of [1, 3, 5])
    console.log(`  ${name} R@${k}`.padEnd(28) + ["all", "known", "new"].map((b) => cell(`cold|${name}|R@${k}|${b}`)).join(""));

console.log("\nAFTER FIRST PICK (songs in 2+)".padEnd(29) + "all".padEnd(15) + "known".padEnd(15) + "new");
for (const name of ["popularity", "artist", "pairing", "combined"])
  for (const k of [2, 3])
    console.log(`  ${name} R@${k}`.padEnd(28) + ["all", "known", "new"].map((b) => cell(`pick|${name}|R@${k}|${b}`)).join(""));
