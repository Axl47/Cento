// Where and why plays get skipped, from Spotify's Extended Streaming History: how far into a song the forward button
// is pressed, whether those presses gather at particular moments of a song, and which kinds of song get skipped more
// than the listener's familiarity with them predicts. Pure code; `pnpm skips` feeds it and writes data/skips.json.
import { parseExport, type Play } from "./plays.ts";

/** An export row with what a skip analysis needs beyond `Play`: why the play started and ended, and how it was played. */
export type ExportPlay = Play & {
  msPlayed: number;
  reasonStart: string;
  reasonEnd: string;
  shuffle: boolean;
  device: Device;
};

export type Device = "desktop" | "mobile" | "tv" | "web" | "other";

/** Groups Spotify's free-form `platform` strings ("osx", "Android OS 12 API 31 (samsung…)", "Partner windows_tv …"). */
export function deviceOf(platform: string): Device {
  const p = platform.toLowerCase();
  if (p.startsWith("partner") || p.includes("tv") || p.includes("xbox") || p.includes("playstation")) return "tv";
  if (p.startsWith("android") || p.startsWith("ios") || p.includes("iphone")) return "mobile";
  if (p.startsWith("windows") || p.startsWith("osx") || p.startsWith("os x") || p.startsWith("linux")) return "desktop";
  if (p.includes("web")) return "web";
  return "other";
}

type SkipFields = { reason_start?: unknown; reason_end?: unknown; shuffle?: unknown; platform?: unknown };

/** One export row as an `ExportPlay`, or null where `parseExport` gives up (podcasts, local files). */
export function parseExportPlay(value: unknown): ExportPlay | null {
  const play = parseExport(value);
  if (!play || play.msPlayed === undefined) return null;
  const row = value as SkipFields;
  const text = (x: unknown) => (typeof x === "string" ? x : "unknown");
  return {
    ...play,
    msPlayed: play.msPlayed,
    reasonStart: text(row.reason_start),
    reasonEnd: text(row.reason_end),
    shuffle: row.shuffle === true,
    device: deviceOf(text(row.platform)),
  };
}

/** The forward button: the listener chose to leave this song for the next one. */
export const isBail = (play: ExportPlay) => play.reasonEnd === "fwdbtn";

/**
 * Plays that started at the top of the song, so `msPlayed` is how far into it the play got. `appload`, `playbtn`
 * and `remote` can resume a paused song partway in. Seeking within a play still breaks this; nothing in the export shows it.
 */
export const startsAtTop = (play: ExportPlay) => ["trackdone", "fwdbtn", "backbtn", "clickrow"].includes(play.reasonStart);

/** Plays the listener didn't pick: the queue moved on to them (the previous song ended or was skipped). */
export const autoStarted = (play: ExportPlay) => play.reasonStart === "trackdone" || play.reasonStart === "fwdbtn";

/**
 * Where in a song a skip lands. `instant`: under 3 s, too soon to have heard anything (skimming a queue);
 * `sampled`: 3–30 s, a verdict on the opening; `mid`: from 30 s to 90% through; `tail`: the last 10%.
 */
export type Phase = "instant" | "sampled" | "mid" | "tail";
export const PHASES = ["instant", "sampled", "mid", "tail"] as const satisfies readonly Phase[];
export const INSTANT_MS = 3_000;
export const SAMPLED_MS = 30_000;
export const TAIL_SHARE = 0.9;

export function phaseOf(msPlayed: number, durationMs: number): Phase {
  if (msPlayed < INSTANT_MS) return "instant";
  if (msPlayed < SAMPLED_MS) return "sampled";
  return msPlayed < TAIL_SHARE * durationMs ? "mid" : "tail";
}

/** Counts per bin; `edges[i]` is where bin i starts, the last bin is open-ended. */
export type Histogram = { edges: number[]; counts: number[] };

export function histogram(values: Iterable<number>, edges: readonly number[]): Histogram {
  const counts = edges.map(() => 0);
  for (const v of values) {
    let i = edges.length - 1;
    while (i > 0 && v < edges[i]!) i--;
    counts[i]!++;
  }
  return { edges: [...edges], counts };
}

