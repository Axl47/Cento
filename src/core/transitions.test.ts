import assert from "node:assert/strict";
import { test } from "node:test";
import { parseShufflePlay, shuffleSeams, withinSong, type ShufflePlay } from "./transitions.ts";

const T = Date.parse("2026-01-01T20:00:00Z");
const MIN = 60_000;

/** Plays one after another with no gap: each starts when the one before ended. */
function session(...specs: [id: string, ms: number, start: string, end: string, shuffle?: boolean][]): ShufflePlay[] {
  let at = T;
  return specs.map(([id, ms, start, end, shuffle = true]) => {
    at += ms;
    return { trackId: id, at, msPlayed: ms, shuffle, reasonStart: start, reasonEnd: end, platform: "osx", source: "export" };
  });
}

test("parseShufflePlay keeps how a play started and ended", () => {
  const row = { ts: "2026-01-01T20:03:00Z", ms_played: 5000, spotify_track_uri: "spotify:track:a", shuffle: true, reason_start: "trackdone", reason_end: "fwdbtn", platform: "osx" };
  assert.deepEqual(
    { ...parseShufflePlay(row), at: undefined },
    { trackId: "a", at: undefined, msPlayed: 5000, shuffle: true, reasonStart: "trackdone", reasonEnd: "fwdbtn", platform: "osx", source: "export" },
  );
  assert.equal(parseShufflePlay({ ...row, spotify_track_uri: null }), null);
});

test("shuffleSeams keeps songs that came up on their own, after a listen or a skip", () => {
  const seams = shuffleSeams(
    session(
      ["a", 3 * MIN, "clickrow", "trackdone"],
      ["b", 5_000, "trackdone", "fwdbtn"], // came up after a listen, skipped
      ["c", 3 * MIN, "fwdbtn", "trackdone"], // came up after a skip, listened to
      ["d", 10_000, "trackdone", "endplay"], // playback stopped: neither skipped nor heard
    ),
  );
  assert.deepEqual(
    seams.map(({ from, to, skipped, afterSkip }) => ({ from, to, skipped, afterSkip })),
    [
      { from: "a", to: "b", skipped: true, afterSkip: false },
      { from: "b", to: "c", skipped: false, afterSkip: true },
    ],
  );
  assert.deepEqual(seams[1]!.recent, ["a"], "a skipped song isn't part of what the session sounded like");
});

test("shuffleSeams leaves out songs the user picked, plays off shuffle, and seams across a pause", () => {
  const picked = session(["a", 3 * MIN, "clickrow", "trackdone"], ["b", 3 * MIN, "clickrow", "trackdone"]);
  const ordered = session(["a", 3 * MIN, "clickrow", "trackdone", false], ["b", 3 * MIN, "trackdone", "trackdone", false]);
  const paused = session(["a", 3 * MIN, "clickrow", "trackdone"], ["b", 3 * MIN, "trackdone", "trackdone"]);
  paused[1]!.at += 40 * MIN;
  assert.deepEqual([shuffleSeams(picked), shuffleSeams(ordered), shuffleSeams(paused)], [[], [], []]);
});

test("withinSong compares each song with itself, so a song skipped more often doesn't count as distance", () => {
  // "often" is skipped every time and always comes after distant songs; "rarely" never is and always after close ones.
  // Pooled, distance would look like it causes skips. Within each song distance changes nothing.
  const seams = [
    ...[0.7, 0.8, 0.9].map((d) => ({ to: "often", skipped: true, d })),
    ...[0.1, 0.2, 0.3].map((d) => ({ to: "rarely", skipped: false, d })),
  ];
  const { close, far, songs } = withinSong(seams, (s) => s.d, 3);
  assert.equal(songs, 2);
  assert.equal(close.skips / close.n, far.skips / far.n);
  assert.equal(withinSong(seams, (s) => s.d, 4).songs, 0, "songs with too few seams are left out");
});
