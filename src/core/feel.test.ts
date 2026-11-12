import assert from "node:assert/strict";
import { test } from "node:test";
import { decodeVectors, encodeVectors } from "./audio.ts";
import { ANY_FEEL, feelMatch, hasFeel, likeness } from "./feel.ts";
import type { SongFeatures } from "./features.ts";

const features = (over: Partial<SongFeatures>) => ({ bpm: 140, steady: true, vocals: 0.8, ...over }) as SongFeatures;
const tags = { genres: [["Trap", 0.4]] as [string, number][], moods: { sad: 0.8, party: 0.2 } };

test("a song has a feel only when it has every part of it", () => {
  const song = { features: features({}), tags, language: "es", year: 2009 };

  assert.equal(hasFeel(ANY_FEEL), false);
  assert.equal(feelMatch(ANY_FEEL, {}), 1);
  assert.ok(feelMatch({ moods: ["sad"], genre: "Trap", tempo: "130+", instrumental: false, language: "es", era: "2000s" }, song) > 0);
  assert.equal(feelMatch({ ...ANY_FEEL, moods: ["sad", "party"] }, song), 0);
  assert.equal(feelMatch({ ...ANY_FEEL, genre: "House" }, song), 0);
  assert.equal(feelMatch({ ...ANY_FEEL, tempo: "<100" }, song), 0);
  assert.equal(feelMatch({ ...ANY_FEEL, tempo: "130+" }, { features: features({ steady: false }) }), 0);
  assert.equal(feelMatch({ ...ANY_FEEL, instrumental: true }, song), 0);
  assert.equal(feelMatch({ ...ANY_FEEL, language: "en" }, song), 0);
  assert.equal(feelMatch({ ...ANY_FEEL, era: "2010s" }, song), 0);
  assert.equal(feelMatch({ ...ANY_FEEL, era: "2000s" }, { ...song, year: undefined }), 0);
});

test("a surer mood ranks a song higher", () => {
  const feel = { ...ANY_FEEL, moods: ["sad"] };

  assert.ok(feelMatch(feel, { tags }) > feelMatch(feel, { tags: { genres: [], moods: { sad: 0.6 } } }));
});

test("songs are ranked by how much they sound like a set taken together", () => {
  const angle = (deg: number) => Float32Array.from([Math.cos((deg * Math.PI) / 180), Math.sin((deg * Math.PI) / 180), 0]);
  const raw = encodeVectors([0, 20, 10, 90].map(angle));
  const like = likeness(decodeVectors(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength) as ArrayBuffer), [0, 1]);

  assert.ok(like(2) > 0.99);
  assert.ok(like(2) > like(3));
});
