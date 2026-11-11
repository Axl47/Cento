// Hex tiles over the sound map: songs binned into hexagons in layout space, each summarized by the group (playlist)
// most of its songs are colored by. Pure geometry; the map draws them under its songs and names their regions.

import type { Point } from "./mapLayout.ts";

export type Tile = {
  key: string;
  /** Center, in layout units. */
  x: number;
  y: number;
  /** Indices of the songs in it. */
  songs: number[];
  /** The group most of its songs are in (null when most are in none), and the share of its songs that group has. */
  top: string | null;
  share: number;
};

/** Tiles touching the same group's tiles, as one labelled area. */
export type Region = { group: string; x: number; y: number; songs: number };

const SQRT3 = Math.sqrt(3);
const NEIGHBORS = [[1, 0], [1, -1], [0, -1], [-1, 0], [-1, 1], [0, 1]] as const;
const keyOf = (q: number, r: number) => `${q},${r}`;

/** The axial coordinates of the pointy-top hex (`size` = center to corner) that holds a point. */
function hexAt([x, y]: Point, size: number): [q: number, r: number] {
  const fq = ((SQRT3 / 3) * x - y / 3) / size;
  const fr = ((2 / 3) * y) / size;
  const fs = -fq - fr;
  let [q, r] = [Math.round(fq), Math.round(fr)];
  const s = Math.round(fs);
  const [dq, dr, ds] = [Math.abs(q - fq), Math.abs(r - fr), Math.abs(s - fs)];
  if (dq > dr && dq > ds) q = -r - s;
  else if (dr > ds) r = -q - s;
  return [q + 0, r + 0]; // + 0 turns -0 into 0, so keys match
}

/** The key of the tile holding a layout point, for looking it up in `tileUp`'s result. */
export const tileKeyAt = (point: Point, size: number) => keyOf(...hexAt(point, size));

/** Bins the points that `include` keeps into hexes; `groupOf(i)` is the group that colors point i (null: none). */
export function tileUp(points: readonly Point[], size: number, groupOf: (i: number) => string | null, include: (i: number) => boolean = () => true) {
  const tiles = new Map<string, Tile>();
  for (let i = 0; i < points.length; i++) {
    if (!include(i)) continue;
    const [q, r] = hexAt(points[i]!, size);
    const key = keyOf(q, r);
    let tile = tiles.get(key);
    if (!tile) tiles.set(key, (tile = { key, x: size * SQRT3 * (q + r / 2), y: size * 1.5 * r, songs: [], top: null, share: 0 }));
    tile.songs.push(i);
  }
  for (const tile of tiles.values()) {
    const counts = new Map<string | null, number>();
    for (const i of tile.songs) counts.set(groupOf(i), (counts.get(groupOf(i)) ?? 0) + 1);
    const [top, n] = [...counts].reduce((best, entry) => (entry[1] > best[1] ? entry : best));
    [tile.top, tile.share] = [top, n / tile.songs.length];
  }
  return tiles;
}

/**
 * Neighboring tiles led by the same group with at least `minShare` of their songs, joined into regions, biggest
 * first. A region sits at its tile nearest the song-weighted middle, so a curved region's label stays on it.
 */
export function regions(tiles: ReadonlyMap<string, Tile>, size: number, minShare = 0.4): Region[] {
  const leads = (t: Tile | undefined, group: string): t is Tile => !!t && t.top === group && t.share >= minShare;
  const seen = new Set<string>();
  const out: Region[] = [];
  for (const start of tiles.values()) {
    const group = start.top;
    if (group === null || seen.has(start.key) || !leads(start, group)) continue;
    const members: Tile[] = [];
    const queue = [start];
    seen.add(start.key);
    while (queue.length) {
      const t = queue.pop()!;
      members.push(t);
      const [q, r] = hexAt([t.x, t.y], size);
      for (const [dq, dr] of NEIGHBORS) {
        const next = tiles.get(keyOf(q + dq, r + dr));
        if (leads(next, group) && !seen.has(next.key)) seen.add(next.key), queue.push(next);
      }
    }
    const songs = members.reduce((sum, t) => sum + t.songs.length, 0);
    const mx = members.reduce((sum, t) => sum + t.x * t.songs.length, 0) / songs;
    const my = members.reduce((sum, t) => sum + t.y * t.songs.length, 0) / songs;
    const center = members.reduce((best, t) => (Math.hypot(t.x - mx, t.y - my) < Math.hypot(best.x - mx, best.y - my) ? t : best));
    out.push({ group, x: center.x, y: center.y, songs });
  }
  return out.sort((a, b) => b.songs - a.songs);
}
