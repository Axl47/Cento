import assert from "node:assert/strict";
import { test } from "node:test";
import { decodePlays, joinPlays, parseExport, parseLive, playsFile, resolveMerges, type Play } from "./plays.ts";

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
const exportRow = (id: string | null, ts: number, ms_played = 3 * MIN) => ({
  ts: iso(ts),
  ms_played,
  spotify_track_uri: id && `spotify:track:${id}`,
  master_metadata_track_name: "Song",
  reason_start: "trackdone",
  reason_end: "trackdone",
  skipped: false,
});

const live = (...rows: ReturnType<typeof liveRow>[]) => rows.map(parseLive).filter((p) => p !== null);
const exported = (...rows: ReturnType<typeof exportRow>[]) => rows.map(parseExport).filter((p) => p !== null);

test("parses both formats, and drops rows that aren't track plays", () => {
  assert.deepEqual(parseLive(liveRow("a", T, "spotify:playlist:p")), { trackId: "a", at: T, durationMs: 3 * MIN, context: "spotify:playlist:p", source: "live" });
  assert.deepEqual(parseLive(liveRow("a", T)), { trackId: "a", at: T, durationMs: 3 * MIN, source: "live" });
  assert.equal(parseLive({ ...liveRow("a", T), track: { id: null } }), null); // local file
  assert.deepEqual(parseExport(exportRow("a", T, 12_000)), { trackId: "a", at: T, msPlayed: 12_000, skipped: false, source: "export" });
  assert.equal(parseExport(exportRow(null, T)), null); // podcast
  assert.equal(parseExport({ ...exportRow(null, T), spotify_track_uri: "spotify:episode:e" }), null);
});

test("a play in both sources counts once, with the export's numbers and the live context", () => {
  // played_at could be the start or the end of the play; both line up.
  for (const playedAt of [T - 3 * MIN, T]) {
    const { plays, matched } = joinPlays(live(liveRow("a", playedAt, "spotify:playlist:p")), exported(exportRow("a", T + 4_000, 170_000)));
    assert.equal(matched, 1);
    assert.deepEqual(plays, [{ trackId: "a", at: T + 4_000, msPlayed: 170_000, skipped: false, context: "spotify:playlist:p", source: "both" }]);
  }
});

test("a song on repeat pairs each play with its own row", () => {
  const { plays, matched } = joinPlays(
    live(liveRow("a", T), liveRow("a", T + 3 * MIN), liveRow("a", T + 6 * MIN)),
    exported(exportRow("a", T + 3 * MIN), exportRow("a", T + 6 * MIN), exportRow("a", T + 9 * MIN)),
  );
  assert.equal(matched, 3);
  assert.deepEqual(plays.map((p) => p.at), [T + 3 * MIN, T + 6 * MIN, T + 9 * MIN]);
});

test("a skip right before a play doesn't take the play's export row", () => {
  // Restarted after 5 s: the skip's row ends where the real play starts, both inside the live play's window.
  const { plays, matched } = joinPlays(live(liveRow("a", T)), exported(exportRow("a", T, 5_000), exportRow("a", T + 3 * MIN)));
  assert.equal(matched, 1);
  assert.deepEqual(plays.map((p) => [p.source, p.msPlayed]), [["export", 5_000], ["both", 3 * MIN]]);
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
  assert.deepEqual([...decodePlays(file)], [["a", { plays: 2, skips: 1, last: iso(T + 20 * MIN) }]]);
});
