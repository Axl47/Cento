import { test } from "node:test";
import assert from "node:assert/strict";
import { config } from "./config.ts";
import { inbox, type Library, type Track } from "./library.ts";

import { buildModel, prechecked, suggest } from "./suggest.ts";

const track = (id: string, artist: string): Track => ({
  id,
  name: id,
  artists: [{ id: artist, name: artist }],
  album: { name: "", imageUrl: null },
  isrc: null,
  durationMs: 1,
});

// a1 songs live in "chill" (+ usually "night"); a2 songs live in "gym".
const lib: Library = {
  fetchedAt: "",
  userId: "me",
  liked: [],
  tracks: Object.fromEntries(
    [track("s1", "a1"), track("s2", "a1"), track("s3", "a1"), track("s4", "a2"), track("s5", "a2"), track("new", "a1"), track("stranger", "a9")].map(
      (t) => [t.id, t],
    ),
  ),
  playlists: [
    { id: "chill", name: "Chill", imageUrl: null, trackIds: ["s1", "s2", "s3"] },
    { id: "night", name: "Night", imageUrl: null, trackIds: ["s1", "s2"] },
    { id: "gym", name: "Gym", imageUrl: null, trackIds: ["s4", "s5"] },
    { id: config.allPlaylistId, name: "Everything", imageUrl: null, trackIds: ["s1", "s2", "s3", "s4", "s5"] },
    { id: config.ignoredPlaylistIds[0]!, name: "Someone else's", imageUrl: null, trackIds: ["s1", "s2", "s3", "s4"] },
  ],
};
const model = buildModel(lib);

test("never suggests the all-songs or ignored playlists", () => {
  const ids = suggest(model, lib.tracks.new!).map((s) => s.playlistId);
  assert.deepEqual(ids.toSorted(), ["chill", "gym", "night"]);
});

test("ranks the playlists holding the artist's other songs first", () => {
  const [first, second] = suggest(model, lib.tracks.new!).map((s) => s.playlistId);
  assert.equal(first, "chill");
  assert.equal(second, "night");
});

test("after a pick, its usual partner outranks unrelated playlists for an unknown artist", () => {
  const ranked = suggest(model, lib.tracks.stranger!, ["chill"]).filter((s) => s.playlistId !== "chill");
  assert.equal(ranked[0]?.playlistId, "night");
  assert.ok(ranked[0]!.parts.pairing > 0);
});

test("audio neighbors vote for their playlists", () => {
  const neighbors = () => [{ id: "s4", sim: 0.9 }, { id: "s5", sim: 0.8 }];
  const [first] = suggest(model, lib.tracks.stranger!, [], neighbors);
  assert.equal(first?.playlistId, "gym");
  assert.ok(first!.parts.audio > 0);
});

test("prechecks confident playlists for known artists only, never on audio alone", () => {
  assert.deepEqual(prechecked(model, lib.tracks.new!, suggest(model, lib.tracks.new!)), ["chill", "night"]);
  const neighbors = () => [{ id: "s4", sim: 0.95 }, { id: "s5", sim: 0.95 }];
  const audioOnly = suggest(model, lib.tracks.stranger!, [], neighbors);
  assert.ok(audioOnly[0]!.score >= 0.4);
  assert.deepEqual(prechecked(model, lib.tracks.stranger!, audioOnly), []);
});

test("artist rules: matching songs get the playlist on top and prechecked; others never see it", () => {
  const ruled = buildModel(lib, { rules: { gym: [{ id: "a2", name: "A2" }, { id: "a9", name: "A9" }] } });

  // "stranger" is by a9, one of the rule's artists (OR), even though gym has none of a9's songs.
  const forStranger = suggest(ruled, lib.tracks.stranger!);
  assert.equal(forStranger[0]?.playlistId, "gym");
  assert.equal(forStranger[0]?.parts.rule, 1);
  assert.deepEqual(prechecked(ruled, lib.tracks.stranger!, forStranger), ["gym"]);

  // "new" is by a1: gym is not suggested at all, even with audio pointing at it.
  const neighbors = () => [{ id: "s4", sim: 0.99 }, { id: "s5", sim: 0.99 }];
  assert.ok(!suggest(ruled, lib.tracks.new!, [], neighbors).some((s) => s.playlistId === "gym"));
});

test("hidden playlists are never suggested, and songs only in them still need sorting", () => {
  const hidden = ["night"];
  const ids = suggest(buildModel(lib, { hidden }), lib.tracks.new!).map((s) => s.playlistId);
  assert.deepEqual(ids.toSorted(), ["chill", "gym"]);

  const onlyHidden: Library = { ...lib, liked: [{ id: "new", addedAt: "" }], playlists: [...lib.playlists, { id: "best", name: "Best of", imageUrl: null, trackIds: ["new"] }] };
  assert.deepEqual(inbox(onlyHidden).map((l) => l.id), []);
  assert.deepEqual(inbox(onlyHidden, ["best"]).map((l) => l.id), ["new"]);
});

test("an empty rule is the same as no rule", () => {
  const empty = buildModel(lib, { rules: { gym: [] } });
  assert.deepEqual(
    suggest(empty, lib.tracks.new!).map((s) => s.playlistId),
    suggest(model, lib.tracks.new!).map((s) => s.playlistId),
  );
});
