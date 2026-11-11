import assert from "node:assert/strict";
import { test } from "node:test";
import { regions, tileKeyAt, tileUp } from "./hexTiles.ts";

const SIZE = 0.1;

test("each point lands in the tile whose center is nearest, and the tile is led by its most common group", () => {
  const points = [[0, 0], [0.02, -0.03], [0.05, 0.01], [0.6, 0.6]] as const;
  const groups = ["a", "a", "b", null];
  const tiles = tileUp(points, SIZE, (i) => groups[i]!);
  assert.equal(tiles.size, 2);
  const home = tiles.get(tileKeyAt([0, 0], SIZE))!;
  assert.deepEqual(home.songs, [0, 1, 2]);
  assert.equal(home.top, "a");
  assert.equal(home.share, 2 / 3);
  const far = tiles.get(tileKeyAt([0.6, 0.6], SIZE))!;
  assert.ok(Math.hypot(far.x - 0.6, far.y - 0.6) <= SIZE, "a tile's center is within one size of its points");
  assert.equal(far.top, null);
});

test("excluded points are left out of the tiles", () => {
  const tiles = tileUp([[0, 0], [1, 1]], SIZE, () => "a", (i) => i === 0);
  assert.equal(tiles.size, 1);
});

test("touching tiles led by one group form a region; a weakly led or separate tile does not join it", () => {
  // A row of tiles along x: three "a" tiles, a tie that "a" leads with only half, then a gap and another "a" tile.
  const step = SIZE * Math.sqrt(3);
  const points = [0, 1, 2].flatMap((c) => [[c * step, 0], [c * step, 0.01]] as const);
  const groups: (string | null)[] = points.map(() => "a");
  points.push([3 * step, 0], [3 * step, 0.01], [8 * step, 0]);
  groups.push("a", "b", "a");
  const tiles = tileUp(points, SIZE, (i) => groups[i]!);
  const found = regions(tiles, SIZE, 0.6);
  assert.deepEqual(found.map((r) => [r.group, r.songs]), [["a", 6], ["a", 1]]);
  assert.ok(Math.abs(found[0]!.x - step) < 1e-9, "the region sits on its middle tile");
});
