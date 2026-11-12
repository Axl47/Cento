import assert from "node:assert/strict";
import { test } from "node:test";
import { createClient, parseSpotifyLinks, SpotifyBlockedError } from "./spotify.ts";

test("a 429 pauses every request until Retry-After, then they go through", async () => {
  const calls: number[] = [];
  let limitedOnce = false;
  globalThis.fetch = (async () => {
    calls.push(Date.now());
    if (!limitedOnce) {
      limitedOnce = true;
      return new Response("slow down", { status: 429, headers: { "retry-after": "1" } });
    }
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;

  const client = createClient(async () => "token");
  const first = client.get("/me/player");
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(client.limited("/me/player"), true);
  // A request started during the pause waits for it instead of hitting Spotify right away.
  const second = client.get("/me/player/devices");
  await Promise.all([first, second]);

  assert.equal(calls.length, 3);
  assert.ok(calls[1]! - calls[0]! >= 950 && calls[2]! - calls[0]! >= 950, "both retried after the pause");
  assert.equal(client.limited("/me/player"), false);
});

test("a long Retry-After fails fast with when the block ends, and later requests fail too", async () => {
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    return new Response("quota", { status: 429, headers: { "retry-after": "29506" } });
  }) as typeof fetch;

  const client = createClient(async () => "token");
  const before = Date.now();
  await assert.rejects(client.get("/me/player"), (e) => e instanceof SpotifyBlockedError && e.until >= before + 29_506_000);
  await assert.rejects(client.get("/me/player/devices"), SpotifyBlockedError);
  assert.equal(calls, 1, "the second request never reached Spotify");
});

test("a player block leaves the rest of the API working", async () => {
  globalThis.fetch = (async (url: string) =>
    url.includes("/me/player")
      ? new Response("quota", { status: 429, headers: { "retry-after": "29506" } })
      : new Response("{}", { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch;

  const client = createClient(async () => "token");
  await assert.rejects(client.get("/me/player"), SpotifyBlockedError);
  assert.equal(client.limited("/me/player/devices"), true);
  assert.equal(client.limited("/me/playlists"), false);
  assert.deepEqual(await client.get("/me/playlists"), {});
});

test("pasted links and URIs are read in order, whatever surrounds them", () => {
  const text = `https://open.spotify.com/intl-es/track/4uLU6hMCjMI75M1A2tKUQC?si=abc
spotify:album:1DFixLWuPkv3KT3TnV35m3, https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M and https://example.com/track/x`;

  assert.deepEqual(parseSpotifyLinks(text), [
    { kind: "track", id: "4uLU6hMCjMI75M1A2tKUQC" },
    { kind: "album", id: "1DFixLWuPkv3KT3TnV35m3" },
    { kind: "playlist", id: "37i9dQZF1DXcBWIGoYBM5M" },
  ]);
});
