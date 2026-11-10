// A sonic bridge: a playlist that travels gradually from one song to another, using only the library.
// Pure code over the sound vectors.
import { positions, similarity, type AudioIndex, type Vectors } from "./audio.ts";

export type Candidate = { id: string; artist: string | undefined };

/** Songs considered for each position in the bridge. */
const OPTIONS_PER_STEP = 40;
/** How much staying near the straight line between the two songs counts, against smooth hops. */
const ROUTE_WEIGHT = 0.5;
/** Cost of two neighbors by one artist: allowed only when every alternative is much worse. */
const SAME_ARTIST_COST = 0.5;

/**
 * Songs from `from` to `to`, `length` long including both ends. Each position is a point on the straight line
 * between the two songs; every song is only eligible at the position it's closest to, so none repeats. Among
 * those, picks the route with the smoothest hops, squaring each so one big jump costs more than several small ones.
 */
export function buildBridge(index: AudioIndex, v: Vectors, from: Candidate, to: Candidate, length: number, candidates: Candidate[]): string[] {
  const pos = positions(index);
  const a = pos.get(from.id);
  const b = pos.get(to.id);
  if (a === undefined || b === undefined) return [];
  const steps = Math.max(length - 2, 0);
  const ends = similarity(v, a, b);
  const targets = Array.from({ length: steps }, (_, k) => {
    const t = (k + 1) / (steps + 1);
    return { t, norm: Math.sqrt((1 - t) ** 2 + t ** 2 + 2 * t * (1 - t) * ends) || 1 };
  });

  type Option = { id: string; row: number; artist: string | undefined; fit: number };
  const byStep: Option[][] = targets.map(() => []);
  for (const c of candidates) {
    const row = pos.get(c.id);
    if (row === undefined || row === a || row === b) continue;
    const toA = similarity(v, row, a);
    const toB = similarity(v, row, b);
    let step = 0;
    let fit = -Infinity;
    targets.forEach(({ t, norm }, k) => {
      const s = ((1 - t) * toA + t * toB) / norm;
      if (s > fit) [step, fit] = [k, s];
    });
    if (steps) byStep[step]!.push({ id: c.id, row, artist: c.artist, fit });
  }
  const layers = byStep.map((options) => options.sort((x, y) => y.fit - x.fit).slice(0, OPTIONS_PER_STEP)).filter((l) => l.length > 0);

  const hop = (p: Pick<Option, "row" | "artist">, q: Pick<Option, "row" | "artist">) =>
    (1 - similarity(v, p.row, q.row)) ** 2 + (p.artist !== undefined && p.artist === q.artist ? SAME_ARTIST_COST : 0);
  const start = { row: a, artist: from.artist };
  const end = { row: b, artist: to.artist };

  // Cheapest route to each option, one layer at a time, remembering which option it came from.
  let costs = layers[0]?.map((o) => hop(start, o) + ROUTE_WEIGHT * (1 - o.fit)) ?? [];
  const cameFrom: number[][] = [];
  for (let l = 1; l < layers.length; l++) {
    const previous = layers[l - 1]!;
    const last = costs;
    const links: number[] = [];
    costs = layers[l]!.map((o) => {
      let best = Infinity;
      let link = 0;
      previous.forEach((p, i) => {
        const cost = last[i]! + hop(p, o);
        if (cost < best) [best, link] = [cost, i];
      });
      links.push(link);
      return best + ROUTE_WEIGHT * (1 - o.fit);
    });
    cameFrom.push(links);
  }

  const middle: string[] = [];
  const lastLayer = layers.at(-1);
  if (lastLayer) {
    let at = 0;
    lastLayer.forEach((o, i) => {
      if (costs[i]! + hop(o, end) < costs[at]! + hop(lastLayer[at]!, end)) at = i;
    });
    for (let l = layers.length - 1; l >= 0; l--) {
      middle.unshift(layers[l]![at]!.id);
      if (l > 0) at = cameFrom[l - 1]![at]!;
    }
  }
  return [from.id, ...middle, to.id];
}

/** Similarity of each song to the next, for showing where a bridge is smooth and where it jumps. */
export function hops(index: AudioIndex, v: Vectors, ids: string[]): number[] {
  const pos = positions(index);
  return ids.slice(1).map((id, i) => {
    const p = pos.get(ids[i]!);
    const q = pos.get(id);
    return p === undefined || q === undefined ? 0 : similarity(v, p, q);
  });
}
