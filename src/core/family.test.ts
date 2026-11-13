import assert from "node:assert/strict";
import { test } from "node:test";
import { ancestors, knownParents, likelyParts, likelyWholes, partsOf, setPart, strays, unplaced, withAncestors, type Parents } from "./family.ts";

const parents: Parents = { "future-bass": ["edm"], "melodic-dubstep": ["edm"], edm: ["electronic"], "neo-perreo": ["edm", "urbano"] };

test("a pick brings along every playlist it's part of, through parts of parts", () => {
  assert.deepEqual(ancestors(parents, "future-bass"), ["edm", "electronic"]);
  assert.deepEqual(withAncestors(parents, ["rock", "neo-perreo", "edm"]), ["rock", "neo-perreo", "edm", "electronic", "urbano"]);
  assert.deepEqual(partsOf(parents).get("edm"), ["future-bass", "melodic-dubstep", "neo-perreo"]);
});

test("a part can't be made a part of itself or of its own part", () => {
  assert.equal(setPart(parents, "edm", "edm", true), parents);
  assert.equal(setPart(parents, "electronic", "future-bass", true), parents);
  assert.deepEqual(setPart(parents, "rock", "electronic", true).rock, ["electronic"]);
  assert.equal("future-bass" in setPart(parents, "future-bass", "edm", false), false);
  assert.deepEqual(setPart(parents, "neo-perreo", "edm", false)["neo-perreo"], ["urbano"]);
});

test("deleted playlists drop out of the families", () => {
  const exists = (id: string) => id !== "edm";
  assert.deepEqual(knownParents(parents, exists), { "neo-perreo": ["urbano"] });
  assert.equal(knownParents(parents, () => true), parents);
});

test("strays are a part's songs its playlist lacks; unplaced are a playlist's songs in none of its parts", () => {
  const whole = { id: "edm", trackIds: ["a", "b", "c", "d"] };
  const parts = [
    { id: "future-bass", trackIds: ["a", "x"] },
    { id: "melodic-dubstep", trackIds: ["b"] },
  ];
  assert.deepEqual(strays(parts[0]!, whole), ["x"]);
  assert.deepEqual(unplaced(whole, parts), ["c", "d"]);
});

test("likely parts are smaller playlists mostly inside this one, most contained first", () => {
  const ids = (n: number, prefix = "s") => Array.from({ length: n }, (_, i) => `${prefix}${i}`);
  const whole = { id: "edm", trackIds: ids(40) };
  const others = [
    { id: "inside", trackIds: ids(10) },
    { id: "mostly", trackIds: [...ids(6), ...ids(4, "x")] },
    { id: "barely", trackIds: [...ids(2), ...ids(8, "y")] },
    { id: "tiny", trackIds: ids(3) },
    { id: "bigger", trackIds: [...ids(40), ...ids(5, "z")] },
    { id: "future-bass", trackIds: ids(8) },
    { id: "electronic", trackIds: ids(30) },
  ];
  assert.deepEqual(likelyParts(parents, whole, others).map((c) => [c.id, c.shared]), [["inside", 10], ["mostly", 6]]);
});

test("a playlist looks like a part of the bigger playlists that hold most of it, the closest fit first", () => {
  const ids = (n: number, prefix = "s") => Array.from({ length: n }, (_, i) => `${prefix}${i}`);
  const part = { id: "gaming", trackIds: ids(10) };
  const others = [
    { id: "everything-ish", trackIds: [...ids(10), ...ids(90, "x")] },
    { id: "flow", trackIds: [...ids(10), ...ids(20, "y")] },
    { id: "half", trackIds: [...ids(6), ...ids(20, "z")] },
    { id: "unrelated", trackIds: ids(50, "u") },
    { id: "smaller", trackIds: ids(8) },
    { id: "already", trackIds: [...ids(10), ...ids(5, "a")] },
    { id: "its-part", trackIds: [...ids(10), ...ids(5, "b")] },
  ];
  const family = { gaming: ["already"], "its-part": ["gaming"] };
  assert.deepEqual(likelyWholes(family, part, others).map((c) => [c.id, c.shared]), [["flow", 10], ["everything-ish", 10], ["half", 6]]);
});
