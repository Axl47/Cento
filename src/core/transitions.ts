// What makes the user skip the next song, measured on shuffle, where the next song is picked at random from the
// playlist: a song's fit with what came before can't have chosen it, so comparing the same song after close and
// distant songs isolates the effect of the transition. `pnpm transitions` prints the results; pure code.
import { LISTEN_MS } from "./plays.ts";
import type { ExportPlay } from "./skips.ts";

/** One song coming up on its own after another on shuffle, and whether the user skipped it. */
export type Seam = {
  from: string;
  to: string;
  skipped: boolean;
  /** The song before was skipped too: the user was already looking for something else. */
  afterSkip: boolean;
  /** Up to `RECENT` songs listened to in this session before `to`, oldest first, ending with `from` when it was listened to. */
  recent: string[];
};

/** A pause longer than this, or a change of device, starts a new session. */
export const SESSION_GAP_MS = 30 * 60_000;
/** How far one play's end may be from the next one's start for the second to have followed the first (crossfade, buffering). */
export const FOLLOW_MS = 15_000;
export const RECENT = 5;

const isSkip = (play: ExportPlay) => play.reasonEnd === "fwdbtn" && play.msPlayed < LISTEN_MS;

/**
 * The seams in time-ordered plays where the second song came up by itself on shuffle: after the first played through,
 * or after the user skipped the first. A song that was neither skipped nor listened to (playback stopped) is left out.
 */
export function shuffleSeams(plays: readonly ExportPlay[]): Seam[] {
  const seams: Seam[] = [];
  let recent: string[] = [];
  for (let i = 1; i < plays.length; i++) {
    const [a, b] = [plays[i - 1]!, plays[i]!];
    const gap = b.at - b.msPlayed - a.at;
    if (gap > SESSION_GAP_MS || a.device !== b.device) recent = [];
    if (a.msPlayed >= LISTEN_MS) recent = [...recent, a.trackId].slice(-RECENT);
    if (Math.abs(gap) > FOLLOW_MS || !a.shuffle || !b.shuffle || a.trackId === b.trackId) continue;
    const afterListen = a.reasonEnd === "trackdone" && b.reasonStart === "trackdone";
    const afterSkip = isSkip(a) && b.reasonStart === "fwdbtn";
    if (!afterListen && !afterSkip) continue;
    if (!isSkip(b) && b.msPlayed < LISTEN_MS) continue;
    seams.push({ from: a.trackId, to: b.trackId, skipped: isSkip(b), afterSkip, recent });
  }
  return seams;
}

export type Rate = { skips: number; n: number };
export const rate = ({ skips, n }: Rate) => (n ? skips / n : 0);

/**
 * Compares each song with itself: splits a song's seams at its own median `distance` and pools the closer and farther
 * halves across songs (seams at the median, and songs with fewer than `minPerSong` measured seams, are left out). How
 * likely a song is to be skipped at all cancels out, leaving the effect of the distance.
 */
export function withinSong<S extends { to: string; skipped: boolean }>(seams: readonly S[], distance: (seam: S) => number | null, minPerSong: number) {
  const bySong = new Map<string, { d: number; skipped: boolean }[]>();
  for (const seam of seams) {
    const d = distance(seam);
    if (d === null) continue;
    const list = bySong.get(seam.to);
    if (list) list.push({ d, skipped: seam.skipped });
    else bySong.set(seam.to, [{ d, skipped: seam.skipped }]);
  }
  const close: Rate = { skips: 0, n: 0 };
  const far: Rate = { skips: 0, n: 0 };
  let songs = 0;
  for (const list of bySong.values()) {
    if (list.length < minPerSong) continue;
    songs++;
    const median = list.map((s) => s.d).sort((x, y) => x - y)[list.length >> 1]!;
    for (const { d, skipped } of list) {
      const half = d < median ? close : d > median ? far : null;
      if (!half) continue;
      half.n++;
      if (skipped) half.skips++;
    }
  }
  return { close, far, songs };
}

/** Difference of two skip rates and its 95% margin, in percentage points. */
export function difference(close: Rate, far: Rate): { points: number; margin: number } {
  const [p, q] = [rate(close), rate(far)];
  const se = Math.sqrt((p * (1 - p)) / (close.n || 1) + (q * (1 - q)) / (far.n || 1));
  return { points: (q - p) * 100, margin: 1.96 * se * 100 };
}

/**
 * How much the song itself matters: each song's seams split in time, songs ranked by how often they were skipped in
 * the earlier half, and the later skip rate of the fifth skipped least against the fifth skipped most.
 */
export function songPersistence(seams: readonly Seam[], minPerSong: number): { least: Rate; most: Rate; songs: number } {
  const bySong = new Map<string, boolean[]>();
  for (const s of seams) {
    const list = bySong.get(s.to);
    if (list) list.push(s.skipped);
    else bySong.set(s.to, [s.skipped]);
  }
  const count = (xs: boolean[]): Rate => ({ skips: xs.filter(Boolean).length, n: xs.length });
  const halves = [...bySong.values()]
    .filter((xs) => xs.length >= minPerSong)
    .map((xs) => [count(xs.slice(0, xs.length >> 1)), count(xs.slice(xs.length >> 1))] as const)
    .sort((x, y) => rate(x[0]) - rate(y[0]));
  const fifth = Math.floor(halves.length / 5);
  const pool = (hs: typeof halves): Rate => hs.reduce((t, [, later]) => ({ skips: t.skips + later.skips, n: t.n + later.n }), { skips: 0, n: 0 });
  return { least: pool(halves.slice(0, fifth)), most: pool(halves.slice(halves.length - fifth)), songs: halves.length };
}
