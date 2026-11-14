// Three lists of saved songs worth another look, from play history (data/plays.json, see plays.ts): favorites gone
// quiet, songs skipped more and more, and songs never played at all.
import type { Library } from "./library.ts";
import type { SongPlays, YearPlays, YearTotals } from "./plays.ts";

const YEAR_MS = 365.25 * 24 * 3600_000;

export type Rediscovery = { id: string; plays: number; skips: number; last: string; peak: YearPlays };

/**
 * Songs played at least `minPlays` times, none in the last `quietYears` (counting skips: a song you skip when it
 * comes up isn't forgotten). Most loved first: listens, times the share of plays that weren't skips, so a song
 * heard 60 times and skipped 40 ranks below one heard 50 times and skipped twice.
 */
export function rediscover(
  plays: ReadonlyMap<string, SongPlays>,
  saved: ReadonlySet<string>,
  now: Date,
  { minPlays = 30, quietYears = 1 } = {},
): Rediscovery[] {
  const cutoff = now.getTime() - quietYears * YEAR_MS;
  const loved = (p: SongPlays) => (p.plays * p.plays) / (p.plays + p.skips);
  return [...plays]
    .filter(([id, p]) => saved.has(id) && p.plays >= minPlays && Date.parse(p.last) < cutoff)
    .toSorted(([, a], [, b]) => loved(b) - loved(a))
    .map(([id, p]) => ({ id, plays: p.plays, skips: p.skips, last: p.last, peak: p.years.reduce((a, b) => (b.plays > a.plays ? b : a)) }));
}

/** A stretch of a song's plays: listens and skips, the skips the library's rate predicts, and the shrunk ratio of the two. */
export type Stretch = { plays: number; skips: number; expected: number; ratio: number };

export type Fade = { id: string; then: Stretch; now: Stretch; years: readonly YearPlays[] };

/**
 * How many skips' worth of evidence a stretch needs before its own ratio outweighs the song's overall one, and the
 * song's overall ratio the library's (1). Most songs have a few dozen plays a year, so without this a handful of
 * skips would swing the ratio wildly.
 */
const PRIOR_SKIPS = 5;

/**
 * Songs skipped more and more: their skip rate in the last two calendar years (`now`) against every year before
 * (`then`), each relative to what the library's skip rate those years, with shuffle on or off, predicts. Skipping
 * swings a lot year to year (from 15% to 43% of all plays) and is different on shuffle, so a song is only fading if
 * it climbed more than everything else. Each stretch's ratio is shrunk toward the song's overall ratio, and that
 * toward the library's; songs need `minThen` and `minNow` plays (listens and skips) in each stretch. Returns songs
 * whose ratio rose by at least `minRise` times and that are skipped more than the library now, the biggest rise first.
 */
export function fading(
  plays: ReadonlyMap<string, SongPlays>,
  totals: readonly YearTotals[],
  saved: ReadonlySet<string>,
  now: Date,
  { minThen = 15, minNow = 10, minRise = 1.5 } = {},
): Fade[] {
  // Per year, the share of plays skipped with shuffle off and on.
  const rates = new Map(
    totals.map((t) => {
      const [played, shuffled] = [t.plays + t.skips - t.shuffled, t.shuffled];
      return [t.year, { off: played ? (t.skips - t.shuffledSkips) / played : 0, on: shuffled ? t.shuffledSkips / shuffled : 0 }] as const;
    }),
  );
  const expected = (y: YearPlays) => {
    const r = rates.get(y.year) ?? { off: 0, on: 0 };
    return (y.plays + y.skips - y.shuffled) * r.off + y.shuffled * r.on;
  };
  const recentFrom = now.getUTCFullYear() - 1;
  const sum = (years: readonly YearPlays[]) =>
    years.reduce((s, y) => ({ plays: s.plays + y.plays, skips: s.skips + y.skips, expected: s.expected + expected(y) }), { plays: 0, skips: 0, expected: 0 });

  const fades: Fade[] = [];
  for (const [id, p] of plays) {
    if (!saved.has(id)) continue;
    const [early, late] = [sum(p.years.filter((y) => y.year < recentFrom)), sum(p.years.filter((y) => y.year >= recentFrom))];
    if (early.plays + early.skips < minThen || late.plays + late.skips < minNow) continue;
    const overall = (early.skips + late.skips + PRIOR_SKIPS) / (early.expected + late.expected + PRIOR_SKIPS);
    const shrink = (s: typeof early): Stretch => ({ ...s, ratio: (s.skips + PRIOR_SKIPS * overall) / (s.expected + PRIOR_SKIPS) });
    const [then, recent] = [shrink(early), shrink(late)];
    if (recent.ratio > 1 && recent.ratio >= minRise * then.ratio) fades.push({ id, then, now: recent, years: p.years });
  }
  return fades.toSorted((a, b) => b.now.ratio / b.then.ratio - a.now.ratio / a.then.ratio);
}

export type Unplayed = { id: string; skips: number; addedAt: string | null; playlists: string[] };

/**
 * Saved songs never listened to (plays of other releases already count, see `otherReleases`), though maybe skipped,
 * longest saved first. `addedAt` is the earliest the song was liked or added to a playlist; `playlists` are the ids
 * of every playlist holding it.
 */
export function neverPlayed(plays: ReadonlyMap<string, SongPlays>, lib: Pick<Library, "tracks" | "liked" | "playlists">): Unplayed[] {
  const found = new Map<string, Unplayed>();
  for (const id of Object.keys(lib.tracks)) {
    const p = plays.get(id);
    if (!p?.plays) found.set(id, { id, skips: p?.skips ?? 0, addedAt: null, playlists: [] });
  }
  const arrived = (id: string, at: string | undefined) => {
    const song = found.get(id);
    if (song && at && (!song.addedAt || at < song.addedAt)) song.addedAt = at;
    return song;
  };
  for (const { id, addedAt } of lib.liked) arrived(id, addedAt);
  for (const p of lib.playlists) for (const id of p.trackIds) arrived(id, p.addedAt?.[id])?.playlists.push(p.id);
  return [...found.values()].toSorted((a, b) => (a.addedAt ?? "\uffff").localeCompare(b.addedAt ?? "\uffff"));
}
