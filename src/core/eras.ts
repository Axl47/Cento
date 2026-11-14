// Musical eras: stretches of months where what was listened to (its sound and its lyric themes) held steady,
// found by splitting the play history where that mix shifted, and described by their artists, themes and songs.
// Pure code: `pnpm eras` feeds it the joined plays (src/core/plays.ts) and writes data/eras.json for the app.

/** One listen (30 s or more, see `isListen`), already credited to the saved song when it was another release. */
export type Listen = { trackId: string; at: number; ms: number };

/** Names for the dimensions `SongTraits` arrays are parallel to. */
export type Space = { genres: readonly string[]; moods: readonly string[]; themes: readonly string[] };

/** What's known about a song. Only library songs have any of it; played-but-unsaved songs have none. */
export type SongTraits = {
  /** Probability per genre, parallel to `Space.genres`. */
  genres?: readonly number[];
  moods?: readonly number[];
  /** Theme scores (standard deviations within the song's language), parallel to `Space.themes`. */
  themes?: readonly number[];
  language?: string;
};

export type SongName = { name: string; artist: string; saved: boolean };

/**
 * The listening-weighted average of a set of listens. Each part averages only over the songs that have it, so a
 * period with fewer known songs isn't pulled toward zero; `soundMs`/`lyricMs` say how much of `ms` that was.
 */
export type Profile = {
  ms: number;
  soundMs: number;
  lyricMs: number;
  languageMs: number;
  genres: number[];
  moods: number[];
  themes: number[];
  /** Language code -> share of `languageMs`. */
  languages: Record<string, number>;
};

export function profile(listens: Iterable<Listen>, traits: ReadonlyMap<string, SongTraits>, space: Space): Profile {
  const p: Profile = {
    ms: 0,
    soundMs: 0,
    lyricMs: 0,
    languageMs: 0,
    genres: space.genres.map(() => 0),
    moods: space.moods.map(() => 0),
    themes: space.themes.map(() => 0),
    languages: {},
  };
  const add = (into: number[], values: readonly number[], w: number) => values.forEach((v, i) => (into[i]! += v * w));
  for (const { trackId, ms } of listens) {
    p.ms += ms;
    const t = traits.get(trackId);
    if (t?.genres && t.moods) {
      p.soundMs += ms;
      add(p.genres, t.genres, ms);
      add(p.moods, t.moods, ms);
    }
    if (t?.themes) {
      p.lyricMs += ms;
      add(p.themes, t.themes, ms);
    }
    if (t?.language) {
      p.languageMs += ms;
      p.languages[t.language] = (p.languages[t.language] ?? 0) + ms;
    }
  }
  const scale = (values: number[], by: number) => values.forEach((v, i) => (values[i] = by ? v / by : 0));
  scale(p.genres, p.soundMs);
  scale(p.moods, p.soundMs);
  scale(p.themes, p.lyricMs);
  for (const code in p.languages) p.languages[code]! /= p.languageMs;
  return p;
}

const DAY = 86_400_000;
/** "2019-03", in UTC. */
export const monthOf = (at: number) => new Date(at).toISOString().slice(0, 7);
/** Weeks counted from a Monday, so every listen in one Monday–Sunday week (UTC) shares a number. */
export const weekOf = (at: number) => Math.floor((at + 3 * DAY) / (7 * DAY));

/** Every month from `from` to `to`, inclusive ("2019-11", "2019-12", "2020-01"). */
export function monthRange(from: string, to: string): string[] {
  const months: string[] = [];
  let [y, m] = from.split("-").map(Number) as [number, number];
  for (let key = from; key <= to; key = `${y}-${String(m).padStart(2, "0")}`) {
    months.push(key);
    [y, m] = m === 12 ? [y + 1, 1] : [y, m + 1];
  }
  return months;
}

export type Point = { x: readonly number[]; w: number };
export type Segmentation = { starts: number[]; cost: number };

/**
 * Splits a series into `k` runs of at least `minLength` points, minimizing the weighted squared distance of each
 * point from its run's weighted mean (exact, by dynamic programming over prefix sums). Returns the best split for
 * every k from 1 to `maxK` that fits; `starts` are the first index of each run.
 */
