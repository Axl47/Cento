import assert from "node:assert/strict";
import { test } from "node:test";
import { MAX_FIT_ZOOM, fitCamera, overlaps, placeLabel, revealZooms, type Box, type NameCandidate } from "./mapLayout.ts";

const CANVAS = [500, 400] as const;
const BASE = 180;
const screen = ([x, y]: readonly [number, number], { k, cx, cy }: ReturnType<typeof fitCamera>) => [(x - cx) * BASE * k + 250, (y - cy) * BASE * k + 200];

test("a fit keeps every point on screen, zooming out as far as the spread needs", () => {
  const near = fitCamera([[0.1, 0.1], [0.2, 0.15]], CANVAS, BASE);
  const far = fitCamera([[0.1, 0.1], [0.2, 0.15], [-0.8, 0.9]], CANVAS, BASE);
  assert.ok(far.k < near.k);
  for (const p of [[0.1, 0.1], [0.2, 0.15], [-0.8, 0.9]] as const) {
    const [x, y] = screen(p, far);
    assert.ok(x! > 0 && x! < 500 && y! > 0 && y! < 400);
  }
});

test("a fit stops zooming in at the cap, even on a single point", () => {
  assert.equal(fitCamera([[0.3, 0.3]], CANVAS, BASE).k, MAX_FIT_ZOOM);
});

test("a name near the right edge flips to the left instead of being cut off", () => {
  const [x, , w] = placeLabel([490, 200], [120, 14], 8, CANVAS, [], false)!.box;
  assert.equal(x, 490 - 8 - 120);
  assert.ok(x + w <= 500);
});

test("a name stays fully inside the canvas in a corner", () => {
  const [x, y, w, h] = placeLabel([2, 2], [120, 14], 8, CANVAS, [], false)!.box;
  assert.ok(x >= 0 && y >= 0 && x + w <= 500 && y + h <= 400);
});

test("a name moves to a free spot when its first choice is taken", () => {
  const taken: Box[] = [[200, 190, 140, 20]];
  const spot = placeLabel([200, 200], [120, 14], 8, CANVAS, taken, false)!.box;
  assert.equal(overlaps(taken, spot), false);
});

test("with no room left, only a name that must show still gets a spot, inside the canvas", () => {
  const full: Box[] = [[0, 0, 500, 400]];
  assert.equal(placeLabel([200, 200], [120, 14], 8, CANVAS, full, false), null);
  const [x, y, w, h] = placeLabel([200, 200], [120, 14], 8, CANVAS, full, true)!.box;
  assert.ok(x >= 0 && y >= 0 && x + w <= 500 && y + h <= 400);
});

test("a name keeps last frame's spot while it's free, instead of going back to the first choice", () => {
  const above = placeLabel([200, 200], [120, 14], 8, CANVAS, [], false, "r-1")!;
  assert.equal(above.spot, "r-1");
  assert.ok(above.box[1] < 200 - 7);
  assert.equal(placeLabel([200, 200], [120, 14], 8, CANVAS, [above.box], false, "r-1")!.spot, "r0");
});

const box = ({ point: [x, y], width }: NameCandidate, s: number): Box => [x * s, y * s, width + 16, 24];

test("names that have appeared never overlap each other, at any zoom", () => {
  let seed = 7;
  const random = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 0.2;
  const names: NameCandidate[] = Array.from({ length: 300 }, () => ({ point: [random(), random()], width: 40 + random() * 400, floor: 3 }));
  const zooms = revealZooms(names, BASE, [16, 24]);
  for (const k of [3, 5, 9, 17, 40, 80]) {
    const shown: Box[] = [];
    names.forEach((n, i) => {
      if (zooms[i]! > k) return;
      const b = box(n, BASE * k);
      assert.equal(overlaps(shown, b), false, `zoom ${k}`);
      shown.push(b);
    });
  }
});

test("a name waits for the zoom where it clears a more important one, and never before its floor", () => {
  const [lead, beside, far] = revealZooms(
    [
      { point: [0, 0], width: 84, floor: 2 },
      { point: [0.002, 0], width: 84, floor: 2 },
      { point: [0.5, 0.5], width: 84, floor: 4 },
    ],
    BASE,
    [16, 24],
  );
  assert.equal(lead, 2);
  assert.ok(Math.abs(beside! - 100 / 0.002 / BASE) < 1e-9);
  assert.equal(far, 4);
});
