import assert from "node:assert/strict";
import { test } from "node:test";
import { closestAmong, decodeVectors, encodeVectors, type AudioIndex } from "./audio.ts";

const unit = (...xs: number[]) => {
  const n = Math.hypot(...xs);
  return Float32Array.from(xs, (x) => x / n);
};

test("closestAmong ranks candidates by similarity and drops those at or below the baseline", () => {
  const index: AudioIndex = { model: "t", ids: ["me", "near", "mid", "far"], xy: [], nn: [], sim: [], baseline: 0.5 };
  const bytes = encodeVectors([unit(1, 0), unit(1, 0.1), unit(1, 1), unit(0, 1)]);
  const v = decodeVectors(bytes.buffer as ArrayBuffer);

  const got = closestAmong(index, v, "me", ["far", "mid", "near", "me", "unknown"], 10);
  assert.deepEqual(got.map((x) => x.id), ["near", "mid"]); // cos: 0.995, 0.707; "far" is 0
  assert.ok(Math.abs(got[1]!.sim - Math.SQRT1_2) < 0.01);
});