export function segmentations(points: readonly Point[], maxK: number, minLength: number): Segmentation[] {
  const n = points.length;
  const dim = points[0]?.x.length ?? 0;
  // Prefix sums of w, w·x and w·|x|², so any run's cost is O(dim).
  const W = [0];
  const WX = [new Float64Array(dim)];
  const WXX = [0];
  points.forEach(({ x, w }, i) => {
    const wx = Float64Array.from(WX[i]!);
    let xx = 0;
    x.forEach((v, d) => {
      wx[d]! += w * v;
      xx += v * v;
    });
    W.push(W[i]! + w);
    WX.push(wx);
    WXX.push(WXX[i]! + w * xx);
  });
  const cost = (i: number, j: number) => {
    const w = W[j]! - W[i]!;
    if (w <= 0) return 0;
    let sq = 0;
    for (let d = 0; d < dim; d++) sq += (WX[j]![d]! - WX[i]![d]!) ** 2;
    return WXX[j]! - WXX[i]! - sq / w;
  };

  // best[k][j]: cheapest split of the first j points into k + 1 runs; from[k][j]: where its last run starts.
  const best: number[][] = [];
  const from: number[][] = [];
  const results: Segmentation[] = [];
  for (let k = 0; k < maxK && (k + 1) * minLength <= n; k++) {
    best.push(new Array<number>(n + 1).fill(Infinity));
    from.push(new Array<number>(n + 1).fill(-1));
    for (let j = (k + 1) * minLength; j <= n; j++) {
      if (k === 0) {
        best[0]![j] = cost(0, j);
        from[0]![j] = 0;
        continue;
      }
      for (let i = k * minLength; i <= j - minLength; i++) {
        const c = best[k - 1]![i]! + cost(i, j);
        if (c < best[k]![j]!) {
          best[k]![j] = c;
          from[k]![j] = i;
        }
      }
    }
    const starts: number[] = [];
    for (let kk = k, j = n; kk >= 0; kk--) {
      j = from[kk]![j]!;
      starts.unshift(j);
    }
    results.push({ starts, cost: best[k]![n]! });
  }
  return results;
}

/**
 * How many runs the series really has: keeps adding a split while it removes at least `minGain` of the one-run cost.
 * Past that, a split is fitting noise, not a change.
 */
export function chooseSegmentation(options: readonly Segmentation[], minGain: number): Segmentation | undefined {
  const total = options[0]?.cost ?? 0;
  let k = 0;
  while (k + 1 < options.length && total > 0 && (options[k]!.cost - options[k + 1]!.cost) / total >= minGain) k++;
  return options[k];
}

/**
 * Turns monthly profiles into points for `segmentations`: each dimension standardized across months, then sound
 * (genres, moods) and lyrics (themes, languages) scaled to count equally. `genres` and `languages` pick which of
 * those dimensions to use, since most genres barely appear. A month weighs the square root of its hours with known
 * traits: a busier month is a surer reading, but twice the hours of the same songs isn't twice the evidence of taste,
 * and weighing by hours alone let the busiest years swallow the changes inside them.
 */
export function monthPoints(months: readonly Profile[], genres: readonly number[], languages: readonly string[]): Point[] {
  const sound = months.map((p) => [...genres.map((g) => p.genres[g]!), ...p.moods]);
  const lyrics = months.map((p) => [...p.themes, ...languages.map((code) => p.languages[code] ?? 0)]);
  const standardize = (rows: number[][], weights: number[]) => {
    const dim = rows[0]?.length ?? 0;
    const total = weights.reduce((a, b) => a + b, 0) || 1;
    const out = rows.map((r) => [...r]);
    for (let d = 0; d < dim; d++) {
      const mean = rows.reduce((s, r, i) => s + r[d]! * weights[i]!, 0) / total;
      const sd = Math.sqrt(rows.reduce((s, r, i) => s + (r[d]! - mean) ** 2 * weights[i]!, 0) / total) || 1;
      // A month with nothing known sits at the mean, so it costs nothing wherever it falls.
      out.forEach((r, i) => (r[d] = weights[i] ? (r[d]! - mean) / sd / Math.sqrt(dim) : 0));
    }
    return out;
  };
  const soundW = months.map((p) => p.soundMs);
  const lyricW = months.map((p) => p.lyricMs);
  const s = standardize(sound, soundW);
  const l = standardize(lyrics, lyricW);
  return months.map((p, i) => ({ x: [...s[i]!, ...l[i]!], w: Math.sqrt((p.soundMs + p.lyricMs) / 2 / 3_600_000) }));
}

