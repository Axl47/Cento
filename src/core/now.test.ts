import assert from "node:assert/strict";
import { test } from "node:test";
import type { Library, Track } from "./library.ts";
import { lastHistoryPlay, latestOther, mapLibrary, nextPollMs, nowPanels, readPlayback, NOTHING_PLAYING } from "./now.ts";

const track = { id: "t", name: "Song", artists: [{ id: "a", name: "Artist" }], album: { name: "Album", imageUrl: "cover" }, isrc: "I", durationMs: 9 } satisfies Track;
const lib: Library = {
  fetchedAt: "",
  userId: "me",
  liked: [{ id: "t", addedAt: "2024-05-01T00:00:00Z" }],
  playlists: [
    { id: "p", name: "Mine", imageUrl: null, trackIds: ["t"], addedAt: { t: "2023-01-01T00:00:00Z" } },
    { id: "h", name: "Hidden", imageUrl: null, trackIds: [] },
  ],
  tracks: { t: track },
};

test("playback keeps the largest cover and survives nothing being active", () => {
  const got = readPlayback({
    is_playing: true,
    progress_ms: 5,
    device: null,
    item: { id: "x", linked_from: { id: "t" }, duration_ms: 10, name: "N", artists: [{ name: "A" }], album: { name: "B", images: [{ url: "small", width: 64 }, { url: "big", width: 640 }] } },
  });

  assert.equal(got.trackId, "t");
  assert.equal(got.current?.imageUrl, "big");
  assert.equal(readPlayback(undefined), NOTHING_PLAYING);
});

test("panels use the earliest add date, and songs outside the library have none", () => {
  const got = nowPanels(lib, null, undefined, null, "t");

  assert.equal(got?.added, "2023-01-01T00:00:00Z");
  assert.deepEqual(got?.playlists, [{ id: "p", name: "Mine" }]);
  assert.equal(nowPanels(lib, null, undefined, null, "other"), null);
});

test("the next check is timed to the song's end, and rare when paused", () => {
  const playing = { ...NOTHING_PLAYING, trackId: "t", paused: false, duration: 100_000 };

  assert.equal(nextPollMs({ ...playing, position: 97_000 }), 3_800);
  assert.equal(nextPollMs({ ...playing, position: 0 }), 15_000);
  assert.equal(nextPollMs({ ...playing, paused: true }), 60_000);
});

test("the map's library leaves out hidden playlists and private details", () => {
  const got = mapLibrary(lib, ["h"]);

  assert.deepEqual(got.playlists.map((p) => p.id), ["p"]);
  assert.equal(got.playlists[0]!.addedAt, undefined);
  assert.deepEqual(got.liked, []);
  assert.equal(got.tracks.t!.isrc, null);
});

test("the previous song is the latest one that isn't playing now", () => {
  const a = { trackId: "a", label: "A", at: 1 };
  const b = { trackId: "b", label: "B", at: 2 };
  assert.equal(latestOther("c", [a, b]), b);
  assert.equal(latestOther("b", [a, b, null]), a, "the song playing again isn't its own previous");
  assert.equal(latestOther("a", [a, null]), null);
});

test("the last recorded play, under the id Spotify reports while it plays", () => {
  const row = (id: string, at: string) => JSON.stringify({ played_at: at, track: { id, linked_from: { id: "orig" }, name: "Song", artists: [{ name: "X" }, { name: "Y" }] } });
  const text = `${row("x", "2026-11-22T10:00:00Z")}\n${row("y", "2026-11-22T10:04:00Z")}\n`;
  assert.deepEqual(lastHistoryPlay(text), { trackId: "orig", label: "X, Y - Song", at: Date.parse("2026-11-22T10:04:00Z") });
  assert.equal(lastHistoryPlay(""), null);
  assert.equal(lastHistoryPlay("{half a ro"), null);
});
