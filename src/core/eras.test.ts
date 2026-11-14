import assert from "node:assert/strict";
import { test } from "node:test";
import { chooseSegmentation, definingSongs, findEras, monthRange, profile, segmentations, weekOf, type Listen, type SongName, type SongTraits, type Space } from "./eras.ts";

const DAY = 86_400_000;
const H = 3_600_000;
const space: Space = { genres: ["Rock", "Reggaeton"], moods: ["sad"], themes: ["love", "parties"] };
const rock: SongTraits = { genres: [1, 0], moods: [0.8], themes: [1, -1], language: "en" };
const reggaeton: SongTraits = { genres: [0, 1], moods: [0.2], themes: [-1, 1], language: "es" };

test("a profile averages over the songs it knows, so unknown songs don't pull it toward zero", () => {
  const traits = new Map([["a", rock]]);
  const p = profile([{ trackId: "a", at: 0, ms: H }, { trackId: "unsaved", at: 0, ms: 3 * H }], traits, space);
  assert.deepEqual(p.genres, [1, 0]);
  assert.equal(p.soundMs / p.ms, 0.25);
  assert.deepEqual(p.languages, { en: 1 });
});

test("months run across a year end, and weeks start on Monday", () => {
  assert.deepEqual(monthRange("2019-11", "2020-02"), ["2019-11", "2019-12", "2020-01", "2020-02"]);
  const sunday = Date.parse("2024-01-07T23:00:00Z");
  assert.equal(weekOf(sunday), weekOf(Date.parse("2024-01-01T00:00:00Z")));
  assert.notEqual(weekOf(sunday), weekOf(sunday + 2 * 3_600_000));
});

test("segmentation finds a planted change, keeps runs at least minLength long, and stops at noise", () => {
  const points = [0, 0.1, 0, 0.1, 0, 5, 5.1, 5, 5.1, 5, 5].map((v) => ({ x: [v], w: 1 }));
  const options = segmentations(points, 4, 3);
  assert.deepEqual(options[1]!.starts, [0, 5]);
  for (const { starts } of options) starts.forEach((s, i) => assert.ok((starts[i + 1] ?? points.length) - s >= 3));
  assert.deepEqual(chooseSegmentation(options, 0.03)!.starts, [0, 5]);
});

test("defining songs are the ones a period holds most of, not loops of one week or all-time favorites", () => {
  const names = new Map<string, SongName>();
  const weekly = (trackId: string, weeks: number, perWeek: number): Listen[] =>
    Array.from({ length: weeks * perWeek }, (_, i) => ({ trackId, at: Math.floor(i / perWeek) * 7 * DAY, ms: H / 20 }));
  const period = [...weekly("only-now", 4, 3), ...weekly("favorite", 4, 6), ...weekly("one-week-loop", 1, 30)];
  // "favorite" is played as much in every other period; "only-now" never outside this one.
  const totals = new Map([["only-now", 12 * (H / 20)], ["favorite", 24 * 5 * (H / 20)], ["one-week-loop", 30 * (H / 20)]]);
  const songs = definingSongs(period, totals, 0.2, names, 5);
  assert.deepEqual(songs.map((s) => s.trackId), ["only-now"]);
  assert.equal(songs[0]!.lift, 5);
});

test("findEras splits where the sound and themes changed and describes each side", () => {
  const traits = new Map([["r", rock], ["g", reggaeton]]);
  const names = new Map<string, SongName>([["r", { name: "Rock Song", artist: "Band", saved: true }], ["g", { name: "Perreo", artist: "Cantante", saved: true }]]);
  const listens: Listen[] = [];
  const months = monthRange("2020-01", "2021-12");
  months.forEach((month, m) => {
    const start = Date.parse(`${month}-01T12:00:00Z`);
    for (let d = 0; d < 28; d++) listens.push({ trackId: m < 12 ? "r" : "g", at: start + d * DAY, ms: H });
  });
  const file = findEras(listens, traits, space, names, new Date(0));
  assert.deepEqual(file.eras.map((e) => [e.from, e.to]), [["2020-01", "2020-12"], ["2021-01", "2021-12"]]);
  const [first, second] = file.eras;
  assert.equal(first!.artists[0]!.name, "Band");
  assert.equal(first!.genres.more[0]!.name, "Rock");
  assert.equal(second!.themes.more[0]!.name, "parties");
  assert.deepEqual(first!.next!.arrived, ["Cantante"]);
  assert.equal(file.months.length, 24);
});