export type Ranked = { name: string; value: number };

/** The `limit` dimensions where `era` is furthest above (`sign` 1) or below (-1) `base`, by `era - base`. */
export function deltas(names: readonly string[], era: readonly number[], base: readonly number[], sign: 1 | -1, limit: number): Ranked[] {
  return names
    .map((name, i) => ({ name, value: era[i]! - base[i]! }))
    .filter((d) => d.value * sign > 0)
    .sort((a, b) => (b.value - a.value) * sign)
    .slice(0, limit);
}

export type SongStat = { trackId: string; name: string; artist: string; saved: boolean; listens: number; hours: number; weeks: number; lift: number };
export type ArtistStat = { name: string; hours: number; share: number; lift: number };

/**
 * Lift: how much more of something's listening falls in a period than the period's share of all listening would
 * predict. 1 is "as usual"; a song only ever played in a period that holds a tenth of all listening has lift 10.
 */
const lift = (inPeriod: number, overall: number, periodShare: number) => (overall && periodShare ? inPeriod / overall / periodShare : 0);

/** A song must have this many listens in an era, spread over this many weeks, to define it: not a one-week loop. */
export const DEFINING_MIN_LISTENS = 8;
export const DEFINING_MIN_WEEKS = 3;

/**
 * The songs most characteristic of a period: listened to a lot in it, and much more in it than at any other time.
 * Ranked by hours in the period times the log of their lift, so a song played as much everywhere scores nothing.
 */
export function definingSongs(
  period: readonly Listen[],
  totals: ReadonlyMap<string, number>,
  periodShare: number,
  names: ReadonlyMap<string, SongName>,
  limit: number,
): SongStat[] {
  const bySong = new Map<string, { ms: number; listens: number; weeks: Set<number> }>();
  for (const { trackId, at, ms } of period) {
    const s = bySong.get(trackId) ?? { ms: 0, listens: 0, weeks: new Set<number>() };
    s.ms += ms;
    s.listens++;
    s.weeks.add(weekOf(at));
    bySong.set(trackId, s);
  }
  return [...bySong]
    .filter(([, s]) => s.listens >= DEFINING_MIN_LISTENS && s.weeks.size >= DEFINING_MIN_WEEKS)
    .map(([trackId, s]) => {
      const name = names.get(trackId) ?? { name: trackId, artist: "", saved: false };
      return { trackId, ...name, listens: s.listens, hours: s.ms / 3_600_000, weeks: s.weeks.size, lift: lift(s.ms, totals.get(trackId) ?? 0, periodShare) };
    })
    .filter((s) => s.lift > 1)
    .sort((a, b) => b.hours * Math.log(b.lift) - a.hours * Math.log(a.lift))
    .slice(0, limit);
}

/** The artists with the most listening in a period, with their lift against all listening. */
export function topArtists(
  period: readonly Listen[],
  artistTotals: ReadonlyMap<string, number>,
  periodShare: number,
  names: ReadonlyMap<string, SongName>,
  limit: number,
): ArtistStat[] {
  const byArtist = new Map<string, number>();
  let total = 0;
  for (const { trackId, ms } of period) {
    total += ms;
    const artist = names.get(trackId)?.artist;
    if (artist) byArtist.set(artist, (byArtist.get(artist) ?? 0) + ms);
  }
  return [...byArtist]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([name, ms]) => ({ name, hours: ms / 3_600_000, share: ms / total, lift: lift(ms, artistTotals.get(name) ?? 0, periodShare) }));
}

/** How lopsided a period's listening was: its busiest week's share, and its most played song's share. */
export function concentration(period: readonly Listen[]) {
  const byWeek = new Map<number, number>();
  const bySong = new Map<string, number>();
  let total = 0;
  for (const { trackId, at, ms } of period) {
    total += ms;
    byWeek.set(weekOf(at), (byWeek.get(weekOf(at)) ?? 0) + ms);
    bySong.set(trackId, (bySong.get(trackId) ?? 0) + ms);
  }
  const [week, weekMs] = [...byWeek].reduce((a, b) => (b[1] > a[1] ? b : a), [0, 0]);
  const [song, songMs] = [...bySong].reduce((a, b) => (b[1] > a[1] ? b : a), ["", 0]);
  return {
    activeWeeks: byWeek.size,
    topWeek: { start: new Date(week * 7 * DAY - 3 * DAY).toISOString().slice(0, 10), share: total ? weekMs / total : 0 },
    topSong: { trackId: song, share: total ? songMs / total : 0 },
  };
}

