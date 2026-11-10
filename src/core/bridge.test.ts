import assert from "node:assert/strict";
import { test } from "node:test";
import { encodeVectors, decodeVectors, type AudioIndex } from "./audio.ts";
import { buildBridge, hops } from "./bridge.ts";

/** Songs on a quarter circle from x to y, so the right order is known. */
const ids = ["a", "b", "c", "d", "e", "off"];
const angle = (deg: number) => Float32Array.from([Math.cos((deg * Math.PI) / 180), Math.sin((deg * Math.PI) / 180), 0]);
const rows = [angle(0), angle(22), angle(45), angle(68), angle(90), Float32Array.from([0, 0, 1])];
const bytes = encodeVectors(rows);
const vectors = decodeVectors(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
const index = { ids } as AudioIndex;
const song = (id: string, artist?: string) => ({ id, artist: artist ?? id });
const all = ids.map((id) => song(id));

test("a bridge walks in order between its ends and leaves out what's off the route", () => {
  assert.deepEqual(buildBridge(index, vectors, song("a"), song("e"), 5, all), ["a", "b", "c", "d", "e"]);
});

test("no song repeats when the bridge is longer than the songs available", () => {
  const got = buildBridge(index, vectors, song("a"), song("e"), 12, all);

  assert.equal(new Set(got).size, got.length);
  assert.equal(got[0], "a");
  assert.equal(got.at(-1), "e");
});

test("two ends alone make a bridge with no middle", () => {
  assert.deepEqual(buildBridge(index, vectors, song("a"), song("e"), 2, all), ["a", "e"]);
});

test("the same artist isn't placed twice in a row when another song fits", () => {
  const close = [angle(0), angle(44), angle(46), angle(90)];
  const raw = encodeVectors(close);
  const v = decodeVectors(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength) as ArrayBuffer);
  const songs = [song("a", "x"), song("m1", "x"), song("m2", "y"), song("e", "z")];
  const i = { ids: songs.map((s) => s.id) } as AudioIndex;

  assert.deepEqual(buildBridge(i, v, songs[0]!, songs[3]!, 3, songs), ["a", "m2", "e"]);
});

test("hops report the similarity of each neighboring pair", () => {
  const got = hops(index, vectors, ["a", "e"]);

  assert.ok(Math.abs(got[0]!) < 0.02);
});
