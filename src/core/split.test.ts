import assert from "node:assert/strict";
import { test } from "node:test";
import { decodeVectors, encodeVectors, type AudioIndex } from "./audio.ts";
import type { Library } from "./library.ts";
import { genreGroups, soundGroups, themeGroups } from "./split.ts";
import { themeIndex } from "./themes.ts";

const angle = (deg: number) => Float32Array.from([Math.cos((deg * Math.PI) / 180), Math.sin((deg * Math.PI) / 180), 0]);
/** Songs named by their angle on a circle: songs at nearby angles sound alike. */
const sound = (degrees: number[]) => {
  const raw = encodeVectors(degrees.map(angle));
  return {
    index: { ids: degrees.map(String) } as AudioIndex,
    vectors: decodeVectors(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength) as ArrayBuffer),
  };
};

test("songs split into the groups that sound alike, biggest first, most typical song first", () => {
  const degrees = [0, 122, 4, 240, 8, 118, 2, 6, 120];
  const { groups, unplaced } = soundGroups(sound(degrees), degrees.map(String), 3);

  assert.deepEqual(groups.map((g) => [...g].sort((a, b) => +a - +b)), [["0", "2", "4", "6", "8"], ["118", "120", "122"], ["240"]]);
  assert.equal(groups[0]![0], "4");
  assert.deepEqual(unplaced, []);
});

test("the same songs always split the same way", () => {
  const degrees = Array.from({ length: 40 }, (_, i) => (i * 37) % 360);
  const ids = degrees.map(String);

  assert.deepEqual(soundGroups(sound(degrees), ids, 4), soundGroups(sound(degrees), ids, 4));
});

test("songs without a sound vector are set aside, and too few songs stay as one group", () => {
  assert.deepEqual(soundGroups(sound([0, 90]), ["0", "x", "90"], 2), { groups: [["0", "90"]], unplaced: ["x"] });
});

test("songs group under the themes most of them are about, clearest first, and the rest are left out", () => {
  const scores = { love1: [3, 0, 0], love2: [2, 1.5, 0], war1: [0, 2, 0], war2: [1.2, 4, 0], sea1: [0, 0, 5], vague: [0.5, 0.4, 0.2] };
  const index = themeIndex({ themes: ["love", "war", "sea"], songs: Object.entries(scores).map(([key, s]) => ({ key, scores: s, passages: [], best: [] })) });
  const lib = { tracks: Object.fromEntries([...Object.keys(scores), "silent"].map((id) => [id, { id, isrc: null }])) } as unknown as Library;

  assert.deepEqual(themeGroups(index, lib, ["vague", "war1", "love2", "silent", "sea1", "love1", "war2"], 2), {
    groups: [["love1", "love2"], ["war2", "war1"]],
    names: ["love", "war"],
    unplaced: ["vague", "silent", "sea1"],
  });
});

test("songs group under the genres most of them lead with (catch-all genres aside), surest first, and the rest are left out", () => {
  const tags = new Map(
    Object.entries({
      dnb1: [["Drum n Bass", 0.5], ["Breakcore", 0.2]],
      dnb2: [["K-pop", 0.5], ["Drum n Bass", 0.3]],
      core1: [["Breakcore", 0.6]],
      core2: [["Breakcore", 0.4], ["Drum n Bass", 0.3]],
      mostlyTrance: [["Trance", 0.4], ["Breakcore", 0.2]],
      faint: [["Ambient", 0.4], ["Breakcore", 0.05]],
    } satisfies Record<string, [string, number][]>).map(([id, genres]) => [id, { genres, moods: {} }]),
  );

  assert.deepEqual(genreGroups(tags, ["faint", "dnb2", "core2", "untagged", "mostlyTrance", "core1", "dnb1"], 2), {
    groups: [["core1", "core2", "mostlyTrance"], ["dnb1", "dnb2"]],
    names: ["Breakcore", "Drum n Bass"],
    unplaced: ["faint", "untagged"],
  });
});