/** How many skips came straight after another skip: skimming through a queue rather than judging songs. */
export function chainedSkips(plays: readonly ExportPlay[]): number {
  const sorted = [...plays].sort((a, b) => a.at - b.at);
  return sorted.filter((p, i) => isBail(p) && p.reasonStart === "fwdbtn" && i > 0 && isBail(sorted[i - 1]!)).length;
}

// ---- When in a song: a discrete-time hazard over the seconds of each song ----

/**
 * One song's seconds from `from` to `to` (exclusive): at each second, how many plays were still going (`exposed`)
 * and how many of them were skipped during it (`bails`). A play that ends any other way is exposed up to its end and
 * then drops out without a bail, so stopped or interrupted plays don't distort where skips fall.
 */
export type SongCurve = { from: number; exposed: number[]; bails: number[] };

/** The seconds each song's curve covers: the mid-song window, past the 30 s verdict and short of the last 10%. */
export const midWindow = (durationMs: number): [from: number, to: number] => [SAMPLED_MS / 1000, Math.floor((TAIL_SHARE * durationMs) / 1000)];

/** Builds each song's curve from plays that started at its top. `durationMs` decides which songs take part. */
export function songCurves(plays: readonly ExportPlay[], durationMs: ReadonlyMap<string, number>): Map<string, SongCurve> {
  const curves = new Map<string, SongCurve>();
  for (const play of plays) {
    const duration = durationMs.get(play.trackId);
    if (duration === undefined || !startsAtTop(play)) continue;
    const [from, to] = midWindow(duration);
    if (to <= from) continue;
    let curve = curves.get(play.trackId);
    if (!curve) {
      curve = { from, exposed: Array(to - from).fill(0), bails: Array(to - from).fill(0) };
      curves.set(play.trackId, curve);
    }
    const second = Math.floor(play.msPlayed / 1000);
    const last = Math.min(second, to - 1);
    for (let s = from; s <= last; s++) curve.exposed[s - from]!++;
    if (isBail(play) && second >= from && second < to) curve.bails[second - from]!++;
  }
  return curves;
}

/** Pooled skip rate per second of song time, the baseline every song-specific signal is measured against. Index = second. */
export function baselineHazard(curves: Iterable<SongCurve>, smoothing = 2): number[] {
  const bails: number[] = [];
  const exposed: number[] = [];
  for (const c of curves)
    c.exposed.forEach((e, i) => {
      const s = c.from + i;
      bails[s] = (bails[s] ?? 0) + c.bails[i]!;
      exposed[s] = (exposed[s] ?? 0) + e;
    });
  // Averaged over ±`smoothing` s so the baseline follows time in the song, not the noise of any single second.
  const window = (xs: number[], s: number) => xs.slice(Math.max(s - smoothing, 0), s + smoothing + 1).reduce((a, b) => a + (b ?? 0), 0);
  return Array.from(exposed, (_, s) => {
    const e = window(exposed, s);
    return e > 0 ? window(bails, s) / e : 0;
  });
}

/** Observed against expected: `lift` 1.5 means half again as many skips as expected. */
export type Lift = { observed: number; expected: number; lift: number };
const lift = (observed: number, expected: number): Lift => ({ observed, expected, lift: expected > 0 ? observed / expected : NaN });

/**
 * Where in the song its skips would fall if only time in the song mattered: exposure × baseline at each second,
 * scaled so the song's expected skips add up to its observed ones. Comparing against this asks *where* within each
 * song skips land, so songs that are skipped more overall don't tilt the answer.
 */
export function expectedSkips(curve: SongCurve, baseline: readonly number[]): number[] {
  const raw = curve.exposed.map((e, i) => e * (baseline[curve.from + i] ?? 0));
  const [observed, expected] = [curve.bails, raw].map((xs) => xs.reduce((a, b) => a + b, 0));
  return raw.map((x) => (expected! > 0 ? (x * observed!) / expected! : 0));
}

/**
 * Skips in each category of song-second against `expectedSkips`. `category` names the category a second of a song
 * falls in, or null to leave it out (a song with no data for it).
 */
