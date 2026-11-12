// Dividing a big playlist into groups of songs that sound alike, to make smaller playlists from it.
import { positions, type AudioIndex, type Vectors } from "./audio.ts";

const RESTARTS = 6;
const ROUNDS = 30;

export type Split = {
  /** Biggest group first; within a group, the songs most typical of it come first. */
  groups: string[][];
  /** Songs with no sound vector, which can't be placed. */
  unplaced: string[];
};

/** A small seeded random generator, so the same playlist always splits the same way. */
function seeded(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const dot = (a: Float32Array, b: Float32Array) => {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i]! * b[i]!;
  return sum;
};

const unit = (v: Float32Array) => {
  const norm = Math.sqrt(dot(v, v)) || 1;
  for (let i = 0; i < v.length; i++) v[i]! /= norm;
  return v;
};

/**
 * Each song's vector with the songs' average removed. What every song in a playlist shares would otherwise
 * dominate; what's left is how the songs differ from each other, which is what a split should follow.
 */
function centered({ dim, scale, q }: Vectors, rows: number[]) {
  const mean = new Float32Array(dim);
  const out = rows.map((r) => Float32Array.from(q.subarray(r * dim, (r + 1) * dim), (x) => x * scale[r]!));
  for (const v of out) for (let i = 0; i < dim; i++) mean[i]! += v[i]! / out.length;
  for (const v of out) {
    for (let i = 0; i < dim; i++) v[i]! -= mean[i]!;
    unit(v);
  }
  return out;
}

/** One k-means run: which center each row ends up with, the centers, and how tightly the rows sit around them. */
function cluster(rows: Float32Array[], k: number, random: () => number) {
  // Start from songs spread far apart (k-means++): each next start is picked in proportion to how unlike the chosen ones it is.
  let centers = [rows[Math.floor(random() * rows.length)]!];
  const far = rows.map(() => Infinity);
  while (centers.length < k) {
    const last = centers.at(-1)!;
    let total = 0;
    rows.forEach((v, i) => (total += far[i] = Math.min(far[i]!, Math.max(0, 1 - dot(v, last)) ** 2)));
    let at = random() * total;
    const next = rows.findIndex((_, i) => (at -= far[i]!) <= 0);
    centers.push(rows[next === -1 ? rows.length - 1 : next]!);
  }
  let labels = rows.map(() => -1);
  let tightness = 0;
  for (let round = 0; round < ROUNDS; round++) {
    tightness = 0;
    const next = rows.map((v) => {
      const sims = centers.map((c) => dot(v, c));
      const best = sims.indexOf(Math.max(...sims));
      tightness += sims[best]!;
      return best;
    });
    const moved = next.some((label, i) => label !== labels[i]);
    labels = next;
    if (!moved) break;
    centers = centers.map((old, c) => {
      const sum = new Float32Array(old.length);
      let count = 0;
      rows.forEach((v, i) => {
        if (labels[i] !== c) return;
        count++;
        for (let d = 0; d < sum.length; d++) sum[d]! += v[d]!;
      });
      return count ? unit(sum) : old;
    });
  }
  return { labels, centers, tightness };
}

/**
 * `ids` divided into `k` groups by sound (fewer if there aren't enough different songs). The same songs always
 * give the same groups. To divide one group further, call this again on it.
 */
export function soundGroups({ index, vectors }: { index: AudioIndex; vectors: Vectors }, ids: string[], k: number): Split {
  const pos = positions(index);
  const known = [...new Set(ids)].filter((id) => pos.has(id));
  const unplaced = ids.filter((id) => !pos.has(id));
  if (known.length <= k || k < 2) return { groups: known.length ? [known] : [], unplaced };

  const rows = centered(vectors, known.map((id) => pos.get(id)!));
  const random = seeded(known.length * 31 + k);
  let best = cluster(rows, k, random);
  for (let i = 1; i < RESTARTS; i++) {
    const run = cluster(rows, k, random);
    if (run.tightness > best.tightness) best = run;
  }
  const groups = best.centers
    .map((center, c) =>
      known
        .map((id, i) => ({ id, label: best.labels[i], typical: dot(rows[i]!, center) }))
        .filter((song) => song.label === c)
        .sort((a, b) => b.typical - a.typical)
        .map((song) => song.id),
    )
    .filter((group) => group.length)
    .sort((a, b) => b.length - a.length);
  return { groups, unplaced };
}
