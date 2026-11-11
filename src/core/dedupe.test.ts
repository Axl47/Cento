import assert from "node:assert/strict";
import { test } from "node:test";
import { pickMain, planDedupe, restoreDates, type Release } from "./dedupe.ts";
import type { Library } from "./library.ts";

const releases = new Map<string, Release>([
  ["single", { albumType: "single", releaseDate: "2024-11-08", totalTracks: 4, explicit: true }],
  ["ep", { albumType: "single", releaseDate: "2025-02-28", totalTracks: 5, explicit: true }],
  ["album", { albumType: "album", releaseDate: "2025-09-12", totalTracks: 16, explicit: true }],
  ["hits", { albumType: "compilation", releaseDate: "2026-01-01", totalTracks: 30, explicit: true }],
  ["clean", { albumType: "album", releaseDate: "2026-01-01", totalTracks: 16, explicit: false }],
]);

test("pickMain prefers explicit, then the album, then the newest release", () => {
  assert.equal(pickMain(["single", "ep", "album", "hits", "clean"], releases), "album");
  assert.equal(pickMain(["single", "ep", "hits"], releases), "ep");
});

test("planDedupe puts the main copy wherever any copy was, and removes the rest", () => {
  const lib = {
    playlists: [
      { id: "rock", name: "Rock", imageUrl: null, trackIds: ["single", "other"], addedAt: { single: "2024-12-01" } },
      { id: "starset", name: "STARSET", imageUrl: null, trackIds: ["album", "ep"] },
      { id: "theirs", name: "Theirs", imageUrl: null, trackIds: ["ep"] },
      { id: "clean", name: "Clean", imageUrl: null, trackIds: ["album"] },
    ],
    liked: [{ id: "ep", addedAt: "2025-03-01" }],
  } as Pick<Library, "playlists" | "liked"> as Library;
  const plan = planDedupe(lib, [["single", "ep", "album"], ["other"]], releases, ["theirs"]);
  assert.deepEqual(plan.merges, [{ main: "album", copies: ["single", "ep"], addedAt: { rock: "2024-12-01", liked: "2025-03-01" } }]);
  assert.deepEqual([...plan.playlists], [
    ["rock", { add: ["album"], remove: ["single"] }],
    ["starset", { add: [], remove: ["ep"] }],
  ]);
  assert.deepEqual([plan.like, plan.unlike], [["album"], ["ep"]]);
});

test("restoreDates puts back the earliest logged date, wherever the main copy still is", () => {
  const lib = {
    playlists: [
      { id: "rock", name: "Rock", imageUrl: null, trackIds: ["album"], addedAt: { album: "2026-11-11" } },
      { id: "pop", name: "Pop", imageUrl: null, trackIds: ["album"], addedAt: { album: "2020-01-01" } },
    ],
    liked: [{ id: "album", addedAt: "2026-11-11" }],
  } as Pick<Library, "playlists" | "liked"> as Library;
  const fixed = restoreDates(lib, [{ main: "album", copies: ["single"], addedAt: { rock: "2024-12-01", pop: "2024-12-01", liked: "2025-03-01" } }]);
  assert.deepEqual(fixed.playlists.map((p) => p.addedAt?.album), ["2024-12-01", "2020-01-01"]);
  assert.equal(fixed.liked[0]!.addedAt, "2025-03-01");
});
