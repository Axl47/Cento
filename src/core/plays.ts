// How often each library song has been played, from two sources: the plays the host records live
// (data/listening-history.jsonl, see src/host/history.ts) and Spotify's Extended Streaming History export.
// `pnpm plays` joins them into data/plays.json, which the app reads with `decodePlays`.
import type { Merge } from "./dedupe.ts";

/** "both" is a live play matched to its export row: the export's numbers with the live row's context. */
export type PlaySource = "live" | "export" | "both";

export type Play = {
  trackId: string;
  /** Epoch ms, when the play ended: Spotify's `played_at` live, `ts` in the export. */
  at: number;
  /** Export only; a live play has no length, but Spotify only reports plays past ~30 s. */
  msPlayed?: number;
  /** Export only: Spotify's own skip flag. Kept, but `isListen` decides what counts. */
  skipped?: boolean;
  /** Live only: the playlist, album or artist URI the play came from. */
  context?: string;
  /** Live only: identifies the recording across its releases, see `otherReleases`. */
  isrc?: string;
  /** Export only: `songKey` of the title and album artist, which is all the export says about what the id was. */
  song?: string;
  /** Export only: whether shuffle was on. */
  shuffle?: boolean;
  source: PlaySource;
};

/**
 * What counts as a listen: 30 s, where Spotify counts a stream and the shortest play the live endpoint reports, so a
 * play counts the same from either source. Shorter export rows are skips. Spotify's `skipped` flag isn't used: it's
 * also set on plays cut short after minutes, which were heard.
 */
export const LISTEN_MS = 30_000;

/**
 * How far an export row's `ts` may be from its live play's `played_at`. They are the same moment, with `ts` cut to
 * the second: on the 175 plays both sources had in November 2026, every row was within a second.
 */
export const MATCH_TOLERANCE_MS = 5_000;

export const isListen = (play: Play) => (play.msPlayed ?? LISTEN_MS) >= LISTEN_MS;

type LiveRow = { played_at?: unknown; track?: { id?: unknown; external_ids?: { isrc?: unknown } | null } | null; context?: { uri?: unknown } | null };

/** One line of data/listening-history.jsonl, parsed. Null for anything that isn't a play of a track with an id (local files have none). */
export function parseLive(value: unknown): Play | null {
  const row = value as LiveRow | null;
  const id = row?.track?.id;
  const at = typeof row?.played_at === "string" ? Date.parse(row.played_at) : NaN;
  if (typeof id !== "string" || Number.isNaN(at)) return null;
  const context = row?.context?.uri;
  const isrc = row?.track?.external_ids?.isrc;
  return {
    trackId: id,
    at,
    ...(typeof context === "string" && { context }),
    ...(typeof isrc === "string" && { isrc: isrc.toUpperCase() }),
    source: "live",
  };
}

type ExportRow = {
  ts?: unknown;
  ms_played?: unknown;
  spotify_track_uri?: unknown;
  skipped?: unknown;
  shuffle?: unknown;
  master_metadata_track_name?: unknown;
  master_metadata_album_artist_name?: unknown;
};

/** Names a song by its title and first artist, for matching a play to a saved song when the ids differ. */
export const songKey = (title: string, artist: string) => `${title}\n${artist}`.toLowerCase();

const TRACK_URI = "spotify:track:";

/** One row of a `Streaming_History_Audio_*.json` file. Null for podcasts, audiobooks and local files, which have no track URI. */
export function parseExport(value: unknown): Play | null {
  const row = value as ExportRow | null;
  const uri = row?.spotify_track_uri;
  const at = typeof row?.ts === "string" ? Date.parse(row.ts) : NaN;
  if (typeof uri !== "string" || !uri.startsWith(TRACK_URI) || Number.isNaN(at) || typeof row?.ms_played !== "number") return null;
  const [title, artist] = [row.master_metadata_track_name, row.master_metadata_album_artist_name];
  return {
    trackId: uri.slice(TRACK_URI.length),
    at,
    msPlayed: row.ms_played,
    ...(typeof row.skipped === "boolean" && { skipped: row.skipped }),
    ...(typeof row.shuffle === "boolean" && { shuffle: row.shuffle }),
    ...(typeof title === "string" && typeof artist === "string" && { song: songKey(title, artist) }),
    source: "export",
  };
}

/**
 * A song played from a release that isn't saved (its single, the album cut, a reissue) is the saved song: the one
 * with the same ISRC for a live play, the one with the same title and first artist for an export row, which has no
 * ISRC. A title two saved songs share matches neither. Returns those releases as merges for `resolveMerges`.
 */
