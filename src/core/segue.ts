// Segue (github.com/Axl47/segue) plays the library as an endless beat-matched mix on the Omarchy desktop. It reports
// to the host what it played, graded and rejected (stored in data/segue.jsonl, see src/host/segue.ts) and what it's
// playing (shown on Now Playing), and asks for listening context to steer its walk. Songs are keyed by ISRC.
import type { Library } from "./library.ts";
import type { Playback } from "./now.ts";
import { isListen, type Play, type SongPlays } from "./plays.ts";
import { rediscover } from "./review.ts";

export type PlanInfo = { kind: "mash" | "vocal" | "outro" | "fade"; bars: number; ratio: number; shift: number; key_dist: number; a_from: number; b_from: number };

/** One line of data/segue.jsonl. Stored verbatim, with any fields and types beyond these. */
export type SegueEvent =
  /** A transition started to sound (its overlap began). */
  | { type: "transition"; event_id: string; at: string; id: string; a: string; b: string; a_label: string; b_label: string; plan: PlanInfo; behind: number }
  /** A grade on a transition, linked to it by `(id, a, b)`: +1 good, −1 off, 0 a note alone. */
  | { type: "mark"; event_id: string; at: string; id: string; a: string; b: string; a_label: string; b_label: string; plan: PlanInfo; rating: -1 | 0 | 1; note: string | null; since_overlap: number; vocals: number; backing: number; seed: string }
  /** A song stopped being the current one; `heard` is the seconds it played as the current song, seeks excluded. */
  | { type: "play"; event_id: string; at: string; started: string; key: string; label: string; heard: number; ended: "next" | "skip" | "radio" | "quit" | "end"; via: string | null; seed: string }
  /** A planned pairing was replaced before it sounded. */
  | { type: "reject"; event_id: string; at: string; a: string; b: string; a_label: string; b_label: string; plan: PlanInfo; by: "reroll" | "queue" };

/** What Segue is playing, sent on every change and every 5 s while it runs. `key` null: nothing loaded. */
export type SegueNow = {
  playing: boolean;
  key: string | null;
  label: string | null;
  position_ms: number;
  duration_ms: number;
  /** `in_ms` is negative during the overlap. */
  next: { key: string; label: string; kind: PlanInfo["kind"]; in_ms: number | null } | null;
  vocals: number;
  backing: number;
  mashup: boolean;
  /** A transition has played that +/− would grade. */
  markable: boolean;
};

export type SegueCommand = { command: "toggle" | "next" | "previous" } | { command: "seek"; ms: number } | { command: "mark"; rating: 1 | -1 };

/** Rows Segue wrote before it recorded UTC offsets are Puerto Rico local time, UTC−4 all year. */
const BACKFILL_OFFSET = "-04:00";

/** Epoch ms of one of Segue's ISO times, with or without an offset. */
export const segueTime = (iso: string) => Date.parse(/(Z|[+-]\d\d:?\d\d)$/i.test(iso) ? iso : iso + BACKFILL_OFFSET);

const isNumber = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isStringOrNull = (v: unknown) => v === null || typeof v === "string";

/** Whether a PUT body is a `SegueNow`; extra fields are fine. */
export function isSegueNow(body: unknown): body is SegueNow {
  const b = body as Partial<SegueNow> | null;
  const next = b?.next as Partial<NonNullable<SegueNow["next"]>> | null | undefined;
  return (
    typeof b?.playing === "boolean" &&
    isStringOrNull(b.key) &&
    isStringOrNull(b.label) &&
    isNumber(b.position_ms) &&
    isNumber(b.duration_ms) &&
    typeof b.markable === "boolean" &&
    (next === null || (typeof next?.key === "string" && typeof next.label === "string" && typeof next.kind === "string" && (next.in_ms === null || isNumber(next.in_ms))))
  );
}

/** Whose song Now Playing shows: a playing source over a paused one, and Spotify over Segue when both are equal. */
export function pickSource(spotify: Playback, segue: SegueNow | null): "spotify" | "segue" | null {
  const [hasSpotify, hasSegue] = [spotify.current !== null, !!segue?.key];
  if (hasSpotify && !spotify.paused) return "spotify";
  if (hasSegue && segue!.playing) return "segue";
  if (hasSpotify) return "spotify";
  return hasSegue ? "segue" : null;
}

/**
 * A Segue `play` event as a play of a library song. It counts as a listen from 30 s, like Spotify's, and as a skip
 * when it was cut short by skipping or starting a new radio before then (Spotify's forward-button rule). Anything else
 * shorter, such as quitting early, is neither, and null; so is a song not in the library.
 */
export function parseSegue(value: unknown, ids: ReadonlyMap<string, string>): Play | null {
  const e = value as Partial<Extract<SegueEvent, { type: "play" }>> | null;
  if (e?.type !== "play" || typeof e.key !== "string" || typeof e.at !== "string" || !isNumber(e.heard)) return null;
  const isrc = e.key.toUpperCase();
  const trackId = ids.get(isrc);
  const at = segueTime(e.at);
  if (!trackId || Number.isNaN(at)) return null;
  const play: Play = { trackId, at, msPlayed: Math.round(e.heard * 1000), isrc, source: "segue" };
  const skipped = (e.ended === "skip" || e.ended === "radio") && !isListen(play);
  return isListen(play) || skipped ? { ...play, skipped } : null;
}

export type SegueContext = { recent: string[]; rediscover: string[]; skip_rate: Record<string, number> };

const DAY_MS = 24 * 3600_000;
const REDISCOVER = 100;
const MIN_PLAYS_FOR_RATE = 4;

/**
 * What Segue's walk steers by, keyed by ISRC: songs listened to in the last day (`heard`: live Spotify plays and Segue
 * plays), Revisit's Rediscover list, and the share of each song's plays that were skips once it has a few.
 */
export function segueContext(plays: ReadonlyMap<string, SongPlays>, tracks: Library["tracks"], heard: readonly Play[], now: Date): SegueContext {
  const isrcOf = (id: string) => tracks[id]?.isrc ?? null;
  const since = now.getTime() - DAY_MS;
  const recent = new Set(heard.filter((p) => p.at >= since && isListen(p)).flatMap((p) => isrcOf(p.trackId) ?? p.isrc ?? []));
  const skip_rate: Record<string, number> = {};
  for (const [id, { plays: listens, skips }] of plays) {
    const isrc = isrcOf(id);
    if (isrc && !(isrc in skip_rate) && listens + skips >= MIN_PLAYS_FOR_RATE) skip_rate[isrc] = skips / (listens + skips);
  }
  const loved = rediscover(plays, new Set(Object.keys(tracks)), now).flatMap((r) => isrcOf(r.id) ?? []);
  return { recent: [...recent], rediscover: [...new Set(loved)].slice(0, REDISCOVER), skip_rate };
}
