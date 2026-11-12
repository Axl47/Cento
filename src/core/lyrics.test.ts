import assert from "node:assert/strict";
import { test } from "node:test";
import { LINE_BREAK, passagesOf, searchLyrics, songVectors, type LyricIndex } from "./lyrics.ts";

const lines = (word: string, n: number) => Array.from({ length: n }, (_, i) => `${word} line number ${i} of this stanza`);

test("a repeated chorus is one passage and a short stanza joins the one before it", () => {
  const chorus = lines("chorus", 4).join("\n");
  const lyrics = [chorus, lines("verse", 4).join("\n"), chorus, "only two\nlines here"].join("\n\n");

  const got = passagesOf(lyrics);

  assert.equal(got.length, 2);
  assert.equal(got[0], lines("chorus", 4).join(LINE_BREAK));
  assert.ok(got[1]!.endsWith("only two / lines here"));
});

test("timestamps left in plain lyrics are removed", () => {
  const timed = lines("verse", 4).map((l, i) => `[00:1${i}.50] ${l}`).join("\n");

  assert.equal(passagesOf(timed)[0], lines("verse", 4).join(LINE_BREAK));
});

const index: LyricIndex = {
  keys: ["near", "near", "far", "words"],
  passages: ["close in meaning", "very close in meaning", "unrelated", "Canción: ¡la misma frase! exacta"],
  vectors: new Float32Array([0.8, 0.6, 1, 0, 0, 1, 0, 1]),
  dim: 2,
};

test("each song appears once, under its closest passage", () => {
  const hits = searchLyrics(index, new Float32Array([1, 0]), "something else", 2);

  assert.deepEqual(hits.map((h) => h.key), ["near", "far"]);
  assert.equal(hits[0]!.passage, "very close in meaning");
  assert.equal(hits[0]!.exact, false);
});

test("exact words outrank meaning, ignoring accents and punctuation", () => {
  const hits = searchLyrics(index, new Float32Array([1, 0]), "cancion la misma", 1);

  assert.deepEqual(hits.map((h) => [h.key, h.exact]), [["words", true]]);
});

test("exact words must be whole words in Latin text", () => {
  assert.equal(searchLyrics(index, new Float32Array([1, 0]), "isma fras", 4).some((h) => h.exact), false);
});

test("a song's vector is the unit-length mean of its passages", () => {
  const vectors = songVectors({ keys: ["a", "a", "b"], vectors: new Float32Array([1, 0, 0, 1, 0, 1]), dim: 2 });

  assert.deepEqual([...vectors.keys()], ["a", "b"]);
  assert.ok(Math.abs(vectors.get("a")![0]! - Math.SQRT1_2) < 1e-6 && Math.abs(vectors.get("a")![1]! - Math.SQRT1_2) < 1e-6);
  assert.deepEqual([...vectors.get("b")!], [0, 1]);
});
