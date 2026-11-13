// How often each library song has been played, from two sources: the plays the host records live
// (data/listening-history.jsonl, see src/host/history.ts) and Spotify's Extended Streaming History export.
// `pnpm plays` joins them into data/plays.json, which the app reads with `decodePlays`.
import type { Merge } from "./dedupe.ts";

/** "both" is a live play matched to its export row: the export's numbers with the live row's context. */
export type PlaySource = "live" | "export" | "both";

export type Play = {
  trackId: string;
  /** Epoch ms. Live: Spotify's `played_at`. Export: `ts`, when the play ended. */
  at: number;
  /** Export only; a live play has no length, but Spotify only reports plays past ~30 s. */
  msPlayed?: number;
  /** Export only: Spotify's own skip flag. Kept, but `isListen` decides what counts. */
  skipped?: boolean;
  /** Live only: the playlist, album or artist URI the play came from. */
  context?: string;
  /** Live only: the track's length, which bounds when its export row can end. */
  durationMs?: number;
  /** Live only: identifies the recording across its releases, see `otherReleases`. */
  isrc?: string;
  source: PlaySource;
};

/**
 * What counts as a listen: 30 s, where Spotify counts a stream and the shortest play the live endpoint reports, so a
 * play counts the same from either source. Shorter export rows are skips. Spotify's `skipped` flag isn't used: it's
 * also set on plays cut short after minutes, which were heard.
 */
export const LISTEN_MS = 30_000;

/**
 * How far an export row's `ts` may fall outside its live play's `played_at`..`played_at + duration` and still be the
 * same play. A guess: confirm it on the days both sources cover once the export arrives (issue #1, part 2).
 */
export const MATCH_TOLERANCE_MS = 2 * 60_000;

export const isListen = (play: Play) => (play.msPlayed ?? LISTEN_MS) >= LISTEN_MS;

type LiveRow = { played_at?: unknown; track?: { id?: unknown; duration_ms?: unknown; external_ids?: { isrc?: unknown } | null } | null; context?: { uri?: unknown } | null };

/** One line of data/listening-history.jsonl, parsed. Null for anything that isn't a play of a track with an id (local files have none). */
export function parseLive(value: unknown): Play | null {
  const row = value as LiveRow | null;
  const id = row?.track?.id;
  const at = typeof row?.played_at === "string" ? Date.parse(row.played_at) : NaN;
  if (typeof id !== "string" || Number.isNaN(at)) return null;
  const duration = row?.track?.duration_ms;
  const context = row?.context?.uri;
  const isrc = row?.track?.external_ids?.isrc;
  return {
    trackId: id,
    at,
    ...(typeof duration === "number" && { durationMs: duration }),
    ...(typeof context === "string" && { context }),
    ...(typeof isrc === "string" && { isrc: isrc.toUpperCase() }),
    source: "live",
  };
}

type ExportRow = { ts?: unknown; ms_played?: unknown; spotify_track_uri?: unknown; skipped?: unknown };

const TRACK_URI = "spotify:track:";

/** One row of a `Streaming_History_Audio_*.json` file. Null for podcasts, audiobooks and local files, which have no track URI. */
export function parseExport(value: unknown): Play | null {
  const row = value as ExportRow | null;
  const uri = row?.spotify_track_uri;
  const at = typeof row?.ts === "string" ? Date.parse(row.ts) : NaN;
  if (typeof uri !== "string" || !uri.startsWith(TRACK_URI) || Number.isNaN(at) || typeof row?.ms_played !== "number") return null;
  return {
    trackId: uri.slice(TRACK_URI.length),
    at,
    msPlayed: row.ms_played,
    ...(typeof row.skipped === "boolean" && { skipped: row.skipped }),
    source: "export",
  };
}

/**
 * A song played from a release that isn't saved (its single, the album cut, a reissue) is the saved song with the
 * same ISRC. Returns those releases as merges for `resolveMerges`. Only live plays carry an ISRC, so an export row
 * is credited only for a release the host has also recorded.
 */
