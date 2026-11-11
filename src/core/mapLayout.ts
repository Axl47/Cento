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

/** A name's box, and which spot around its point it took so the next frame can prefer it again. */
export type Placement = { box: Box; spot: string };

/**
 * Where a name goes: beside its point on whichever side has room, else the closest free spot above or below,
 * always fully inside the canvas. `gap` is the distance from the point to the name. `prefer` is the spot the name
 * took last frame: kept while it's free and fits, so names don't hop between spots as the camera moves. When every
 * spot is taken, a `mustShow` name takes the one it overlaps least; any other name is left out (null).
 */
export function placeLabel(
  [x, y]: Point,
  [w, h]: Size,
  gap: number,
  [width, height]: Size,
  taken: readonly Box[],
  mustShow: boolean,
  prefer?: string,
): Placement | null {
  const at = (spot: string, bx: number, by: number) => {
    const box: Box = [clamp(bx, EDGE, width - w - EDGE), clamp(by, EDGE, height - h - EDGE), w, h];
    return { box, spot, fits: box[0] === bx && box[1] === by };
  };
  type Spot = ReturnType<typeof at>;
  const row = (r: number) => y - h / 2 + r * (h + 2);
  const right = (r: number) => at(`r${r}`, x + gap, row(r));
  const left = (r: number) => at(`l${r}`, x - gap - w, row(r));
  const sides = x + gap + w <= width - EDGE ? [right, left] : [left, right];
  const spots = [0, -1, 1, -2, 2, -3, 3].flatMap((r) => sides.map((side) => side(r)));
  spots.push(at("above", x - w / 2, y - gap - h), at("below", x - w / 2, y + gap));
  const free = (s: Spot) => !overlaps(taken, s.box);
  const found = spots.find((s) => s.spot === prefer && s.fits && free(s)) ?? spots.find(free);
  const covered = (s: Spot) => taken.reduce((sum, t) => sum + overlapArea(t, s.box), 0);
  const chosen = found ?? (mustShow ? spots.reduce((best, s) => (covered(s) < covered(best) ? s : best)) : null);
  return chosen && { box: chosen.box, spot: chosen.spot };
}