/** Where the analysis starts: the first month that opens this many in a row with at least `START_HOURS` each. Thinner early months are summed up, not split into eras. */
export const START_MONTHS = 3;
export const START_HOURS = 10;
/** An era is at least this long, so a few odd weeks can't become one. */
export const MIN_ERA_MONTHS = 4;
export const MAX_ERAS = 12;
/**
 * A split must remove this share of the one-era cost to count (see `chooseSegmentation`). Checked against the same
 * months in random order: past the first two splits, no split of 20 shuffles removed more than 2.7%.
 */
export const MIN_SPLIT_GAIN = 0.03;
/** Genres and languages that hold at least this share of listening are used to find the splits. */
const MIN_DIM_SHARE = 0.02;
const LIST = 8;

export type Shift = { more: Ranked[]; less: Ranked[] };

export type Era = {
  /** The first month, which names the era. */
  id: string;
  from: string;
  to: string;
  hours: number;
  listens: number;
  distinctSongs: number;
  /** Share of the era's listening on songs with sound traits, and with lyric themes. */
  coverage: { sound: number; lyrics: number };
  artists: ArtistStat[];
  songs: SongStat[];
  /** Against all-time listening: genres share points, moods probability points, themes standard deviations. */
  genres: Shift;
  moods: Shift;
  themes: Shift;
  /** Language code -> share of listening with a known language. */
  languages: Ranked[];
  concentration: ReturnType<typeof concentration> & { topSongName: string };
  /** What changed going into the next era, if there is one. */
  next?: { genres: Shift; themes: Shift; arrived: string[]; left: string[] };
  /** The era written up from these facts, from data/eras-chronicle.json (see `pnpm eras`). */
  story?: string;
};

/** data/eras-chronicle.json: prose written from data/eras.json, an opening and a paragraph per era id. */
export type Chronicle = { intro: string; eras: Record<string, string> };

export type MonthSummary = { month: string; hours: number; sound: number; lyrics: number; era: number };

export type ErasFile = {
  generatedAt: string;
  /** Months before `eras[0]` with too little listening to read, summed. */
  before: { from: string; to: string; hours: number } | null;
  months: MonthSummary[];
  eras: Era[];
  /** How much each extra split removed, as a share of the one-era cost: why this many eras. */
  gains: number[];
  intro?: string;
};

const hours = (ms: number) => ms / 3_600_000;
const round = (v: number, places = 3) => Math.round(v * 10 ** places) / 10 ** places;
const shift = (names: readonly string[], a: readonly number[], b: readonly number[], limit = LIST): Shift => ({
  more: deltas(names, a, b, 1, limit).map((d) => ({ ...d, value: round(d.value) })),
  less: deltas(names, a, b, -1, limit).map((d) => ({ ...d, value: round(d.value) })),
});