export function otherReleases(live: readonly Play[], tracks: Readonly<Record<string, { isrc: string | null }>>): Pick<Merge, "main" | "copies">[] {
  const saved = new Map<string, string>();
  for (const [id, track] of Object.entries(tracks)) if (track.isrc && !saved.has(track.isrc)) saved.set(track.isrc, id);
  const mainOf = new Map<string, string>();
  for (const play of live) {
    const main = play.isrc && saved.get(play.isrc);
    if (main && !(play.trackId in tracks)) mainOf.set(play.trackId, main);
  }
  return [...mainOf].map(([copy, main]) => ({ main, copies: [copy] }));
}

/** Credits plays of a copy `pnpm merge-copies` replaced to the copy it kept, following merges of merges. On a conflict the later merge wins. */
export function resolveMerges(plays: readonly Play[], merges: readonly Pick<Merge, "main" | "copies">[]): Play[] {
  const keptFor = new Map(merges.flatMap((m) => m.copies.map((copy) => [copy, m.main] as const)));
  const kept = (id: string) => {
    const seen = new Set<string>();
    for (let next = keptFor.get(id); next !== undefined && !seen.has(next); next = keptFor.get(id)) {
      seen.add(next);
      id = next;
    }
    return id;
  };
  return plays.map((play) => ({ ...play, trackId: kept(play.trackId) }));
}

/**
 * Joins live and export plays without counting a play twice on the days both cover. Per track, in time order, each
 * live play takes the first unmatched export row that ended inside its window (preferring one long enough to be a
 * listen, since the live endpoint never reports shorter ones). Going in order keeps a song on repeat from pairing a
 * play with its neighbour's row. Returns every play, in time order, and how many live plays were found in the export.
 */
export function joinPlays(live: readonly Play[], exported: readonly Play[]): { plays: Play[]; matched: number } {
  const byTrack = new Map<string, Play[]>();
  for (const row of [...exported].sort((a, b) => a.at - b.at)) {
    const rows = byTrack.get(row.trackId);
    if (rows) rows.push(row);
    else byTrack.set(row.trackId, [row]);
  }
  const taken = new Set<Play>();
  const joined: Play[] = [];
  for (const play of [...live].sort((a, b) => a.at - b.at)) {
    const start = play.at - MATCH_TOLERANCE_MS;
    const end = play.at + (play.durationMs ?? 0) + MATCH_TOLERANCE_MS;
    const open = (byTrack.get(play.trackId) ?? []).filter((row) => !taken.has(row) && row.at >= start && row.at <= end);
    const row = open.find(isListen) ?? open[0];
    if (!row) {
      joined.push(play);
      continue;
    }
    taken.add(row);
    joined.push({ ...row, ...(play.context !== undefined && { context: play.context }), source: "both" });
  }
  const unmatched = exported.filter((row) => !taken.has(row));
  return { plays: [...joined, ...unmatched].sort((a, b) => a.at - b.at), matched: taken.size };
}

export type SongPlays = { plays: number; skips: number; last: string };

/** data/plays.json: per library track id its listens, skips, and when it last played (ISO, listen or skip). `from`/`to` span every play read. */
export type PlaysFile = {
  generatedAt: string;
  from: string | null;
  to: string | null;
  songs: Record<string, [plays: number, skips: number, last: string]>;
};

const iso = (ms: number) => new Date(ms).toISOString();

/** Counts plays per library song. Plays of songs not in the library are left out of `songs` and counted in `outside`. */
export function playsFile(plays: readonly Play[], library: Readonly<Record<string, unknown>>, generatedAt: Date): { file: PlaysFile; outside: number } {
  const songs: PlaysFile["songs"] = {};
  let outside = 0;
  const sorted = [...plays].sort((a, b) => a.at - b.at);
  for (const play of sorted) {
    if (!(play.trackId in library)) {
      outside++;
      continue;
    }
    const [listens, skips] = songs[play.trackId] ?? [0, 0];
    songs[play.trackId] = isListen(play) ? [listens + 1, skips, iso(play.at)] : [listens, skips + 1, iso(play.at)];
  }
  const [first, last] = [sorted[0], sorted.at(-1)];
  return {
    file: {
      generatedAt: generatedAt.toISOString(),
      from: first ? iso(first.at) : null,
      to: last ? iso(last.at) : null,
      songs,
    },
    outside,
  };
}

export const decodePlays = (file: PlaysFile): ReadonlyMap<string, SongPlays> =>
  new Map(Object.entries(file.songs).map(([id, [plays, skips, last]]) => [id, { plays, skips, last }]));
