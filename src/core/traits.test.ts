import assert from "node:assert/strict";
import { test } from "node:test";
import type { SongFeatures } from "./features.ts";
import type { Library } from "./library.ts";
import type { SongTags } from "./tags.ts";
import { topArtists, traits } from "./traits.ts";

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
