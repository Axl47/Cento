import assert from "node:assert/strict";
import { test } from "node:test";
import { decodeFeatures, encodeFeatures, handoffReasons, songFeatures, type SongFeatures } from "./features.ts";

/** A steady 120 BPM song in 8A at -8 LUFS, level from start to end. */
const song = (over: Partial<SongFeatures> = {}): SongFeatures => ({
  bpm: 120,
  steady: true,
  key: "A minor",
  camelot: "8A",
  keyStrength: 0.9,
  lufs: -8,
  intro: 0,
  outro: 0,
  vocals: 0.8,
  vocalsFirst: 10,
  vocalsLast: 170,
  ...over,
});

test("half and double time are not a tempo jump", () => {
  assert.deepEqual(handoffReasons(song({ bpm: 90 }), song({ bpm: 180 })), []);
  assert.deepEqual(handoffReasons(song({ bpm: 128 }), song({ bpm: 63 })), []);
});

test("unsteady songs give no tempo reason", () => {
  assert.deepEqual(handoffReasons(song({ bpm: 94 }), song({ bpm: 128, steady: false })), []);
});

test("each reason fires", () => {
  assert.deepEqual(handoffReasons(song({ bpm: 94.4 }), song({ bpm: 128 })), ["94 → 128 BPM"]);
  assert.deepEqual(handoffReasons(song({ outro: -15 }), song({ intro: -2 })), ["quiet → loud"]);
  assert.deepEqual(handoffReasons(song({ outro: 0 }), song({ intro: -12 })), ["loud → quiet"]);
  assert.deepEqual(handoffReasons(song({ camelot: "8A" }), song({ camelot: "2B" })), ["key clash"]);
  assert.deepEqual(handoffReasons(song({ camelot: "11A" }), song({ camelot: "4A" })), ["key clash"]);
  assert.deepEqual(handoffReasons(song({ camelot: "8A", keyStrength: 0.6 }), song({ camelot: "2B" })), []);
});

test("at most two reasons, most telling first", () => {
  const got = handoffReasons(song({ bpm: 94, outro: 0, camelot: "8A" }), song({ bpm: 128, intro: -12, camelot: "2A" }));
  assert.deepEqual(got, ["94 → 128 BPM", "loud → quiet"]);
  assert.deepEqual(handoffReasons(song({ outro: 0, camelot: "8A" }), song({ intro: -12, camelot: "2A" })), ["loud → quiet", "key clash"]);
});

test("edge levels are relative to the song's loudness, and survive the file round trip", () => {
  const st = [-30, ...Array<number>(98).fill(-8), -28];
  const f = songFeatures({
    key: "X",
    tempo: { bpm_fold: 120, reg: 0.9 },
    tonal: { all: ["A", "minor", 0.9], camelot: "8A" },
    loud: { lufs: -8, st, end: 100 },
    voc: { first: null, last: null, share: 0 },
  });
  assert.equal(f.intro, -2.2);
  assert.equal(f.outro, -2);
  assert.deepEqual(decodeFeatures(encodeFeatures(new Map([["id", f]]))).get("id"), f);
});
