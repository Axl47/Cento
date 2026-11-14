import assert from "node:assert/strict";
import { test } from "node:test";
import type { Library } from "./library.ts";
import type { SongPlays, YearPlays, YearTotals } from "./plays.ts";
import { fading, neverPlayed, rediscover } from "./review.ts";

const NOW = new Date("2026-11-14T00:00:00Z");
const year = (y: number, plays: number, skips = 0, shuffled = 0): YearPlays => ({ year: y, plays, skips, shuffled });
const song = (last: string, ...years: YearPlays[]): SongPlays => ({
  plays: years.reduce((n, y) => n + y.plays, 0),
  skips: years.reduce((n, y) => n + y.skips, 0),
  last,
  years,
});

test("rediscover: loved songs gone quiet for a year, the least skipped first among equals", () => {
  const plays = new Map([
    ["skippy", song("2024-01-01T00:00:00Z", year(2023, 50, 40))],
    ["loved", song("2024-01-01T00:00:00Z", year(2020, 10), year(2021, 40, 2))],
    ["recent", song("2026-06-01T00:00:00Z", year(2026, 80))],
    ["few", song("2020-01-01T00:00:00Z", year(2019, 5))],
    ["unsaved", song("2020-01-01T00:00:00Z", year(2019, 90))],
  ]);
  const found = rediscover(plays, new Set(["skippy", "loved", "recent", "few"]), NOW, { minPlays: 30 });
  assert.deepEqual(found.map((r) => r.id), ["loved", "skippy"]);
  assert.equal(found[0]!.peak.year, 2021);
});

// Every year, the library skips 10% of plays with shuffle off and 40% with it on.
const totals: YearTotals[] = [2022, 2023, 2024, 2025, 2026].map((y) => ({ year: y, plays: 1500, skips: 500, shuffled: 1000, shuffledSkips: 400 }));
const saved = new Set(["tired", "steady", "shuffled", "thin"]);

test("fading: a song skipped more than it was, beyond what the library and shuffle explain", () => {
  const plays = new Map([
    ["tired", song("2026-10-01T00:00:00Z", year(2023, 27, 3), year(2025, 10, 10))],
    ["steady", song("2026-10-01T00:00:00Z", year(2023, 27, 3), year(2025, 18, 2))],
    // Played deliberately back then, on shuffle now: more skips, but no more than shuffle brings.
    ["shuffled", song("2026-10-01T00:00:00Z", year(2023, 27, 3), year(2026, 12, 8, 20))],
    // Skipped a lot lately, but on too few plays to tell.
    ["thin", song("2026-10-01T00:00:00Z", year(2023, 27, 3), year(2026, 1, 3))],
  ]);
  const found = fading(plays, totals, saved, NOW);
  assert.deepEqual(found.map((f) => f.id), ["tired"]);
  const [tired] = found;
  assert.deepEqual([tired!.then.plays, tired!.then.skips, tired!.now.plays, tired!.now.skips], [27, 3, 10, 10]);
  assert.ok(Math.abs(tired!.then.expected - 3) < 1e-9);
  assert.ok(tired!.now.ratio > 1.5 * tired!.then.ratio);
});

test("neverPlayed: unheard songs, skipped or not, oldest arrival first, with the playlists holding them", () => {
  const lib: Pick<Library, "tracks" | "liked" | "playlists"> = {
    tracks: { heard: {}, skipped: {}, untouched: {}, liked: {} } as unknown as Library["tracks"],
    liked: [{ id: "liked", addedAt: "2024-01-01T00:00:00Z" }],
    playlists: [
      { id: "p", name: "P", imageUrl: null, trackIds: ["heard", "skipped", "untouched", "liked"], addedAt: { untouched: "2022-01-01T00:00:00Z", liked: "2025-01-01T00:00:00Z" } },
      { id: "q", name: "Q", imageUrl: null, trackIds: ["untouched"], addedAt: { untouched: "2021-01-01T00:00:00Z" } },
    ],
  };
  const plays = new Map([
    ["heard", song("2026-01-01T00:00:00Z", year(2026, 1))],
    ["skipped", song("2026-01-01T00:00:00Z", year(2026, 0, 2))],
  ]);
  assert.deepEqual(neverPlayed(plays, lib), [
    { id: "untouched", skips: 0, addedAt: "2021-01-01T00:00:00Z", playlists: ["p", "q"] },
    { id: "liked", skips: 0, addedAt: "2024-01-01T00:00:00Z", playlists: ["p"] },
    { id: "skipped", skips: 2, addedAt: null, playlists: ["p"] },
  ]);
});
