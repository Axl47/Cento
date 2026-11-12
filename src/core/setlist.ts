// Building a playlist from a handful of songs: how well one song hands off to the next, the order with the
// smoothest handoffs, which songs don't fit the rest, and what else in the library would.
// Pure code over the sound vectors and the edge vectors (data/edges.bin, built by `pnpm edges`).
import { positions, similarity, type AudioIndex, type Vectors } from "./audio.ts";

/**
 * How each song starts and ends: two rows per song of the audio index, the sound of its first seconds at
 * `2 * i` and of its last seconds at `2 * i + 1`. Same file layout as `Vectors`.
 */
export type Edges = Vectors;

export type Sound = { index: AudioIndex; vectors: Vectors; edges: Edges | undefined };

/** How much the end of one song matching the start of the next counts, against the two songs being alike overall. */
const EDGE_WEIGHT = 0.5;
/** Cost of two neighbors by one artist, as in bridges: allowed only when every alternative is much worse. */
const SAME_ARTIST_COST = 0.5;
/** Sets up to this size get the best possible order; bigger ones a good one. */
const EXACT_LIMIT = 15;
/** A song doesn't fit when it's this much less like the set than the set's typical song. */
const MISFIT_GAP = 0.1;
/** Above this similarity two tracks are one recording saved from two releases. */
const SAME_RECORDING = 0.995;
/** How many of a set's songs a suggestion is compared with: its closest few, so it can fit one corner of the set. */
const CLOSEST = 3;

/**
 * How smoothly `from` hands off to `to`, 1 being identical: the end of one against the start of the other,
 * mixed with how alike the two songs are overall. Not symmetric. 0 when either song has no vector.
 */
export function handoff({ index, vectors, edges }: Sound, from: string, to: string) {
  const pos = positions(index);
  const a = pos.get(from);
  const b = pos.get(to);
  if (a === undefined || b === undefined) return 0;
  const whole = similarity(vectors, a, b);
  return edges ? EDGE_WEIGHT * similarity(edges, 2 * a + 1, 2 * b) + (1 - EDGE_WEIGHT) * whole : whole;
}

/** Each song's handoff to the next, for showing where an order is smooth and where it jumps. */
export const handoffs = (sound: Sound, ids: string[]) => ids.slice(1).map((id, i) => handoff(sound, ids[i]!, id));

/**
 * The songs in the order with the smoothest handoffs. Each handoff's shortfall is squared, so one big jump
 * costs more than several small ones.
 */
export function smoothestOrder(sound: Sound, ids: string[], artistOf: (id: string) => string | undefined): string[] {
  const n = ids.length;
  if (n < 3) return ids;
  const artists = ids.map(artistOf);
  const cost = ids.map((from, i) =>
    ids.map((to, j) => (1 - handoff(sound, from, to)) ** 2 + (artists[i] !== undefined && artists[i] === artists[j] ? SAME_ARTIST_COST : 0)),
  );
  return (n <= EXACT_LIMIT ? bestPath(cost) : goodPath(cost)).map((i) => ids[i]!);
}

/** The cheapest path through every point, any start and end: the cheapest way to reach each point having visited each subset. */
function bestPath(cost: number[][]): number[] {
  const n = cost.length;
  const reach = new Float64Array((1 << n) * n).fill(Infinity);
  const cameFrom = new Int8Array((1 << n) * n).fill(-1);
  for (let i = 0; i < n; i++) reach[(1 << i) * n + i] = 0;
  for (let seen = 1; seen < 1 << n; seen++) {
    for (let last = 0; last < n; last++) {
      const soFar = reach[seen * n + last]!;
      if (soFar === Infinity) continue;
      for (let next = 0; next < n; next++) {
        if (seen & (1 << next)) continue;
        const at = (seen | (1 << next)) * n + next;
        const total = soFar + cost[last]![next]!;
        if (total < reach[at]!) [reach[at], cameFrom[at]] = [total, last];
      }
    }
  }
  let seen = (1 << n) - 1;
  let last = 0;
  for (let i = 1; i < n; i++) if (reach[seen * n + i]! < reach[seen * n + last]!) last = i;
  const path: number[] = [];
  while (last >= 0) {
    path.unshift(last);
    const previous = cameFrom[seen * n + last]!;
    seen ^= 1 << last;
    last = previous;
  }
  return path;
}

