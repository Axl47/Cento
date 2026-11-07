// Where a set of 2D points is concentrated, for placing playlist bubbles on the sound map.
// A plain average lands between clusters (or in empty space) when a playlist's songs sit in a
// few tight groups, so this finds dense spots instead.

export type Cluster = { x: number; y: number; n: number };
type Point = readonly [number, number];

/**
 * Dense spots of `points`, biggest first: mean-shift (flat kernel of `radius`) seeded at the
 * densest grid neighborhood, repeated on the points not yet claimed. A later spot is kept only
 * if it holds at least `minShare` of all points; at most `max` spots.
 */
export function clusters(points: readonly Point[], { radius = 0.07, minShare = 0.2, max = 3, minSize = 3 } = {}): Cluster[] {
  const out: Cluster[] = [];
  let left = points.map((_, i) => i);
  const r2 = radius * radius;

  while (out.length < max && left.length >= minSize) {
    // Seed: the grid cell whose 3x3 neighborhood holds the most points.
    const cells = new Map<string, number[]>();
    for (const i of left) {
      const key = `${Math.floor(points[i]![0] / radius)},${Math.floor(points[i]![1] / radius)}`;
      cells.set(key, [...(cells.get(key) ?? []), i]);
    }
    let seed: number[] = [];
    for (const key of cells.keys()) {
      const [cx, cy] = key.split(",").map(Number) as [number, number];
      const near: number[] = [];
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) near.push(...(cells.get(`${cx + dx},${cy + dy}`) ?? []));
      if (near.length > seed.length) seed = near;
    }

    // Mean-shift: move to the mean of the points within `radius` until it settles.
    let [x, y] = mean(points, seed);
    let members = seed;
    for (let step = 0; step < 20; step++) {
      members = left.filter((i) => (points[i]![0] - x) ** 2 + (points[i]![1] - y) ** 2 <= r2);
      if (members.length === 0) break;
      const [nx, ny] = mean(points, members);
      const moved = Math.hypot(nx - x, ny - y);
      [x, y] = [nx, ny];
      if (moved < radius * 0.01) break;
    }

    if (members.length < minSize || (out.length > 0 && members.length < minShare * points.length)) break;
    out.push({ x, y, n: members.length });
    const claimed = new Set(members);
    left = left.filter((i) => !claimed.has(i));
  }
  return out;
}

function mean(points: readonly Point[], ids: number[]): [number, number] {
  let sx = 0;
  let sy = 0;
  for (const i of ids) {
    sx += points[i]![0];
    sy += points[i]![1];
  }
  return [sx / ids.length, sy / ids.length];
}
