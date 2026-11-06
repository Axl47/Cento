import { test } from "node:test";
import assert from "node:assert/strict";
import { config } from "./config.ts";
import type { Library, Track } from "./library.ts";
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
