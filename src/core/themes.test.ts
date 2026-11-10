import assert from "node:assert/strict";
import { test } from "node:test";
import type { Library, Track } from "./library.ts";
import { readPlaylist, scoreThemes, sharedThemes, songThemes, soundWithoutMeaning, themeExamples, themeIndex, type ThemeSong } from "./themes.ts";

const track = (id: string, artist = "a"): Track => ({
  id,
  name: id,
  artists: [{ id: artist, name: artist }],
  album: { name: "", imageUrl: null },
  isrc: null,
  durationMs: 1,
});
const song = (key: string, scores: number[]): ThemeSong => ({ key, scores, passages: [`${key} words`], best: scores.map(() => 0) });
const libraryOf = (tracks: Track[]) => ({ tracks: Object.fromEntries(tracks.map((t) => [t.id, t])) }) as Library;

test("a theme is standardized within each language, and a stray passage can't carry a song", () => {
  // Two 1-d "languages": the second scores higher across the board, by the model's bias alone.
  const index = {
    keys: ["en1", "en2", "es1", "es2", "mixed", "mixed", "mixed", "mixed"],
    passages: ["a", "b", "c", "d", "stray", "quiet1", "quiet2", "quiet3"],
    vectors: new Float32Array([0.1, 0.5, 0.8, 1, 1, 0, 0, 0]),
    dim: 1,
  };
  const language = (key: string) => (key.startsWith("es") ? "es" : "en");

  const { songs } = scoreThemes(index, new Float32Array([1]), ["t"], language, 2);
  const score = (key: string) => songs.find((s) => s.key === key)!.scores[0]!;

  assert.equal(score("es1"), -1);
  assert.equal(score("es2"), 1);
  assert.ok(score("mixed") < score("en2")); // its one strong passage averages down with its other best two
  assert.equal(songs.find((s) => s.key === "mixed")!.passages[songs.find((s) => s.key === "mixed")!.best[0]!], "stray");
});

const THEMES = ["love", "war"];
const members = Array.from({ length: 16 }, (_, i) => track(`m${i}`, `artist${i % 2}`));
const index = themeIndex({ themes: THEMES, songs: members.map((t, i) => song(t.id, [1 + i / 10, 0])) });
const reading = readPlaylist(index, libraryOf(members), { trackIds: members.map((t) => t.id) });

test("a playlist's clear themes are those above the noise for its size", () => {
  assert.deepEqual(reading.clear.map((t) => t.name), ["love"]);
  assert.equal(reading.members.length, 16);

  const tiny = readPlaylist(index, libraryOf(members), { trackIds: members.slice(0, 7).map((t) => t.id) });
  assert.deepEqual(tiny.clear, []);
});

test("two releases of a song count once", () => {
  const twins = [{ ...track("x"), isrc: "ISRC" }, { ...track("y"), isrc: "ISRC" }];
  const data = themeIndex({ themes: THEMES, songs: [song("ISRC", [1, 0])] });

  const got = readPlaylist(data, libraryOf(twins), { trackIds: ["x", "y"] });

  assert.equal(got.members.length, 1);
  assert.equal(got.songCount, 2);
});

test("examples spread across artists before repeating one", () => {
  const got = themeExamples(index, reading, 0, 3);

  assert.deepEqual(got.map((e) => e.track.id), ["m15", "m14", "m13"]);
  assert.equal(got[0]!.passage, "m15 words");
});

test("only a clearly standing-out theme labels a song, and sharing needs less", () => {
  const data = themeIndex({ themes: THEMES, songs: [song("strong", [3.2, 2.4]), song("mild", [1.6, 0])] });

  assert.deepEqual(songThemes(data, track("strong")).map((m) => m.name), ["love"]);
  assert.deepEqual(songThemes(data, track("mild")), []);
  assert.deepEqual(songThemes(data, track("unknown")), []);
  assert.deepEqual(sharedThemes(reading, data, track("mild")).map((t) => t.name), ["love"]);
});

test("a mismatch sounds like the playlist, misses its themes, and reads as something else", () => {
  const belongs = Array.from({ length: 13 }, (_, i) => track(`b${i}`));
  const off = [track("says-else"), track("quiet-sound"), track("says-nothing")];
  const data = themeIndex({
    themes: THEMES,
    songs: [
      ...belongs.map((t) => song(t.id, [1.5, 0])),
      song("says-else", [-1, 2]),
      song("quiet-sound", [-1, 2]),
      song("says-nothing", [-1, 0]),
    ],
  });
  const all = [...belongs, ...off];
  const got = readPlaylist(data, libraryOf(all), { trackIds: all.map((t) => t.id) });
  const sound = (t: Track) => (t.id === "quiet-sound" ? 0.01 : 0.5);

  const found = soundWithoutMeaning(data, got, sound, 5);

  assert.deepEqual(found.map((m) => [m.track.id, m.instead.name]), [["says-else", "war"]]);
});