/** Finds the eras in a listening history (listens in any order) and describes each one. */
export function findEras(
  listens: readonly Listen[],
  traits: ReadonlyMap<string, SongTraits>,
  space: Space,
  names: ReadonlyMap<string, SongName>,
  generatedAt: Date,
): ErasFile {
  const sorted = [...listens].sort((a, b) => a.at - b.at);
  const empty = { generatedAt: generatedAt.toISOString(), before: null, months: [], eras: [], gains: [] };
  if (!sorted.length) return empty;
  const byMonth = new Map<string, Listen[]>();
  for (const l of sorted) {
    const key = monthOf(l.at);
    const list = byMonth.get(key);
    if (list) list.push(l);
    else byMonth.set(key, [l]);
  }
  const allMonths = monthRange(monthOf(sorted[0]!.at), monthOf(sorted.at(-1)!.at));
  const monthMs = (m: string | undefined) => (byMonth.get(m ?? "") ?? []).reduce((s, l) => s + l.ms, 0);
  const startAt = allMonths.findIndex((_, i) => allMonths.slice(i, i + START_MONTHS).length === START_MONTHS && allMonths.slice(i, i + START_MONTHS).every((m) => hours(monthMs(m)) >= START_HOURS));
  if (startAt < 0) return empty;
  const months = allMonths.slice(startAt);
  const profiles = months.map((m) => profile(byMonth.get(m) ?? [], traits, space));

  const analyzed = sorted.filter((l) => monthOf(l.at) >= months[0]!);
  const base = profile(analyzed, traits, space);
  const genres = space.genres.flatMap((_, g) => (base.genres[g]! >= MIN_DIM_SHARE ? [g] : []));
  const languages = Object.keys(base.languages).filter((code) => base.languages[code]! >= MIN_DIM_SHARE);
  const options = segmentations(monthPoints(profiles, genres, languages), MAX_ERAS, MIN_ERA_MONTHS);
  const chosen = chooseSegmentation(options, MIN_SPLIT_GAIN)!;
  const total = options[0]!.cost;

  const songTotals = new Map<string, number>();
  const artistTotals = new Map<string, number>();
  for (const { trackId, ms } of analyzed) {
    songTotals.set(trackId, (songTotals.get(trackId) ?? 0) + ms);
    const artist = names.get(trackId)?.artist;
    if (artist) artistTotals.set(artist, (artistTotals.get(artist) ?? 0) + ms);
  }

  const spans = chosen.starts.map((start, i) => months.slice(start, chosen.starts[i + 1] ?? months.length));
  const eraProfiles = spans.map((span) => profile(span.flatMap((m) => byMonth.get(m) ?? []), traits, space));
  const eras = spans.map((span, i): Era => {
    const period = span.flatMap((m) => byMonth.get(m) ?? []);
    const p = eraProfiles[i]!;
    const share = p.ms / base.ms;
    const c = concentration(period);
    const artists = topArtists(period, artistTotals, share, names, LIST * 2);
    return {
      id: span[0]!,
      from: span[0]!,
      to: span.at(-1)!,
      hours: round(hours(p.ms), 1),
      listens: period.length,
      distinctSongs: new Set(period.map((l) => l.trackId)).size,
      coverage: { sound: round(p.soundMs / p.ms), lyrics: round(p.lyricMs / p.ms) },
      artists: artists.map((a) => ({ ...a, hours: round(a.hours, 1), share: round(a.share), lift: round(a.lift, 2) })),
      songs: definingSongs(period, songTotals, share, names, LIST * 2).map((s) => ({ ...s, hours: round(s.hours, 1), lift: round(s.lift, 2) })),
      genres: shift(space.genres, p.genres, base.genres),
      moods: shift(space.moods, p.moods, base.moods),
      themes: shift(space.themes, p.themes, base.themes),
      languages: Object.entries(p.languages)
        .sort((a, b) => b[1] - a[1])
        .map(([name, value]) => ({ name, value: round(value) })),
      concentration: { ...c, topWeek: { ...c.topWeek, share: round(c.topWeek.share) }, topSong: { ...c.topSong, share: round(c.topSong.share) }, topSongName: names.get(c.topSong.trackId)?.name ?? c.topSong.trackId },
    };
  });
  eras.forEach((era, i) => {
    const next = eras[i + 1];
    if (!next) return;
    const [a, b] = [eraProfiles[i]!, eraProfiles[i + 1]!];
    const top = (e: Era) => new Set(e.artists.slice(0, LIST).map((x) => x.name));
    const [was, now] = [top(era), top(next)];
    era.next = {
      genres: shift(space.genres, b.genres, a.genres, 5),
      themes: shift(space.themes, b.themes, a.themes, 5),
      arrived: [...now].filter((x) => !was.has(x)),
      left: [...was].filter((x) => !now.has(x)),
    };
  });

  const eraOf = new Map(spans.flatMap((span, i) => span.map((m) => [m, i] as const)));
  const firstMonth = allMonths[0]!;
  return {
    generatedAt: generatedAt.toISOString(),
    before: startAt > 0 ? { from: firstMonth, to: allMonths[startAt - 1]!, hours: round(hours(allMonths.slice(0, startAt).reduce((s, m) => s + monthMs(m), 0)), 1) } : null,
    months: months.map((month, i) => {
      const p = profiles[i]!;
      return { month, hours: round(hours(p.ms), 1), sound: p.ms ? round(p.soundMs / p.ms) : 0, lyrics: p.ms ? round(p.lyricMs / p.ms) : 0, era: eraOf.get(month)! };
    }),
    eras,
    gains: options.slice(1).map((o, k) => round((options[k]!.cost - o.cost) / total)),
  };
}
