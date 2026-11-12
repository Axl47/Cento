import assert from "node:assert/strict";
import { test } from "node:test";
import { encodeVectors, decodeVectors, type AudioIndex } from "./audio.ts";
import { additions, handoff, misfits, smoothestOrder, type Sound } from "./setlist.ts";

const angle = (deg: number) => Float32Array.from([Math.cos((deg * Math.PI) / 180), Math.sin((deg * Math.PI) / 180), 0]);
const decode = (rows: Float32Array[]) => {
  const raw = encodeVectors(rows);
  return decodeVectors(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength) as ArrayBuffer);
};
/** Songs named by their angle on a circle, so the smooth order is the order of the angles. */
const sound = (degrees: number[], nn: number[][] = []): Sound => ({
  index: { ids: degrees.map(String), nn } as AudioIndex,
  vectors: decode(degrees.map(angle)),
  edges: undefined,
});
const noArtist = () => undefined;
const forwardOrBack = (got: string[], want: string[]) => assert.ok([want.join(), [...want].reverse().join()].includes(got.join()), got.join());

test("a shuffled set comes back in its smooth order", () => {
  forwardOrBack(smoothestOrder(sound([40, 0, 80, 20, 60]), ["40", "0", "80", "20", "60"], noArtist), ["0", "20", "40", "60", "80"]);
});

test("a set too big to try every order is still put in its smooth order", () => {
  const degrees = Array.from({ length: 24 }, (_, i) => (i * 7 * 5) % 120);
  const got = smoothestOrder(sound(degrees), degrees.map(String), noArtist);

  forwardOrBack(got, [...degrees].sort((a, b) => a - b).map(String));
});

test("the same artist isn't placed twice in a row when another order is nearly as smooth", () => {
  const artist = (id: string) => (id === "0" || id === "2" ? "x" : id);
  const got = smoothestOrder(sound([0, 2, 4, 6]), ["0", "2", "4", "6"], artist);

  assert.notEqual(Math.abs(got.indexOf("0") - got.indexOf("2")), 1);
});

test("a handoff follows how one song ends and the next begins", () => {
  const s = sound([0, 1]);
  // Song 0 ends where song 1 starts, but starts far from where song 1 ends.
  s.edges = decode([angle(90), angle(0), angle(0), angle(-90)]);

  assert.ok(handoff(s, "0", "1") > handoff(s, "1", "0"));
});

test("the song unlike the rest is the one that doesn't fit", () => {
  assert.deepEqual(misfits(sound([0, 5, 10, 15, 90]), ["0", "5", "10", "15", "90"]), ["90"]);
  assert.deepEqual(misfits(sound([0, 5, 10, 15]), ["0", "5", "10", "15"]), []);
});

test("additions are the nearby songs closest to the set, leaving out its own songs, other releases of them and ones not allowed", () => {
  const s = sound([0, 10, 20, 40, 5, 10.5], [[1, 2, 4, 5], [0, 2, 3, 4, 5], [], [], [], []]);

  assert.deepEqual(additions(s, ["0", "10"], (id) => id !== "5", 5).map((a) => a.id), ["20", "40"]);
});
