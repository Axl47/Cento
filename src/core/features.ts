// Per-song musical features (tempo, key, loudness, vocals) from Stemma's bench/extract_features.py, condensed by
// `pnpm features` into data/features.json, and the reasons a handoff between two songs may sound rough.
// Pure code, shared by the CLI and the app.

/** The fields of one line of the engine's features.jsonl this app reads (see Stemma's bench/extract_features.md). */
export type EngineFeatures = {
  key: string;
  tempo: { bpm_fold: number | null; reg: number | null };
  tonal: { all: [tonic: string, mode: string, strength: number]; camelot: string };
  /** `st[k]` is the short-term loudness at k + 1 s; `end` is where the audio really ends. */
  loud: { lufs: number; st: number[]; end: number };
  voc: { first: number | null; last: number | null; share: number };
};

export type SongFeatures = {
  /** Tempo moved into 80–160 BPM. */
  bpm: number | null;
  /** The beat holds still enough for its BPM to mean something. */
  steady: boolean;
  /** Whole-song key, e.g. "F minor", and its Camelot wheel code, e.g. "4A". */
  key: string;
  camelot: string;
  keyStrength: number;
  /** Integrated loudness, LUFS. */
  lufs: number;
  /** Loudness of the first and last 10 s relative to `lufs`, LU (negative for quiet starts and fades). */
  intro: number;
  outro: number;
  /** Share of the song with vocals (0 for instrumentals), and when they first start and last stop, s. */
  vocals: number;
  vocalsFirst: number | null;
  vocalsLast: number | null;
};

/** data/features.json: library track id → its features as a tuple in `SongFeatures` key order, to keep the file small. */
export type FeaturesFile = Record<string, SongFeatures[keyof SongFeatures][]>;

const FIELDS = ["bpm", "steady", "key", "camelot", "keyStrength", "lufs", "intro", "outro", "vocals", "vocalsFirst", "vocalsLast"] as const satisfies readonly (keyof SongFeatures)[];

const STEADY_REG = 0.8;
const EDGE_S = 10;
const round1 = (x: number) => Math.round(x * 10) / 10;
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / (xs.length || 1);

/** Condenses one engine line to what the app needs. */
export function songFeatures({ tempo, tonal, loud, voc }: EngineFeatures): SongFeatures {
  const end = Math.min(Math.round(loud.end), loud.st.length);
  return {
    bpm: tempo.bpm_fold,
    steady: (tempo.reg ?? 0) >= STEADY_REG,
    key: `${tonal.all[0]} ${tonal.all[1]}`,
    camelot: tonal.camelot,
    keyStrength: tonal.all[2],
    lufs: loud.lufs,
    intro: round1(mean(loud.st.slice(0, EDGE_S)) - loud.lufs),
    outro: round1(mean(loud.st.slice(Math.max(end - EDGE_S, 0), end)) - loud.lufs),
    vocals: voc.share,
    vocalsFirst: voc.first,
    vocalsLast: voc.last,
  };
}

export const encodeFeatures = (songs: Map<string, SongFeatures>): FeaturesFile =>
  Object.fromEntries([...songs].map(([id, f]) => [id, FIELDS.map((k) => f[k])]));

export const decodeFeatures = (file: FeaturesFile): Map<string, SongFeatures> =>
  new Map(Object.entries(file).map(([id, row]) => [id, Object.fromEntries(FIELDS.map((k, i) => [k, row[i]])) as SongFeatures]));

/**
 * A tempo change beyond this share (after allowing half/double time) counts as a jump. With half and double time
 * equal, tempos can differ by at most 41%, so a tight limit flags most pairs: 8% fires on three in four, this on about a third.
 */
export const TEMPO_JUMP = 0.2;
/** The next song starting this many LU louder or quieter than the last one ended: about twice or half as loud. */
export const ENERGY_JUMP = 10;
/** Keys are trusted above this strength. */
export const KEY_STRENGTH = 0.75;
const MAX_REASONS = 2;

/** `b / a` folded into [1/√2, √2] by doubling or halving, so half and double time count as the same tempo. */
export function tempoRatio(a: number, b: number) {
  let r = b / a;
  while (r > Math.SQRT2) r /= 2;
  while (r < Math.SQRT1_2) r *= 2;
  return r;
}

/** Steps apart on the Camelot wheel (0–6), ignoring the letter: 5 or 6 means a semitone or tritone apart. */
export function camelotSteps(a: string, b: string) {
  const d = Math.abs(parseInt(a) - parseInt(b)) % 12;
  return Math.min(d, 12 - d);
}

/**
 * Up to two short reasons the seam from song `a` into song `b` may sound rough, most telling first:
 * a tempo jump, an energy jump at the seam, a key clash.
 */
export function handoffReasons(a: SongFeatures, b: SongFeatures): string[] {
  const reasons: string[] = [];
  if (a.steady && b.steady && a.bpm && b.bpm && Math.abs(tempoRatio(a.bpm, b.bpm) - 1) > TEMPO_JUMP)
    reasons.push(`${Math.round(a.bpm)} → ${Math.round(b.bpm)} BPM`);
  const jump = b.intro - a.outro;
  if (jump >= ENERGY_JUMP) reasons.push("quiet → loud");
  else if (jump <= -ENERGY_JUMP) reasons.push("loud → quiet");
  if (a.keyStrength >= KEY_STRENGTH && b.keyStrength >= KEY_STRENGTH && camelotSteps(a.camelot, b.camelot) >= 5) reasons.push("key clash");
  return reasons.slice(0, MAX_REASONS);
}

/** The library's 5th and 95th percentile loudness: the span an energy arc is drawn over. */
export function loudnessSpan(features: ReadonlyMap<string, SongFeatures>): [low: number, high: number] {
  const sorted = [...features.values()].map((f) => f.lufs).sort((a, b) => a - b);
  const at = (p: number) => sorted[Math.floor(p * (sorted.length - 1))] ?? 0;
  return [at(0.05), at(0.95)];
}

/** Each song's loudness scaled into 0–1 over `span` (clamped), or null for a song without features. */
export const energyArc = (ids: string[], features: ReadonlyMap<string, SongFeatures>, [low, high]: [number, number]) =>
  ids.map((id) => {
    const f = features.get(id);
    return f ? Math.min(Math.max((f.lufs - low) / (high - low || 1), 0), 1) : null;
  });