export function otherReleases(
  plays: readonly Play[],
  tracks: Readonly<Record<string, { isrc: string | null; name: string; artists: readonly { name: string }[] }>>,
): Pick<Merge, "main" | "copies">[] {
  const byIsrc = new Map<string, string>();
  const bySong = new Map<string, string | null>();
  for (const [id, track] of Object.entries(tracks)) {
    if (track.isrc && !byIsrc.has(track.isrc)) byIsrc.set(track.isrc, id);
    const song = songKey(track.name, track.artists[0]?.name ?? "");
    bySong.set(song, bySong.has(song) ? null : id);
  }
  const mainOf = new Map<string, string>();
  for (const play of plays) {
    if (play.trackId in tracks || mainOf.has(play.trackId)) continue;
    const main = (play.isrc && byIsrc.get(play.isrc)) || (play.song && bySong.get(play.song));
    if (main) mainOf.set(play.trackId, main);
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
 * Joins live and export plays without counting a play twice on the days both cover: per track, in time order, each
 * live play takes the first unmatched export row that ended when it did. Returns every play, in time order, and how
 * many live plays were found in the export.
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
    const row = byTrack.get(play.trackId)?.find((r) => !taken.has(r) && Math.abs(r.at - play.at) <= MATCH_TOLERANCE_MS);
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

/** One calendar year (UTC) of a song's plays. `shuffled` counts listens and skips with shuffle on. */
export type YearPlays = { year: number; plays: number; skips: number; shuffled: number };

/** One calendar year of every library song's plays, for comparing a song with how skippy that year was overall. */
export type YearTotals = YearPlays & { shuffledSkips: number };

export type SongPlays = { plays: number; skips: number; last: string; years: readonly YearPlays[] };

/**
 * data/plays.json: per library track id its listens, skips, when it last played (ISO, listen or skip), and the same
 * counts per year as `[year, listens, skips, shuffled]`. `years` totals every library song per year, as
 * `[year, listens, skips, shuffled, shuffledSkips]`. `from`/`to` span every play read. Files from before the per-year
 * counts lack both; they decode with no years.
 */
export type PlaysFile = {
  generatedAt: string;
  from: string | null;
  to: string | null;
  songs: Record<string, [plays: number, skips: number, last: string, years?: [year: number, plays: number, skips: number, shuffled: number][]]>;
  years?: [year: number, plays: number, skips: number, shuffled: number, shuffledSkips: number][];
};

const iso = (ms: number) => new Date(ms).toISOString();

/** Counts plays per library song, overall and per year. Plays of songs not in the library are left out of `songs` and counted in `outside`. */
export function playsFile(plays: readonly Play[], library: Readonly<Record<string, unknown>>, generatedAt: Date): { file: PlaysFile; outside: number } {
  const songs: PlaysFile["songs"] = {};
  const totals = new Map<number, NonNullable<PlaysFile["years"]>[number]>();
  let outside = 0;
  const sorted = [...plays].sort((a, b) => a.at - b.at);
  for (const play of sorted) {
    if (!(play.trackId in library)) {
      outside++;
      continue;
    }
    const listen = isListen(play);
    const [listens, skips, , years = []] = songs[play.trackId] ?? [0, 0, ""];
    const year = new Date(play.at).getUTCFullYear();
    // Plays come in time order, so a song's current year is always its last.
    let row = years.at(-1);
    if (row?.[0] !== year) years.push((row = [year, 0, 0, 0]));
    row[listen ? 1 : 2]++;
    if (play.shuffle) row[3]++;
    songs[play.trackId] = [listens + (listen ? 1 : 0), skips + (listen ? 0 : 1), iso(play.at), years];

    const total = totals.get(year) ?? [year, 0, 0, 0, 0];
    totals.set(year, total);
    total[listen ? 1 : 2]++;
    if (play.shuffle) {
      total[3]++;
      if (!listen) total[4]++;
    }
  }
  const [first, last] = [sorted[0], sorted.at(-1)];
  return {
    file: {
      generatedAt: generatedAt.toISOString(),
      from: first ? iso(first.at) : null,
      to: last ? iso(last.at) : null,
      songs,
      years: [...totals.values()],
    },
    outside,
  };
}

export const decodePlays = (file: PlaysFile): ReadonlyMap<string, SongPlays> =>
  new Map(
    Object.entries(file.songs).map(([id, [plays, skips, last, years = []]]) => [
      id,
      { plays, skips, last, years: years.map(([year, plays, skips, shuffled]) => ({ year, plays, skips, shuffled })) },
    ]),
  );

/** The library's per-year totals from data/plays.json, oldest first; empty for files without them. */
export const decodeYearTotals = (file: PlaysFile): readonly YearTotals[] =>
  (file.years ?? []).map(([year, plays, skips, shuffled, shuffledSkips]) => ({ year, plays, skips, shuffled, shuffledSkips }));
