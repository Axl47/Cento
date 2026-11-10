import assert from "node:assert/strict";
import { appendFile, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, test } from "node:test";
import { createClient } from "../core/spotify.ts";
import { createRecorder } from "./history.ts";

// Everything here runs on a stub client and temp files. It never sees the host's login or the storage box.

const PLAYLIST = { type: "playlist", href: "https://api.spotify.com/v1/playlists/abc", external_urls: { spotify: "https://open.spotify.com/playlist/abc" }, uri: "spotify:playlist:abc" };

/** A PlayHistoryObject as Spotify documents it, trimmed to a few of the track's fields. */
const play = (minute: number, context: unknown = PLAYLIST, id = `track${minute}`) => ({
  track: { album: { name: "Album" }, artists: [{ name: "Artist" }], duration_ms: 200_000, id, is_local: false, name: `Song ${minute}`, type: "track", uri: `spotify:track:${id}` },
  played_at: new Date(Date.UTC(2026, 10, 10, 12, minute)).toISOString(),
  context,
});

/** Spotify's response: newest first, and all of `plays` when the cursor is older than them. */
const page = (plays: unknown[]) =>
  new Response(JSON.stringify({ items: plays, next: null, cursors: plays.length ? { after: "1", before: "0" } : null, limit: 50, href: "https://api.spotify.com/v1/me/player/recently-played" }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

const newestFirst = <T extends { played_at: string }>(plays: T[]) => [...plays].sort((a, b) => b.played_at.localeCompare(a.played_at));

let urls: string[];
let dir: string;
let file: string;
let gapsFile: string;
let backups: number;

const respondWith = (next: () => Response) => {
  globalThis.fetch = (async (url: string) => {
    urls.push(url);
    return next();
  }) as typeof fetch;
};
const serve = (plays: unknown[]) => respondWith(() => page(plays));

const recorder = (backup = async () => void backups++) => createRecorder(createClient(async () => "token"), { file, gapsFile, backup });
const rows = async () => (await readFile(file, "utf8")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as ReturnType<typeof play>);

beforeEach(async () => {
  urls = [];
  backups = 0;
  dir = await mkdtemp(join(tmpdir(), "cento-history-"));
  file = join(dir, "history.jsonl");
  gapsFile = join(dir, "gaps.jsonl");
});

test("writes each play raw and oldest first, keeping its context even when null", async () => {
  const noContext = play(1, null);
  serve([play(2), noContext]);
  await recorder().poll();
  assert.deepEqual(await rows(), [noContext, play(2)]);
  assert.match(urls[0]!, /\/me\/player\/recently-played\?limit=50$/);
});

test("repeat polls and restarts neither duplicate nor drop plays, and the cursor advances", async () => {
  serve([play(2), play(1)]);
  const first = recorder();
  await first.poll();
  await first.poll();
  assert.equal((await rows()).length, 2, "a repeat poll adds nothing");

  serve([play(4), play(3), play(2), play(1)]); // two more were played while the host was down
  const restarted = recorder();
  await restarted.poll();
  assert.deepEqual((await rows()).map((r) => r.track.id), ["track1", "track2", "track3", "track4"]);
  const lastRecorded = Date.parse(play(2).played_at);
  assert.equal(new URL(urls.at(-1)!).searchParams.get("after"), String(lastRecorded - 24 * 60 * 60_000));
  assert.equal(restarted.status.plays, 4);
});

test("the same track played twice is two plays", async () => {
  serve([play(2, PLAYLIST, "same"), play(1, PLAYLIST, "same")]);
  await recorder().poll();
  assert.equal((await rows()).length, 2);
});

test("a play reported late, older than the cursor, is still recorded", async () => {
  serve([play(5)]);
  await recorder().poll();
  serve([play(5), play(3)]);
  await recorder().poll();
  assert.deepEqual((await rows()).map((r) => r.track.id), ["track5", "track3"]);
});

test("a full window of plays all newer than the cursor logs a gap", async () => {
  serve([play(0)]);
  await recorder().poll();
  const window = newestFirst(Array.from({ length: 50 }, (_, i) => play(i + 1)));
  serve(window);
  await recorder().poll();

  assert.equal((await rows()).length, 51);
  const gaps = (await readFile(gapsFile, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as { last_recorded: string; oldest_returned: string });
  assert.equal(gaps.length, 1);
  assert.equal(gaps[0]!.last_recorded, play(0).played_at);
  assert.equal(gaps[0]!.oldest_returned, play(1).played_at);
});

test("no gap on the first poll, or when the window reaches back to what's recorded", async () => {
  const window = newestFirst(Array.from({ length: 50 }, (_, i) => play(i)));
  serve(window);
  await recorder().poll();
  assert.equal(await readFile(gapsFile, "utf8"), "", "nothing to compare against on the first poll");

  serve(newestFirst(Array.from({ length: 50 }, (_, i) => play(i + 1))));
  await recorder().poll();
  assert.equal(await readFile(gapsFile, "utf8"), "", "play 49 was already recorded, so nothing was skipped");
});

test("a missing scope is named, keeps retrying, and recording starts once it's granted", async () => {
  const log = console.error;
  const logged: string[] = [];
  console.error = (line: string) => void logged.push(line);
  try {
    respondWith(() => new Response(JSON.stringify({ error: { status: 403, message: "Insufficient client scope" } }), { status: 403 }));
    const history = recorder();
    await history.poll();
    await history.poll();
    assert.match(history.status.error ?? "", /user-read-recently-played/);
    assert.equal(urls.length, 2, "it kept trying");
    assert.equal(logged.length, 1, "and said so once");

    serve([play(1)]);
    await history.poll();
    assert.equal(history.status.error, null);
    assert.equal((await rows()).length, 1);
  } finally {
    console.error = log;
  }
});

test("the loop keeps polling after a failure, with no screen involved", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const log = console.error;
  console.error = () => {};
  try {
    respondWith(() => new Response(JSON.stringify({ error: { status: 403, message: "Insufficient client scope" } }), { status: 403 }));
    recorder().start();
    for (let i = 0; i < 10_000 && urls.length < 3; i++) {
      await new Promise((resolve) => setImmediate(resolve));
      t.mock.timers.tick(5 * 60_000);
    }
    assert.equal(urls.length, 3);
  } finally {
    console.error = log;
  }
});

test("respects the client's rate-limit block, sending nothing while it lasts", async () => {
  respondWith(() => new Response("quota", { status: 429, headers: { "retry-after": "29506" } }));
  const history = recorder();
  await history.poll();
  assert.equal(urls.length, 1);
  await history.poll();
  assert.equal(urls.length, 1, "the second poll never reached Spotify");
  assert.match(history.status.error ?? "", /rate limit/);
});

test("a row torn by a crash is recovered and doesn't damage the next one", async () => {
  await writeFile(file, `${JSON.stringify(play(1))}\n${JSON.stringify(play(2)).slice(0, 40)}`);
  const warn = console.warn;
  console.warn = () => {};
  try {
    serve([play(3), play(2), play(1)]);
    await recorder().poll();
  } finally {
    console.warn = warn;
  }
  const lines = (await readFile(file, "utf8")).trim().split("\n");
  assert.equal(lines.length, 4, "the torn line stays, on its own");
  assert.deepEqual(lines.slice(2).map((line) => (JSON.parse(line) as ReturnType<typeof play>).track.id), ["track2", "track3"]);
});

test("a write that fails halfway is repaired before the play is written again", async () => {
  let failNext = true;
  const history = createRecorder(createClient(async () => "token"), {
    file,
    gapsFile,
    backup: async () => {},
    append: async (path, data) => {
      if (failNext) {
        failNext = false;
        await appendFile(path, String(data).slice(0, 20));
        throw new Error("ENOSPC: no space left on device");
      }
      await appendFile(path, data);
    },
  });
  const log = console.error;
  const warn = console.warn;
  console.error = console.warn = () => {};
  try {
    serve([play(1)]);
    await history.poll();
    assert.match(history.status.error ?? "", /ENOSPC/);
    await history.poll();
  } finally {
    console.error = log;
    console.warn = warn;
  }
  assert.equal(history.status.error, null);
  assert.equal(history.status.plays, 1);
  const lines = (await readFile(file, "utf8")).trim().split("\n");
  assert.deepEqual(JSON.parse(lines.at(-1)!), play(1));
});

test("backs up after new plays, and a failed backup is reported without stopping recording", async () => {
  serve([play(1)]);
  const history = recorder();
  await history.poll();
  assert.equal(backups, 1);
  await history.poll();
  assert.equal(backups, 1, "nothing new to back up");

  const log = console.error;
  console.error = () => {};
  try {
    serve([play(2), play(1)]);
    const failing = recorder(async () => {
      throw new Error("box unreachable");
    });
    await failing.poll();
    assert.equal(failing.status.backupError, "box unreachable");
    assert.equal(failing.status.error, null);
    assert.equal((await rows()).length, 2);
  } finally {
    console.error = log;
  }
});

test("no backup before anything has been recorded", async () => {
  serve([]);
  await recorder().poll();
  assert.equal(backups, 0);
});
