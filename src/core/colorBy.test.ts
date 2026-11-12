import assert from "node:assert/strict";
import { test } from "node:test";
import { categorize, TOP_GENRES, type SongTraits } from "./colorBy.ts";
import type { SongFeatures } from "./features.ts";
import type { SongTags } from "./tags.ts";

const moods = (m: Partial<Record<string, number>>): SongTags => ({
  genres: [],
  moods: { aggressive: 0, relaxed: 0, sad: 0, party: 0, acoustic: 0, electronic: 0, ...m },
});
const tempo = (bpm: number | null, steady = true) => ({ features: { bpm, steady } as SongFeatures });
const run = (mode: Parameters<typeof categorize>[0], songs: Record<string, SongTraits>) =>
  categorize(mode, Object.keys(songs), (id) => songs[id]!);

test("a song takes its likeliest mood only when that mood is at least even odds", () => {
  const { of } = run("mood", { a: { tags: moods({ aggressive: 0.7, party: 0.6 }) }, b: { tags: moods({ sad: 0.45 }) }, c: {} });
  assert.deepEqual([...of], [["a", "Aggressive"]]);
});

test("tempo bands need a steady beat, and eras run old to new", () => {
  const t = run("tempo", { slow: tempo(90), edge: tempo(130), loose: tempo(120, false), none: tempo(null) });
  assert.deepEqual([...t.of], [["slow", "<100 BPM"], ["edge", "130+ BPM"]]);
  assert.deepEqual(t.categories, ["<100 BPM", "100–130 BPM", "130+ BPM"]);
  const e = run("era", { old: { year: 1995 }, mid: { year: 2009 }, now: { year: 2020 }, none: {} });
  assert.deepEqual([...e.of], [["old", "Before 2000"], ["mid", "2000s"], ["now", "2020s"]]);
  assert.deepEqual(e.categories, ["Before 2000", "2000s", "2010s", "2020s"]);
});

test("genre keeps the most common top genres, skipping catch-alls for the song's next genre", () => {
  const songs: Record<string, SongTraits> = {};
  const genre = (...names: string[]): SongTraits => ({ tags: { genres: names.map((n) => [n, 0.3]), moods: {} } });
  // Genre g0 leads 12 songs, g1 11, …; the eleventh-commonest one is left without a color.
  for (let g = 0; g <= TOP_GENRES; g++) for (let n = 0; n < 12 - g; n++) songs[`g${g}-${n}`] = genre(`G${g}`);
  songs.cloud = genre("Cloud Rap", "K-pop", "G0");
  const { categories, of } = run("genre", songs);
  assert.equal(categories.length, TOP_GENRES);
  assert.equal(categories[0], "G0");
  assert.equal(of.get("cloud"), "G0");
  assert.equal(of.has(`g${TOP_GENRES}-0`), false);
});
