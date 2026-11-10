// Where the sound map's camera and song names go. Pure geometry in screen pixels, separate from the drawing.

export type Point = readonly [x: number, y: number];
export type Size = readonly [width: number, height: number];
export type Box = readonly [x: number, y: number, w: number, h: number];
/** `k` is zoom; (`cx`, `cy`) is the layout point at the middle of the canvas. */
export type Camera = { k: number; cx: number; cy: number };

export const MIN_ZOOM = 0.6;
/** Tighter than this and a fit would stop showing what's around the songs, and every other name would appear. */
export const MAX_FIT_ZOOM = 6.5;
/** Room left around fitted songs: more at the sides, where the names run. */
const FIT_PAD = [64, 40] as const;
const EDGE = 4;

const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(value, high));

export const overlaps = (taken: readonly Box[], b: Box) => taken.some((t) => overlapArea(t, b) > 0);

function overlapArea([ax, ay, aw, ah]: Box, [bx, by, bw, bh]: Box) {
  return Math.max(0, Math.min(ax + aw, bx + bw) - Math.max(ax, bx)) * Math.max(0, Math.min(ay + ah, by + bh) - Math.max(ay, by));
}

/** The camera that shows every point with as little zooming out as it takes. `base` is pixels per layout unit at zoom 1. */
export function fitCamera(points: readonly Point[], [width, height]: Size, base: number): Camera {
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  const [minX, maxX, minY, maxY] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  const zoomFor = (pixels: number, span: number) => (span > 0 ? Math.max(pixels, 1) / (span * base) : Infinity);
  const k = Math.min(zoomFor(width - 2 * FIT_PAD[0], maxX - minX), zoomFor(height - 2 * FIT_PAD[1], maxY - minY));
  return { k: clamp(k, MIN_ZOOM, MAX_FIT_ZOOM), cx: (minX + maxX) / 2, cy: (minY + maxY) / 2 };
}

/**
 * Where a name goes: beside its point on whichever side has room, else the closest free spot above or below,
 * always fully inside the canvas. `gap` is the distance from the point to the name. When every spot is taken, a
 * `mustShow` name takes the one it overlaps least; any other name is left out (null).
 */
export function placeLabel([x, y]: Point, [w, h]: Size, gap: number, [width, height]: Size, taken: readonly Box[], mustShow: boolean): Box | null {
  const inside = (bx: number, by: number): Box => [clamp(bx, EDGE, width - w - EDGE), clamp(by, EDGE, height - h - EDGE), w, h];
  const right = x + gap;
  const left = x - gap - w;
  const sides = right + w <= width - EDGE ? [right, left] : [left, right];
  const spots = [0, -1, 1, -2, 2, -3, 3].flatMap((row) => sides.map((bx) => inside(bx, y - h / 2 + row * (h + 2))));
  spots.push(inside(x - w / 2, y - gap - h), inside(x - w / 2, y + gap));
  const free = spots.find((spot) => !overlaps(taken, spot));
  if (free || !mustShow) return free ?? null;
  const covered = (spot: Box) => taken.reduce((sum, t) => sum + overlapArea(t, spot), 0);
  return spots.reduce((best, spot) => (covered(spot) < covered(best) ? spot : best));
}
