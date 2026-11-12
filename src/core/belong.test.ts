import assert from "node:assert/strict";
import { test } from "node:test";
import { decodeVectors, encodeVectors, type AudioIndex } from "./audio.ts";
import { doubted, missing } from "./belong.ts";
import { classifierFrom } from "./classifier.ts";

const classifier = classifierFrom({
  confidence: 0.9,
  keys: ["in-sure", "in-unsure", "out-likely", "out-unlikely"],
  playlists: [{ id: "p", auc: 0.9, cutoff: 0.5 }],
  scores: [[0.9], [0.1], [0.7], [0.2]],
  picks: [null, null, null, null],
});
const playlist = { id: "p", trackIds: ["in-sure", "in-unsure"] };

test("with a classifier, the likeliest outside songs are missing and the least likely members are doubted", () => {
  const evidence = { classifier, sound: undefined };

  assert.deepEqual(missing(evidence, playlist, ["out-unlikely", "in-sure", "out-likely", "unscored"], 5).map((s) => s.id), ["out-likely", "out-unlikely"]);
  assert.deepEqual(doubted(evidence, playlist).map((s) => s.id), ["in-unsure", "in-sure"]);
});

test("a playlist with no classifier falls back to sound", () => {
  const angle = (deg: number) => Float32Array.from([Math.cos((deg * Math.PI) / 180), Math.sin((deg * Math.PI) / 180), 0]);
  const degrees = [0, 20, 40, 150, 30];
  const raw = encodeVectors(degrees.map(angle));
  const sound = {
    index: { ids: degrees.map(String), nn: [[1, 4, 2, 3], [0, 4, 2, 3], [4, 1, 0, 3], [2, 4, 1, 0], [1, 2, 0, 3]], baseline: 0 } as AudioIndex,
    vectors: decodeVectors(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength) as ArrayBuffer),
  };
  const evidence = { classifier, sound };
  const other = { id: "new", trackIds: ["0", "20", "40", "150"] };

  assert.deepEqual(missing(evidence, other, ["30"], 5).map((s) => s.id), ["30"]);
  assert.equal(doubted(evidence, other)[0]!.id, "150");
});

test("a playlist with an artist rule misses exactly its artists' songs and doubts the rest, whatever they sound like", () => {
  const byRule = (id: string) => id.startsWith("theirs");
  const rule = { classifier, sound: undefined, byRule };

  assert.deepEqual(missing(rule, { id: "p", trackIds: ["theirs-in", "other-in"] }, ["theirs-out", "other-out", "theirs-in"], 5), [{ id: "theirs-out", score: 1 }]);
  assert.deepEqual(doubted(rule, { id: "p", trackIds: ["theirs-in", "other-in"] }), [{ id: "other-in", score: 0 }]);
});