export function liftBy<K extends string>(
  curves: ReadonlyMap<string, SongCurve>,
  baseline: readonly number[],
  category: (trackId: string, second: number) => K | null,
): Map<K, Lift> {
  const sums = new Map<K, [number, number]>();
  for (const [id, c] of curves)
    expectedSkips(c, baseline).forEach((x, i) => {
      if (c.exposed[i] === 0) return;
      const k = category(id, c.from + i);
      if (k === null) return;
      const [o, e] = sums.get(k) ?? [0, 0];
      sums.set(k, [o + c.bails[i]!, e + x]);
    });
  return new Map([...sums].map(([k, [o, e]]) => [k, lift(o, e)]));
}

/**
 * A per-second signal (relative loudness, novelty) averaged around each skip, at each offset in `offsets`, next to
 * the same average around the skips `expectedSkips` places. Where the two part ways shows what tends to happen in a
 * song just before (negative offsets) a skip.
 */
export function profileAround(
  curves: ReadonlyMap<string, SongCurve>,
  baseline: readonly number[],
  signal: (trackId: string) => readonly (number | null)[] | undefined,
  offsets: readonly number[],
): { offset: number; observed: number; expected: number }[] {
  const sums = offsets.map(() => ({ o: 0, on: 0, x: 0, xn: 0 }));
  for (const [id, c] of curves) {
    const xs = signal(id);
    if (!xs) continue;
    expectedSkips(c, baseline).forEach((weight, i) => {
      const s = c.from + i;
      const bails = c.bails[i]!;
      offsets.forEach((k, j) => {
        const v = xs[s + k];
        if (v === null || v === undefined) return;
        const sum = sums[j]!;
        sum.o += bails * v;
        sum.on += bails;
        sum.x += weight * v;
        sum.xn += weight;
      });
    });
  }
  return offsets.map((offset, j) => {
    const { o, on, x, xn } = sums[j]!;
    return { offset, observed: on ? o / on : NaN, expected: xn ? x / xn : NaN };
  });
}

/** mulberry32: a small seeded generator, so a run's simulated nulls are the same every time. */
export function seeded(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The largest share of `bails` (per second) falling in any `width`-second window, and the second it starts at. */
export function peakWindow(bails: readonly number[], width: number): { share: number; start: number } {
  const total = bails.reduce((a, b) => a + b, 0);
  let [best, start, run] = [0, 0, 0];
  for (let i = 0; i < bails.length; i++) {
    run += bails[i]!;
    if (i >= width) run -= bails[i - width]!;
    if (run > best) [best, start] = [run, Math.max(i - width + 1, 0)];
  }
  return { share: total ? best / total : 0, start };
}

/**
 * Whether a song's skips crowd into one moment more than chance: its peak-window share against `runs` simulations
 * that drop the same number of skips on its seconds in proportion to exposure × baseline. `p` is the share of
 * simulations at least as crowded.
 */
export function crowding(curve: SongCurve, baseline: readonly number[], width: number, runs: number, random: () => number) {
  const weights = curve.exposed.map((e, i) => e * (baseline[curve.from + i] ?? 0));
  const cumulative: number[] = [];
  weights.reduce((sum, w, i) => (cumulative[i] = sum + w), 0);
  const total = cumulative.at(-1) ?? 0;
  const n = curve.bails.reduce((a, b) => a + b, 0);
  const observed = peakWindow(curve.bails, width);
  let atLeast = 0;
  let nullShare = 0;
  for (let r = 0; r < runs; r++) {
    const sim = curve.bails.map(() => 0);
    for (let k = 0; k < n; k++) {
      const u = random() * total;
      let [lo, hi] = [0, cumulative.length - 1];
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (cumulative[mid]! < u) lo = mid + 1;
        else hi = mid;
      }
      sim[lo]!++;
    }
    const share = peakWindow(sim, width).share;
    nullShare += share / runs;
    if (share >= observed.share) atLeast++;
  }
  return { observed: observed.share, peakAt: curve.from + observed.start, expected: nullShare, p: (atLeast + 1) / (runs + 1) };
}

