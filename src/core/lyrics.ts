// Lyric search over an index of passages: a few lines of a song each, with one meaning vector per passage.
// Pure code, shared by the indexing script, the dev server and their tests.

export type LyricIndex = {
  /** Song per passage: its ISRC, or the track id if it has none. */
  keys: string[];
  passages: string[];
  /** One unit-length vector per passage, `dim` numbers each, end to end. */
  vectors: Float32Array;
  dim: number;
};

export type LyricHit = { key: string; passage: string; score: number; exact: boolean };

export const LINE_BREAK = " / ";
const MIN_LINES = 4;
const MAX_LINES = 8;
const MIN_CHARS = 60;
/** Synced-lyric times, which a few "plain" lyrics still carry. */
const TIMESTAMP = /^\s*(\[\d+:\d+(\.\d+)?\]\s*)+/;

/**
 * Cuts lyrics into passages, each distinct line once so a chorus isn't indexed over and over. Stanzas of at
 * least four lines stay whole. Shorter ones are merged, because a lone short line matches almost any search.
 */
export function passagesOf(lyrics: string): string[] {
  const seen = new Set<string>();
  const done: string[][] = [];
  let current: string[] = [];
  for (const raw of lyrics.split("\n")) {
    const line = raw.replace(TIMESTAMP, "").trim();
    if ((!line && current.length >= MIN_LINES) || current.length === MAX_LINES) {
      done.push(current);
      current = [];
    }
    if (line && !seen.has(line.toLowerCase())) {
      seen.add(line.toLowerCase());
      current.push(line);
    }
  }
  if (current.length >= MIN_LINES || !done.length) done.push(current);
  else done[done.length - 1]!.push(...current);
  return done.map((lines) => lines.join(LINE_BREAK)).filter((p) => p.length >= MIN_CHARS);
}

/** Lowercase, without Latin accents or punctuation, so a half-remembered line still matches its text. */
const plainText = (s: string) =>
  s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

/** Whether the words of `query` appear in order in the passage. Scripts written without spaces match anywhere. */
function hasPhrase(passage: string, query: string) {
  if (query.length < 3) return false;
  return /^[\p{Script=Latin}\p{N} ]+$/u.test(query) ? ` ${passage} `.includes(` ${query} `) : passage.includes(query);
}

/** The best passage of each of the top `limit` songs. Songs that contain the query's exact words come first. */
export function searchLyrics(index: LyricIndex, queryVector: Float32Array, query: string, limit: number): LyricHit[] {
  const phrase = plainText(query);
  const best = new Map<string, LyricHit>();
  index.passages.forEach((passage, row) => {
    let score = 0;
    for (let d = 0; d < index.dim; d++) score += index.vectors[row * index.dim + d]! * queryVector[d]!;
    const exact = hasPhrase(plainText(passage), phrase);
    const key = index.keys[row]!;
    const seen = best.get(key);
    const beats = !seen || (exact && !seen.exact) || (exact === seen.exact && score > seen.score);
    if (beats) best.set(key, { key, passage, score, exact });
  });
  return [...best.values()].sort((a, b) => Number(b.exact) - Number(a.exact) || b.score - a.score).slice(0, limit);
}
