import assert from "node:assert/strict";
import { test } from "node:test";
import { parseLanguages, playlistLanguages } from "./languages.ts";
import type { Library, Track } from "./library.ts";

const track = (id: string, isrc: string | null): Track => ({ id, name: id, artists: [], album: { name: "", imageUrl: null }, isrc, durationMs: 1 });
const lib = { tracks: { a: track("a", "ISRC-A"), b: track("b", null), c: track("c", "ISRC-C"), d: track("d", "ISRC-D") } } as unknown as Library;

test("shares count each song once, by ISRC or track id, among songs with a known language", () => {
  const languages = parseLanguages('{"key":"ISRC-A","language":"es"}\n{"key":"b","language":"es"}\n{"key":"ISRC-C","language":"en"}\n');
  const { detected, shares } = playlistLanguages(languages, lib, { trackIds: ["a", "a", "b", "c", "d"] });
  assert.equal(detected, 3);
  assert.deepEqual(shares.map((s) => [s.name, s.songs]), [["Spanish", 2], ["English", 1]]);
  assert.equal(shares[0]!.share, 2 / 3);
});