/**
 * How much the sound changes at each patch boundary of a song: 1 − cosine between the mean embedding of the
 * `span` patches before and the `span` after. `patches` holds `n` rows of `dim` floats, in song order. Peaks are
 * section changes (verse to chorus, a drop, a breakdown).
 */
export function novelty(patches: Float32Array, dim: number, span = 4): number[] {
  const n = Math.floor(patches.length / dim);
  const meanOf = (from: number, to: number) => {
    const m = new Float64Array(dim);
    for (let r = from; r < to; r++) for (let d = 0; d < dim; d++) m[d]! += patches[r * dim + d]!;
    return m;
  };
  return Array.from({ length: n }, (_, i) => {
    if (i < span || i + span > n) return 0;
    const [a, b] = [meanOf(i - span, i), meanOf(i, i + span)];
    let [dot, na, nb] = [0, 0, 0];
    for (let d = 0; d < dim; d++) [dot, na, nb] = [dot + a[d]! * b[d]!, na + a[d]! ** 2, nb + b[d]! ** 2];
    return na && nb ? 1 - dot / Math.sqrt(na * nb) : 0;
  });
}

/** Indices of local maxima in `xs` that reach the song's own `quantile` (its biggest changes, not every wobble). */
export function peaks(xs: readonly number[], quantile = 0.85): number[] {
  const sorted = [...xs].sort((a, b) => a - b);
  const floor = sorted[Math.floor(quantile * (sorted.length - 1))] ?? Infinity;
  return xs.flatMap((x, i) => (x > 0 && x >= floor && x >= (xs[i - 1] ?? 0) && x > (xs[i + 1] ?? 0) ? [i] : []));
}

// ---- Which songs: skips against what familiarity and context predict ----

/** The bucket a count of earlier listens falls in: how familiar the song was when this play came up. */
export function familiarity(listens: number): string {
  if (listens === 0) return "new";
  if (listens < 3) return "1-2";
  if (listens < 10) return "3-9";
  if (listens < 30) return "10-29";
  return "30+";
}

/** A play the song-level comparison scores: its outcome and the strata it's compared within. */
export type ScoredPlay = { trackId: string; skipped: boolean; shuffle: boolean; context: string; standing: string };

/**
 * Skips per song trait against expected, where each play's expectation is the skip rate of its stratum (the plays
 * `stratum` puts with it, e.g. same familiarity, year, device and shuffle). A trait with lift 1.2 is skipped a fifth
 * more than plays in the same strata. `trait` returns null for songs it can't place; `trait` = the track id gives
 * each song's own lift.
 */
export function strataLift<P extends Pick<ScoredPlay, "trackId" | "skipped">, K extends string>(
  plays: readonly P[],
  stratum: (play: P) => string,
  trait: (trackId: string) => K | null,
): Map<K, Lift & { plays: number }> {
  const rate = new Map<string, [skips: number, plays: number]>();
  for (const p of plays) {
    const [s, n] = rate.get(stratum(p)) ?? [0, 0];
    rate.set(stratum(p), [s + Number(p.skipped), n + 1]);
  }
  const sums = new Map<K, [number, number, number]>();
  for (const p of plays) {
    const k = trait(p.trackId);
    if (k === null) continue;
    const [s, n] = rate.get(stratum(p))!;
    const [o, x, c] = sums.get(k) ?? [0, 0, 0];
    sums.set(k, [o + Number(p.skipped), x + s / n, c + 1]);
  }
  return new Map([...sums].map(([k, [o, x, c]]) => [k, { ...lift(o, x), plays: c }]));
}

/**
 * data/skips.json: per library song, its auto-started plays, skips in the first 30 s and how many its strata predict,
 * then skips mid-song (of plays that got past 30 s) and their prediction, and the second its mid-song skips crowd
 * around, when they crowd more than chance.
 */
export type SkipsFile = {
  generatedAt: string;
  songs: Record<string, [plays: number, early: number, earlyExpected: number, mid: number, midExpected: number, peakSecond: number | null]>;
};
