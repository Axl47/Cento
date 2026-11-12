import assert from "node:assert/strict";
import { test } from "node:test";
import type { SongFeatures } from "./features.ts";
import type { Library } from "./library.ts";
import type { SongTags } from "./tags.ts";
import { closeTo, songWords, topArtists, traits } from "./traits.ts";

const song = (over: Partial<SongFeatures>): SongFeatures => ({
  bpm: 100, steady: true, key: "C major", camelot: "8B", keyStrength: 0.9, lufs: -9, intro: 0, outro: 0, vocals: 0.8, vocalsFirst: 1, vocalsLast: 100, ...over,
});
const tagged = (genre: string, sad: number): SongTags => ({ genres: [[genre, 0.6]], moods: { sad, happy: 1 - sad } });
const ids = (prefix: string) => [1, 2, 3, 4].map((n) => prefix + n);
const [trap, pop] = [ids("trap"), ids("pop")];
const lib = {
  tracks: Object.fromEntries([...trap, ...pop].map((id) => [id, { id, isrc: null, artists: [{ name: id.startsWith("trap") ? "A" : id }] }])),
} as unknown as Library;

test("a group is described by what sets it apart from the songs around it", () => {
  const data = {
    lib,
    features: new Map([...trap.map((id) => [id, song({ bpm: 140, lufs: -12 })] as const), ...pop.map((id) => [id, song({})] as const)]),
    languages: new Map([...trap.map((id) => [id, "es"] as const), ...pop.map((id) => [id, "en"] as const)]),
    tags: new Map([...trap.map((id) => [id, tagged("Trap", 0.8)] as const), ...pop.map((id) => [id, tagged("Pop", 0.2)] as const)]),
  };

  assert.deepEqual(traits(data, trap, [...trap, ...pop]), ["Trap", "sad", "140 BPM", "quieter", "Spanish"]);
  assert.deepEqual(traits(data, [...trap, ...pop], [...trap, ...pop]), []);
});

test("the artists with the most songs come first", () => {
  assert.deepEqual(topArtists(lib, [...trap, "pop1"], 1), ["A"]);
});

test("a song is put in words only where the data is sure", () => {
  const tags: SongTags = { genres: [["Trap", 0.4], ["Cloud Rap", 0.3], ["House", 0.1]], moods: { sad: 0.8, party: 0.9 } };

  assert.deepEqual(songWords(tags, song({ bpm: 140.2, key: "F minor" })), ["Trap", "party", "140 BPM", "F minor"]);
  assert.deepEqual(songWords({ genres: [["Trap", 0.1]], moods: { sad: 0.5 } }, song({ steady: false, keyStrength: 0.5 })), []);
  assert.deepEqual(songWords(undefined, undefined), []);
});

test("a group is close to the playlists that hold much of it and little of the rest of its parent", () => {
  const parent = Array.from({ length: 20 }, (_, i) => `s${i}`);
  const group = parent.slice(0, 6);
  const others = [
    { id: "matches", trackIds: ["s0", "s1", "s2", "s10", "elsewhere"] },
    { id: "everywhere", trackIds: parent },
    { id: "barely", trackIds: ["s4"] },
  ];

  assert.deepEqual(closeTo(group, parent, others, 2), [{ id: "matches", count: 3 }]);
});

test("a group released years before the songs around it is named by its typical year", () => {
  const years = { old1: 2006, old2: 2008, old3: 2009, new1: 2019, new2: 2021, new3: 2022, undated: undefined };
  const dated = { tracks: Object.fromEntries(Object.entries(years).map(([id, year]) => [id, { id, isrc: null, artists: [], year }])) } as unknown as Library;
  const data = { lib: dated, features: null, languages: null, tags: null };

  assert.deepEqual(traits(data, ["old1", "old2", "old3", "undated"], Object.keys(years)), ["2008"]);
  assert.deepEqual(traits(data, ["new1", "new2"], ["new1", "new2", "new3"]), []);
});
