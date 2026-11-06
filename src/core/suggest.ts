// Playlist suggestions learned from how songs are already sorted. Three signals:
//   artist   share of the artist's other sorted songs in each playlist
//   audio    playlists of the song's nearest sorted neighbors by sound (optional)
//   pairing  playlists that usually go with the ones already picked for this song
// plus artist rules you set: a playlist with a rule is suggested (at the top, prechecked)
// only for songs by one of its artists, and never for anything else. Hidden playlists are
// left out entirely: never suggested, and not learned from.
import { PRECHECK } from "./config.ts";
import { sortTargets, type Library, type Track } from "./library.ts";

const ARTIST_SMOOTHING = 1; // pseudo-songs pulling sparse artist counts toward the prior
const AUDIO_NEIGHBORS = 15; // sorted neighbors that vote

/** Nearest tracks by sound, most similar first. `sim` is cosine similarity. */
export type Neighbors = (trackId: string) => { id: string; sim: number }[];

/** playlistId -> artists whose songs belong there (any of them matches). */
export type ArtistRules = Record<string, { id: string; name: string }[]>;

export type Model = {
  playlistIds: string[];
  /** playlistId -> artist ids, for playlists with a non-empty rule */
  rules: Map<string, Set<string>>;
  /** trackId -> sort-target playlist ids it is in (training songs only) */
  membership: Map<string, string[]>;
  prior: Map<string, number>;
  artistSongs: Map<string, Set<string>>;
  /** pair.get(r)?.get(p) = P(song in p | song in r) */
  pair: Map<string, Map<string, number>>;
};

export type Suggestion = {
  playlistId: string;
  score: number;
  /** Weighted contributions; they sum to `score`. */
  parts: { rule: number; artist: number; audio: number; pairing: number; prior: number };
};

/** Learns from sort-target memberships. Pass `trainIds` to hold songs out (evaluation). */
export function buildModel(
  lib: Library,
  { rules = {}, hidden = [], trainIds }: { rules?: ArtistRules; hidden?: readonly string[]; trainIds?: Set<string> } = {},
): Model {
  const targets = sortTargets(lib, hidden);

  const membership = new Map<string, string[]>();
  for (const p of targets)
    for (const id of p.trackIds)
      if (!trainIds || trainIds.has(id)) membership.set(id, [...(membership.get(id) ?? []), p.id]);

  const size = new Map<string, number>();
  const co = new Map<string, Map<string, number>>();
  const artistSongs = new Map<string, Set<string>>();
  for (const [id, ms] of membership) {
    for (const r of ms) {
      size.set(r, (size.get(r) ?? 0) + 1);
      const row = co.get(r) ?? new Map<string, number>();
      for (const p of ms) if (p !== r) row.set(p, (row.get(p) ?? 0) + 1);
      co.set(r, row);
    }
    for (const a of lib.tracks[id]?.artists ?? []) {
      const songs = artistSongs.get(a.id) ?? new Set<string>();
      songs.add(id);
      artistSongs.set(a.id, songs);
    }
  }

  const total = [...size.values()].reduce((s, x) => s + x, 0) || 1;
  const pair = new Map(
    [...co].map(([r, row]) => [r, new Map([...row].map(([p, c]) => [p, c / (size.get(r) ?? 1)]))] as const),
  );
  const playlistIds = targets.map((p) => p.id);
  return {
    playlistIds,
    rules: new Map(
      Object.entries(rules)
        .filter(([p, artists]) => artists.length > 0 && playlistIds.includes(p))
        .map(([p, artists]) => [p, new Set(artists.map((a) => a.id))]),
    ),
    membership,
    prior: new Map(playlistIds.map((p) => [p, (size.get(p) ?? 0) / total])),
    artistSongs,
    pair,
  };
}

/** Number of sorted songs sharing an artist with `track` (excluding itself). */
export function knownArtistSongs(model: Model, track: Track): Set<string> {
  const songs = new Set<string>();
  for (const a of track.artists) for (const s of model.artistSongs.get(a.id) ?? []) if (s !== track.id) songs.add(s);
  return songs;
}

/** Ranks every sort target for `track`, given playlists already picked for it. */
export function suggest(model: Model, track: Track, picked: string[] = [], neighbors?: Neighbors): Suggestion[] {
  const share = (songs: Iterable<string>, weight: (id: string) => number = () => 1) => {
    const counts = new Map<string, number>();
    let n = 0;
    for (const s of songs) {
      const w = weight(s);
      n += w;
      for (const p of model.membership.get(s) ?? []) counts.set(p, (counts.get(p) ?? 0) + w);
    }
    return { counts, n };
  };

  const artist = share(knownArtistSongs(model, track));
  const artistScore = (p: string) =>
    (( artist.counts.get(p) ?? 0) + ARTIST_SMOOTHING * (model.prior.get(p) ?? 0)) / (artist.n + ARTIST_SMOOTHING);

  const near = (neighbors?.(track.id) ?? [])
    .filter((x) => x.id !== track.id && model.membership.has(x.id))
    .slice(0, AUDIO_NEIGHBORS);
  const simOf = new Map(near.map((x) => [x.id, Math.max(x.sim, 0)]));
  const audio = share(simOf.keys(), (id) => simOf.get(id) ?? 0);

  const pairingScore = (p: string) => Math.max(0, ...picked.map((r) => model.pair.get(r)?.get(p) ?? 0));

  // Artist overlap is trusted more the more of the artist's songs we've seen; the rest of
  // the weight goes to audio and pairing (whichever are available), else to the prior.
  const wArtist = artist.n / (artist.n + 2);
  const wAudio = audio.n > 0 ? 1 : 0;
  const wPairing = picked.length > 0 ? 1 : 0;
  const others = wAudio + wPairing;

  const ruleMatches = (p: string) => track.artists.some((a) => model.rules.get(p)?.has(a.id));
  const none = { rule: 0, artist: 0, audio: 0, pairing: 0, prior: 0 };

  return model.playlistIds
    .filter((p) => !model.rules.has(p) || ruleMatches(p))
    .map((p) => {
      if (model.rules.has(p)) return { playlistId: p, score: 1, parts: { ...none, rule: 1 } };
      const rest = 1 - wArtist;
      const parts = {
        rule: 0,
        artist: wArtist * artistScore(p),
        audio: others ? (rest * wAudio * ((audio.counts.get(p) ?? 0) / (audio.n || 1))) / others : 0,
        pairing: others ? (rest * wPairing * pairingScore(p)) / others : 0,
        prior: others ? 0 : rest * (model.prior.get(p) ?? 0),
      };
      return { playlistId: p, score: parts.artist + parts.audio + parts.pairing + parts.prior, parts };
    })
    .sort((a, b) => b.score - a.score);
}

/**
 * Playlists to check automatically: artist-rule matches always; learned suggestions only for
 * artists you've sorted before (with audio as the only evidence, prechecks were right ~35% of
 * the time at any useful cutoff; see `pnpm eval`).
 */
export function prechecked(model: Model, track: Track, suggestions: Suggestion[]): string[] {
  const known = knownArtistSongs(model, track).size > 0;
  return suggestions.filter((s) => s.parts.rule > 0 || (known && s.score >= PRECHECK)).map((s) => s.playlistId);
}
