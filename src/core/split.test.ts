import assert from "node:assert/strict";
import { test } from "node:test";
import { decodeVectors, encodeVectors, type AudioIndex } from "./audio.ts";
import { soundGroups } from "./split.ts";

const angle = (deg: number) => Float32Array.from([Math.cos((deg * Math.PI) / 180), Math.sin((deg * Math.PI) / 180), 0]);
/** Songs named by their angle on a circle: songs at nearby angles sound alike. */
const sound = (degrees: number[]) => {
  const raw = encodeVectors(degrees.map(angle));
  return {
    index: { ids: degrees.map(String) } as AudioIndex,
    vectors: decodeVectors(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength) as ArrayBuffer),
  };
};

test("songs split into the groups that sound alike, biggest first, most typical song first", () => {
  const degrees = [0, 122, 4, 240, 8, 118, 2, 6, 120];
  const { groups, unplaced } = soundGroups(sound(degrees), degrees.map(String), 3);

  assert.deepEqual(groups.map((g) => [...g].sort((a, b) => +a - +b)), [["0", "2", "4", "6", "8"], ["118", "120", "122"], ["240"]]);
  assert.equal(groups[0]![0], "4");
  assert.deepEqual(unplaced, []);
});

test("the same songs always split the same way", () => {
  const degrees = Array.from({ length: 40 }, (_, i) => (i * 37) % 360);
  const ids = degrees.map(String);

  assert.deepEqual(soundGroups(sound(degrees), ids, 4), soundGroups(sound(degrees), ids, 4));
});

test("songs without a sound vector are set aside, and too few songs stay as one group", () => {
  assert.deepEqual(soundGroups(sound([0, 90]), ["0", "x", "90"], 2), { groups: [["0", "90"]], unplaced: ["x"] });
});
