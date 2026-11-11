import assert from "node:assert/strict";
import { test } from "node:test";
import { pickMain, planDedupe, type Release } from "./dedupe.ts";
import type { Library } from "./library.ts";

const releases = new Map<string, Release>([
  ["single", { albumType: "single", releaseDate: "2024-11-08", totalTracks: 4 }],
  ["ep", { albumType: "single", releaseDate: "2025-02-28", totalTracks: 5 }],
  ["album", { albumType: "album", releaseDate: "2025-09-12", totalTracks: 16 }],
  ["hits", { albumType: "compilation", releaseDate: "2026-01-01", totalTracks: 30 }],
]);

test("pickMain prefers the album, then the newest release", () => {
  assert.equal(pickMain(["single", "ep", "album", "hits"], releases), "album");
  assert.equal(pickMain(["single", "ep", "hits"], releases), "ep");
});

test("planDedupe puts the main copy wherever any copy was, and removes the rest", () => {
  const lib = {
    playlists: [
      { id: "rock", name: "Rock", imageUrl: null, trackIds: ["single", "other"] },
      { id: "starset", name: "STARSET", imageUrl: null, trackIds: ["album", "ep"] },
      { id: "theirs", name: "Theirs", imageUrl: null, trackIds: ["ep"] },
      { id: "clean", name: "Clean", imageUrl: null, trackIds: ["album"] },
    ],
    liked: [{ id: "ep", addedAt: "" }],
  } as Pick<Library, "playlists" | "liked"> as Library;
  const plan = planDedupe(lib, [["single", "ep", "album"], ["other"]], releases, ["theirs"]);
  assert.deepEqual(plan.merges, [{ main: "album", copies: ["single", "ep"] }]);
  assert.deepEqual([...plan.playlists], [
    ["rock", { add: ["album"], remove: ["single"] }],
    ["starset", { add: [], remove: ["ep"] }],
  ]);
  assert.deepEqual([plan.like, plan.unlike], [["album"], ["ep"]]);
});
