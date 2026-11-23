import assert from "node:assert/strict";
import { test } from "node:test";
import type { Track } from "./library.ts";
import { NOTHING_PLAYING, type Playback } from "./now.ts";
import { isListen, type Play, type SongPlays } from "./plays.ts";
import { isSegueNow, parseSegue, pickSource, segueContext, segueTime, type SegueNow } from "./segue.ts";

const track = (id: string, isrc: string | null): Track => ({ id, name: id, artists: [{ id: "a", name: "A" }], album: { name: "", imageUrl: null }, isrc, durationMs: 1 });
const ids = new Map([["USAAA0000001", "t1"]]);

const play = (heard: number, ended: string, key = "usaaa0000001") => ({
  type: "play",
  event_id: "e",
  at: "2026-11-20T10:00:00-04:00",
  started: "2026-11-20T09:57:00-04:00",
  key,
  label: "A - t1",
  heard,
  ended,
  via: null,
  seed: "s",
});

test("times without an offset are Puerto Rico local time", () => {
  assert.equal(segueTime("2026-11-20T10:00:00"), Date.parse("2026-11-20T14:00:00Z"));
  assert.equal(segueTime("2026-11-20T10:00:00-04:00"), Date.parse("2026-11-20T14:00:00Z"));
  assert.equal(segueTime("2026-11-20T14:00:00Z"), Date.parse("2026-11-20T14:00:00Z"));
});

test("Segue plays count from 30 s, and shorter ones are skips only when skipped or replaced by a new radio", () => {
  const listen = parseSegue(play(31, "next"), ids);
  assert.deepEqual(listen, { trackId: "t1", at: Date.parse("2026-11-20T14:00:00Z"), msPlayed: 31_000, isrc: "USAAA0000001", source: "segue", skipped: false });
  assert.ok(isListen(listen!));

  for (const ended of ["skip", "radio"]) {
    const skip = parseSegue(play(12, ended), ids);
    assert.equal(skip?.skipped, true);
    assert.ok(!isListen(skip!));
  }
  assert.equal(parseSegue(play(12, "quit"), ids), null, "quitting early is neither");
  assert.equal(parseSegue(play(40, "skip"), ids)?.skipped, false, "skipped after 30 s still counts as a listen");
  assert.equal(parseSegue(play(40, "next", "OTHER"), ids), null, "not in the library");
  assert.equal(parseSegue({ type: "mark", event_id: "m" }, ids), null);
});

const spotify = (paused: boolean): Playback => ({ ...NOTHING_PLAYING, trackId: "s", paused, current: { name: "S", artists: [], album: "", imageUrl: null } });
const segue = (playing: boolean, key: string | null = "USAAA0000001"): SegueNow => ({
  playing,
  key,
  label: "A - t1",
  position_ms: 0,
  duration_ms: 1,
  next: null,
  vocals: 0,
  backing: 0,
  mashup: false,
  markable: false,
});

test("Now Playing shows a playing source over a paused one, and Spotify when both are the same", () => {
  assert.equal(pickSource(spotify(false), segue(true)), "spotify");
  assert.equal(pickSource(spotify(true), segue(true)), "segue");
  assert.equal(pickSource(spotify(true), segue(false)), "spotify");
  assert.equal(pickSource(NOTHING_PLAYING, segue(false)), "segue");
  assert.equal(pickSource(NOTHING_PLAYING, segue(true, null)), null, "nothing loaded");
  assert.equal(pickSource(NOTHING_PLAYING, null), null);
});

test("a now report needs its fields, and may carry more", () => {
  assert.ok(isSegueNow({ ...segue(true), next: { key: "K", label: "L", kind: "mash", in_ms: -200 }, extra: 1 }));
  assert.ok(!isSegueNow({ ...segue(true), position_ms: "0" }));
  assert.ok(!isSegueNow({ ...segue(true), next: { key: "K" } }));
  assert.ok(isSegueNow({ ...segue(true), previous: null }));
  assert.ok(isSegueNow({ ...segue(true), previous: { key: "K", label: "A - B" } }));
  assert.ok(!isSegueNow({ ...segue(true), previous: { key: "K" } }));
});

test("context: songs heard in the last day, quiet favorites and skip rates, by ISRC", () => {
  const now = new Date("2026-11-22T12:00:00Z");
  const tracks = { t1: track("t1", "I1"), t2: track("t2", "I2"), t3: track("t3", null), t4: track("t4", "I4") };
  const songs = (plays: number, skips: number, last: string): SongPlays => ({ plays, skips, last, years: [{ year: 2020, plays, skips, shuffled: 0 }] });
  const plays = new Map([
    ["t1", songs(40, 10, "2020-06-01T00:00:00Z")], // a quiet favorite, skipped a fifth of the time
    ["t2", songs(2, 1, "2026-11-21T00:00:00Z")], // too few plays for a rate
    ["t3", songs(50, 0, "2020-01-01T00:00:00Z")], // no ISRC
  ]);
  const heard: Play[] = [
    { trackId: "t2", at: now.getTime() - 3600_000, source: "live" },
    { trackId: "t4", at: now.getTime() - 3600_000, msPlayed: 5_000, source: "segue" }, // a skip isn't a listen
    { trackId: "t1", at: now.getTime() - 25 * 3600_000, source: "live" }, // over a day ago
    { trackId: "gone", isrc: "I9", at: now.getTime() - 60_000, source: "live" }, // another release, known by its own ISRC
  ];

  assert.deepEqual(segueContext(plays, tracks, heard, now), { recent: ["I2", "I9"], rediscover: ["I1"], skip_rate: { I1: 0.2 } });
});
