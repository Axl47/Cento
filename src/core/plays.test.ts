import assert from "node:assert/strict";
import { test } from "node:test";
import { decodePlays, decodeYearTotals, joinPlays, otherReleases, parseExport, parseLive, playsFile, resolveMerges, type Play, type PlaysFile } from "./plays.ts";

const T = Date.parse("2026-11-12T20:00:00Z");
const MIN = 60_000;
const iso = (ms: number) => new Date(ms).toISOString();

/** A live history row as Spotify sends it, trimmed to the fields that matter. */
const liveRow = (id: string, at: number, context: string | null = null) => ({
  track: { id, uri: `spotify:track:${id}`, duration_ms: 3 * MIN, external_ids: { isrc: "X" } },
  played_at: iso(at),
  context: context && { type: "playlist", uri: context },
});

/** An export row: `ts` is when the play ended. */
const exportRow = (id: string | null, ts: number, ms_played = 3 * MIN): Record<string, unknown> => ({
  ts: iso(ts),
  ms_played,
  spotify_track_uri: id && `spotify:track:${id}`,
  master_metadata_track_name: "Song",
  master_metadata_album_artist_name: "Artist",
  reason_start: "trackdone",
  reason_end: "trackdone",
  skipped: false,
});

const live = (...rows: ReturnType<typeof liveRow>[]) => rows.map(parseLive).filter((p) => p !== null);
const exported = (...rows: ReturnType<typeof exportRow>[]) => rows.map(parseExport).filter((p) => p !== null);

test("parses both formats, and drops rows that aren't track plays", () => {
  assert.deepEqual(parseLive(liveRow("a", T, "spotify:playlist:p")), { trackId: "a", at: T, context: "spotify:playlist:p", isrc: "X", source: "live" });
  assert.deepEqual(parseLive(liveRow("a", T)), { trackId: "a", at: T, isrc: "X", source: "live" });
  assert.equal(parseLive({ ...liveRow("a", T), track: { id: null } }), null); // local file
  assert.deepEqual(parseExport(exportRow("a", T, 12_000)), { trackId: "a", at: T, msPlayed: 12_000, skipped: false, song: "song\nartist", source: "export" });
  assert.equal(parseExport(exportRow(null, T)), null); // podcast
  assert.equal(parseExport({ ...exportRow(null, T), spotify_track_uri: "spotify:episode:e" }), null);
});

test("a play in both sources counts once, with the export's numbers and the live context", () => {
  // The export's ts is played_at cut to the second.
  const { plays, matched } = joinPlays(live(liveRow("a", T + 400, "spotify:playlist:p")), exported(exportRow("a", T, 170_000)));
  assert.equal(matched, 1);
  assert.deepEqual(plays, [{ trackId: "a", at: T, msPlayed: 170_000, skipped: false, song: "song\nartist", context: "spotify:playlist:p", source: "both" }]);
});

test("a song on repeat pairs each play with its own row, and a skip before a play stays its own", () => {
  const { plays, matched } = joinPlays(
    live(liveRow("a", T), liveRow("a", T + 3 * MIN)),
    exported(exportRow("a", T - 3 * MIN, 5_000), exportRow("a", T), exportRow("a", T + 3 * MIN)),
  );
  assert.equal(matched, 2);
  assert.deepEqual(plays.map((p) => [p.source, p.at]), [["export", T - 3 * MIN], ["both", T], ["both", T + 3 * MIN]]);
});

test("plays outside the overlap, or of other songs, aren't joined", () => {
  const { plays, matched } = joinPlays(live(liveRow("a", T), liveRow("b", T)), exported(exportRow("a", T - 60 * MIN), exportRow("c", T + MIN)));
  assert.equal(matched, 0);
  assert.equal(plays.length, 4);
});

test("plays of a replaced copy count for the kept one", () => {
  const merges = [
    { main: "b", copies: ["a"], addedAt: {} },
    { main: "c", copies: ["b"], addedAt: {} },
  ];
  assert.deepEqual(resolveMerges(live(liveRow("a", T), liveRow("x", T)), merges).map((p) => p.trackId), ["c", "x"]);
});

test("counts listens and skips per library song, and plays of other songs apart", () => {
  const plays: Play[] = [
    ...live(liveRow("a", T)),
    ...exported(exportRow("a", T + 10 * MIN, 30_000), exportRow("a", T + 20 * MIN, 29_999), exportRow("gone", T + 30 * MIN)),
  ];
  const { file, outside } = playsFile(plays, { a: {} }, new Date(T + 40 * MIN));
  assert.equal(outside, 1);
  assert.equal(file.from, iso(T));
  assert.equal(file.to, iso(T + 30 * MIN));
  assert.deepEqual([...decodePlays(file)], [["a", { plays: 2, skips: 1, last: iso(T + 20 * MIN), years: [{ year: 2026, plays: 2, skips: 1, shuffled: 0 }] }]]);
});

test("counts each year apart, with shuffled plays, for each song and the whole library", () => {
  const NEXT = Date.parse("2027-02-01T00:00:00Z");
  const plays = exported(
    { ...exportRow("a", T), shuffle: true },
    { ...exportRow("a", T + MIN, 5_000), shuffle: true },
    { ...exportRow("b", T + 2 * MIN, 5_000), shuffle: false },
    exportRow("a", NEXT),
  );
  const { file } = playsFile(plays, { a: {}, b: {} }, new Date(NEXT));
  assert.deepEqual(decodePlays(file).get("a")?.years, [
    { year: 2026, plays: 1, skips: 1, shuffled: 2 },
    { year: 2027, plays: 1, skips: 0, shuffled: 0 },
  ]);
  assert.deepEqual(decodeYearTotals(file), [
    { year: 2026, plays: 1, skips: 2, shuffled: 2, shuffledSkips: 1 },
    { year: 2027, plays: 1, skips: 0, shuffled: 0, shuffledSkips: 0 },
  ]);
});

test("a file from before the yearly counts still decodes", () => {
  const old: PlaysFile = { generatedAt: iso(T), from: null, to: null, songs: { a: [3, 1, iso(T)] } };
  assert.deepEqual(decodePlays(old).get("a"), { plays: 3, skips: 1, last: iso(T), years: [] });
  assert.deepEqual(decodeYearTotals(old), []);
});

test("a play of another release counts for the saved song", () => {
  const artists = [{ name: "Artist" }];
  const tracks = { saved: { isrc: "X", name: "Song", artists }, twin1: { isrc: "Y", name: "Twin", artists }, twin2: { isrc: "Z", name: "Twin", artists } };
  const plays = [
    ...live(liveRow("single", T)), // same ISRC
    ...exported(exportRow("album", T), exportRow("saved", T)), // same title and artist
    ...exported({ ...exportRow("twin", T), master_metadata_track_name: "Twin" }), // two saved songs share the title
    ...exported({ ...exportRow("unknown", T), master_metadata_track_name: "Other" }),
  ];
  const releases = otherReleases(plays, tracks);
  assert.deepEqual(releases, [
    { main: "saved", copies: ["single"] },
    { main: "saved", copies: ["album"] },
  ]);
  assert.deepEqual(resolveMerges(plays, releases).map((p) => p.trackId), ["saved", "saved", "saved", "twin", "unknown"]);
});