/** For sets too big for `bestPath`: always step to the cheapest song left, then keep moving single songs to a better place. */
function goodPath(cost: number[][]): number[] {
  const n = cost.length;
  const total = (p: number[]) => p.slice(1).reduce((sum, to, i) => sum + cost[p[i]!]![to]!, 0);
  let path: number[] = [];
  for (let start = 0; start < n; start += Math.ceil(n / 30)) {
    const left = new Set(cost.keys());
    const walk = [start];
    left.delete(start);
    while (left.size) {
      const row = cost[walk.at(-1)!]!;
      let next = -1;
      for (const j of left) if (next < 0 || row[j]! < row[next]!) next = j;
      walk.push(next);
      left.delete(next);
    }
    if (!path.length || total(walk) < total(path)) path = walk;
  }
  const link = (a: number | undefined, b: number | undefined) => (a === undefined || b === undefined ? 0 : cost[a]![b]!);
  for (let pass = 0, moved = true; moved && pass < 20; pass++) {
    moved = false;
    for (const song of [...path]) {
      const at = path.indexOf(song);
      const saved = link(path[at - 1], song) + link(song, path[at + 1]) - link(path[at - 1], path[at + 1]);
      path.splice(at, 1);
      let best = at;
      let bestAdded = saved - 1e-9;
      for (let to = 0; to <= path.length; to++) {
        const added = link(path[to - 1], song) + link(song, path[to]) - link(path[to - 1], path[to]);
        if (added < bestAdded) [best, bestAdded] = [to, added];
      }
      path.splice(best, 0, song);
      moved ||= best !== at;
    }
  }
  return path;
}

/** How alike each song is to the rest of the set (its mean similarity to the others), in the set's order. */
export function fits({ index, vectors }: Sound, ids: string[]): number[] {
  const pos = positions(index);
  const rows = ids.map((id) => pos.get(id));
  return rows.map((a, i) => {
    if (a === undefined || ids.length < 2) return 0;
    let sum = 0;
    rows.forEach((b, j) => (sum += i === j || b === undefined ? 0 : similarity(vectors, a, b)));
    return sum / (ids.length - 1);
  });
}

/** Songs clearly less like the set than its typical song is, least alike first. Needs four songs to say anything. */
export function misfits(sound: Sound, ids: string[]): string[] {
  if (ids.length < 4) return [];
  const fit = fits(sound, ids);
  const typical = [...fit].sort((a, b) => a - b)[fit.length >> 1]!;
  return ids
    .map((id, i) => ({ id, fit: fit[i]! }))
    .filter((s) => s.fit < typical - MISFIT_GAP)
    .sort((a, b) => a.fit - b.fit)
    .map((s) => s.id);
}

/**
 * Songs outside the set that sound most like it, best first: each is scored by its closest few songs in the
 * set. Looks only at the set's own nearest neighbors, and only at songs `allowed` accepts;
 * another release of a song already in the set is left out.
 */
export function additions({ index, vectors }: Sound, ids: string[], allowed: (id: string) => boolean, limit: number) {
  const pos = positions(index);
  const rows = ids.flatMap((id) => pos.get(id) ?? []);
  const inSet = new Set(rows);
  const nearby = new Set(rows.flatMap((row) => index.nn[row] ?? []));
  const out: { id: string; sim: number }[] = [];
  for (const row of nearby) {
    const id = index.ids[row]!;
    if (inSet.has(row) || !allowed(id)) continue;
    const closest = rows.map((member) => similarity(vectors, row, member)).sort((a, b) => b - a).slice(0, CLOSEST);
    if (closest[0]! > SAME_RECORDING) continue;
    out.push({ id, sim: closest.reduce((sum, s) => sum + s, 0) / closest.length });
  }
  return out.sort((a, b) => b.sim - a.sim).slice(0, limit);
}
