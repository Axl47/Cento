import assert from "node:assert/strict";
import { test } from "node:test";
import { clusters } from "./clusters.ts";

// Deterministic jitter so the test doesn't depend on Math.random.
const jitter = (i: number, spread: number) => (((i * 7919) % 1000) / 1000 - 0.5) * spread;
const blob = (cx: number, cy: number, n: number, spread: number, offset = 0) =>
  Array.from({ length: n }, (_, i) => [cx + jitter(i + offset, spread), cy + jitter(i * 3 + 1 + offset, spread)] as const);

test("a tight cluster wins over a spread-out minority, where the plain mean would miss both", () => {
  const points = [...blob(0.6, 0.4, 100, 0.05), ...blob(-0.6, -0.4, 30, 0.6, 500)];
  const [main] = clusters(points);
  assert.ok(main);
  assert.ok(Math.hypot(main.x - 0.6, main.y - 0.4) < 0.03, `main spot at ${main.x},${main.y}`);
  assert.ok(main.n >= 95);
});

test("two real groups both get a spot, biggest first; a stray few don't", () => {
  const points = [...blob(0.5, 0, 60, 0.04), ...blob(-0.5, 0, 40, 0.04, 200), [0, 0.5] as const, [0.1, -0.5] as const];
  const found = clusters(points);
  assert.equal(found.length, 2);
  assert.ok(Math.abs(found[0]!.x - 0.5) < 0.03 && Math.abs(found[1]!.x + 0.5) < 0.03);
});
