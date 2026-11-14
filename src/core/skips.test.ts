import assert from "node:assert/strict";
import { test } from "node:test";
import {
  baselineHazard,
  chainedSkips,
  crowding,
  deviceOf,
  expectedSkips,
  liftBy,
  novelty,
  parseExportPlay,
  peaks,
  peakWindow,
  phaseOf,
  seeded,
  songCurves,
  strataLift,
} from "./skips.ts";

const T = Date.parse("2025-03-01T12:00:00Z");

/** An export row: played `ms` ms, started and ended for the given reasons. */
const row = (id: string, ms: number, reason_end = "trackdone", reason_start = "trackdone", at = T) => ({
  ts: new Date(at).toISOString(),
  ms_played: ms,
  spotify_track_uri: `spotify:track:${id}`,
  master_metadata_track_name: "Song",
  master_metadata_album_artist_name: "Artist",
  reason_start,
  reason_end,
  shuffle: true,
  platform: "Android OS 12 API 31 (samsung, SM-G991U)",
});
const play = (...args: Parameters<typeof row>) => parseExportPlay(row(...args))!;

test("parseExportPlay keeps why a play started and ended, and how it was played", () => {
  const p = play("a", 12_000, "fwdbtn", "clickrow");
  assert.equal(p.trackId, "a");
  assert.equal(p.msPlayed, 12_000);
  assert.deepEqual([p.reasonStart, p.reasonEnd, p.shuffle, p.device], ["clickrow", "fwdbtn", true, "mobile"]);
  assert.equal(parseExportPlay({ ...row("a", 1), spotify_track_uri: null }), null);
});

test("deviceOf groups Spotify's platform strings", () => {
  assert.equal(deviceOf("Partner windows_tv microsoft;xbox_one_x;…"), "tv");
  assert.equal(deviceOf("OS X 12.2.1 [arm 2]"), "desktop");
  assert.equal(deviceOf("windows"), "desktop");
  assert.equal(deviceOf("android"), "mobile");
});

test("phaseOf splits skimming, a verdict on the opening, mid-song and the tail", () => {
  const minutes3 = 180_000;
  assert.equal(phaseOf(2_000, minutes3), "instant");
  assert.equal(phaseOf(10_000, minutes3), "sampled");
  assert.equal(phaseOf(90_000, minutes3), "mid");
  assert.equal(phaseOf(170_000, minutes3), "tail");
});

test("chainedSkips counts skips that started because the previous song was skipped", () => {
  const plays = [play("a", 1_000, "fwdbtn", "clickrow", T), play("b", 1_000, "fwdbtn", "fwdbtn", T + 1), play("c", 200_000, "trackdone", "fwdbtn", T + 2)];
  assert.equal(chainedSkips(plays), 1);
});

test("songCurves counts each second a play was still going, and the second it was skipped in", () => {
  const duration = new Map([["a", 100_000]]); // mid window: 30 s to 90 s
  const curves = songCurves(
    [
      play("a", 45_500, "fwdbtn"), // skipped in second 45
      play("a", 60_000, "endplay"), // stopped: exposed, no skip
      play("a", 20_000, "fwdbtn"), // before the window
      play("a", 50_000, "fwdbtn", "appload"), // may have resumed partway: left out
      play("b", 50_000, "fwdbtn"), // not in the library
    ],
    duration,
  );
  const c = curves.get("a")!;
  assert.equal(c.from, 30);
  assert.equal(c.exposed.length, 60);
  assert.equal(c.exposed[45 - 30], 2);
  assert.equal(c.exposed[50 - 30], 1);
  assert.equal(c.exposed[60 - 30], 1);
  assert.equal(c.exposed[61 - 30], 0);
  assert.deepEqual(
    c.bails.flatMap((b, i) => (b ? [c.from + i] : [])),
    [45],
  );
  assert.equal(curves.has("b"), false);
});

test("expectedSkips spreads a song's own skip count over its seconds by exposure × baseline", () => {
  const curve = { from: 0, exposed: [10, 10, 5, 5], bails: [0, 0, 3, 0] };
  const x = expectedSkips(curve, [0.1, 0.1, 0.1, 0.1]);
  assert.deepEqual(x, [1, 1, 0.5, 0.5]);
});

test("liftBy finds the category of seconds skips crowd into, within songs", () => {
  // Two songs, flat exposure. Song a's skips all fall in its quiet seconds; song b is skipped evenly.
  const curves = new Map([
    ["a", { from: 0, exposed: [10, 10, 10, 10], bails: [0, 0, 4, 0] }],
    ["b", { from: 0, exposed: [10, 10, 10, 10], bails: [1, 1, 1, 1] }],
  ]);
  const baseline = baselineHazard(curves.values(), 0);
  const quiet = (id: string, s: number) => (id === "a" && s === 2 ? "quiet" : "loud");
  const lifts = liftBy(curves, baseline, quiet);
  assert.equal(lifts.get("quiet")!.observed, 4);
  assert.ok(lifts.get("quiet")!.lift > 1.5); // not 4: song a's own spike is half the pooled baseline at second 2
  assert.ok(lifts.get("loud")!.lift < 1);
});

test("peakWindow finds the busiest stretch of seconds", () => {
  assert.deepEqual(peakWindow([0, 1, 0, 5, 4, 0, 1], 2), { share: 9 / 11, start: 3 });
  assert.deepEqual(peakWindow([0, 0], 2), { share: 0, start: 0 });
});

test("crowding tells skips piled on one moment from skips spread like the exposure", () => {
  const exposed = Array(60).fill(20);
  const piled = { from: 30, exposed, bails: exposed.map((_, i) => (i >= 20 && i < 25 ? 4 : 0)) };
  const spread = { from: 30, exposed, bails: exposed.map((_, i) => (i % 6 === 0 ? 2 : 0)) };
  const baseline = Array(100).fill(0.01);
  const a = crowding(piled, baseline, 10, 200, seeded(1));
  const b = crowding(spread, baseline, 10, 200, seeded(1));
  assert.equal(a.peakAt, 30 + 15);
  assert.equal(a.observed, 1);
  assert.ok(a.p < 0.01);
  assert.ok(b.p > 0.2);
});

test("novelty peaks where the sound changes, and peaks keeps only the big changes", () => {
  const dim = 2;
  // 8 patches of one sound, then 8 of another.
  const patches = new Float32Array(Array.from({ length: 16 }, (_, i) => (i < 8 ? [1, 0] : [0, 1])).flat());
  const nov = novelty(patches, dim, 2);
  assert.equal(nov.indexOf(Math.max(...nov)), 8);
  assert.ok(nov[8]! > 0.9);
  assert.ok(nov[4]! < 1e-9);
  assert.deepEqual(peaks(nov), [8]);
});

test("strataLift compares a trait with plays in the same stratum, not with everything", () => {
  // Stratum "new" skips half the time, "known" never. Vocal songs are all new plays and skipped at the "new" rate.
  type P = { trackId: string; skipped: boolean; s: string };
  const plays: P[] = [
    { trackId: "v", skipped: true, s: "new" },
    { trackId: "v", skipped: false, s: "new" },
    { trackId: "i", skipped: true, s: "new" },
    { trackId: "i", skipped: false, s: "new" },
    { trackId: "i", skipped: false, s: "known" },
    { trackId: "i", skipped: false, s: "known" },
  ];
  const kind = (id: string) => (id === "v" ? "vocal" : "instrumental");
  const lifts = strataLift(plays, (p) => p.s, kind);
  assert.equal(lifts.get("vocal")!.lift, 1);
  assert.equal(lifts.get("instrumental")!.lift, 1);
  assert.equal(lifts.get("vocal")!.plays, 2);
  // Ignoring the stratum, vocal songs look twice as skippy as average.
  assert.ok(strataLift(plays, () => "all", kind).get("vocal")!.lift > 1.4);
});

