// What songs and playlists are about, read from their lyrics: every song is scored against a list of
// written themes. These are hints for a person deciding, shown with the passages behind them, and never
// feed the ranking. Pure code, shared by `pnpm lyrics` and the app.
import type { Library, Playlist, Track } from "./library.ts";
import type { LyricIndex } from "./lyrics.ts";

/** Edit freely, then run `pnpm lyrics`. Each is matched by meaning, in any language. */
export const THEMES = [
  "sadness and melancholy",
  "heartbreak after a breakup",
  "missing someone far away",
  "grief over a death",
  "loneliness and isolation",
  "depression and feeling empty",
  "anxiety and overthinking",
  "self-hatred and feeling worthless",
  "suicidal thoughts and wanting to disappear",
  "anger and rage",
  "revenge and betrayal",
  "jealousy",
  "falling in love",
  "devotion to a partner",
  "sexual desire and seduction",
  "a toxic relationship",
  "regret and guilt",
  "nostalgia for the past",
  "hope and optimism",
  "joy and feeling happy",
  "confidence and self-empowerment",
  "bragging about money and success",
  "fame and the music industry",
  "partying and dancing all night",
  "drinking and drugs",
  "addiction",
  "friendship and loyalty",
  "family and parents",
  "home and homeland",
  "faith, god and religion",
  "death and mortality",
  "war and battle",
  "fighting and never giving up",
  "freedom and escaping",
  "dreams and fantasy worlds",
  "nature and the sea",
  "summer and the beach",
  "street life and crime",
  "social criticism and politics",
  "video games and fantasy adventures",
];

/** One song's reading; `scores` and `best` are parallel to `ThemeData.themes`. */
export type ThemeSong = {
  /** ISRC, or the track id if it has none. */
  key: string;
  passages: string[];
  /** How strongly the song carries each theme, in standard deviations from songs in the same language. */
  scores: number[];
  /** For each theme, the index in `passages` that shows it best. */
  best: number[];
};

export type ThemeData = { themes: string[]; songs: ThemeSong[] };

export type ThemeIndex = { themes: string[]; songs: Map<string, ThemeSong> };

export const themeIndex = (data: ThemeData): ThemeIndex => ({ themes: data.themes, songs: new Map(data.songs.map((s) => [s.key, s])) });

/** A song's score for a theme averages its closest passages, so one stray line can't carry it. */
const PASSAGES_PER_THEME = 3;
/** Languages with fewer labelled songs are standardized together. */
const MIN_LANGUAGE_SONGS = 100;

/**
 * Scores every song in the index against the theme vectors (`themes.length` rows of `index.dim`, end to end).
 * Each theme is standardized within a language, because the model scores some languages higher across the board.
 */
export function scoreThemes(
  index: LyricIndex,
  themeVectors: Float32Array,
  themes: string[],
  languageOf: (key: string) => string | undefined,
  minLanguageSongs = MIN_LANGUAGE_SONGS,
): ThemeData {
  const { dim, vectors } = index;
  const rowsOf = new Map<string, number[]>();
  index.keys.forEach((key, row) => {
    const rows = rowsOf.get(key);
    if (rows) rows.push(row);
    else rowsOf.set(key, [row]);
  });

  const songs = [...rowsOf].map(([key, rows]) => {
    const scores: number[] = [];
    const best: number[] = [];
    themes.forEach((_, t) => {
      const sims = rows.map((row, passage) => {
        let sim = 0;
        for (let d = 0; d < dim; d++) sim += vectors[row * dim + d]! * themeVectors[t * dim + d]!;
        return { sim, passage };
      });
      const top = sims.sort((a, b) => b.sim - a.sim).slice(0, PASSAGES_PER_THEME);
      scores.push(top.reduce((sum, s) => sum + s.sim, 0) / top.length);
      best.push(top[0]!.passage);
    });
    return { key, passages: rows.map((row) => index.passages[row]!), scores, best };
  });

  const labelled = new Map<string, number>();
  for (const { key } of songs) {
    const language = languageOf(key);
    if (language) labelled.set(language, (labelled.get(language) ?? 0) + 1);
  }
  const groups = new Map<string, typeof songs>();
  for (const song of songs) {
    const language = languageOf(song.key);
    const name = language && labelled.get(language)! >= minLanguageSongs ? language : "other";
    groups.set(name, [...(groups.get(name) ?? []), song]);
  }
  for (const group of groups.values())
    themes.forEach((_, t) => {
      const mean = group.reduce((sum, s) => sum + s.scores[t]!, 0) / group.length;
      const spread = Math.sqrt(group.reduce((sum, s) => sum + (s.scores[t]! - mean) ** 2, 0) / group.length) || 1;
      for (const s of group) s.scores[t] = Math.round(((s.scores[t]! - mean) / spread) * 100) / 100;
    });
  return { themes, songs };
}

const songOf = (index: ThemeIndex, track: Track) => index.songs.get(track.isrc ?? track.id);

export type ThemeMatch = { theme: number; name: string; score: number; passage: string };

/** A song stands out on a theme from here: with this many themes, most songs top 2 somewhere by chance. */
const SONG_MIN_SCORE = 2.5;
const SONG_THEMES = 2;

const matchOf = (index: ThemeIndex, song: ThemeSong, theme: number): ThemeMatch => ({
  theme,
  name: index.themes[theme]!,
  score: song.scores[theme]!,
  passage: song.passages[song.best[theme]!]!,
});

/** The themes a song clearly carries, strongest first, with the passage behind each. Empty if none stand out. */
export function songThemes(index: ThemeIndex, track: Track): ThemeMatch[] {
  const song = songOf(index, track);
  if (!song) return [];
  return index.themes
    .map((_, theme) => matchOf(index, song, theme))
    .filter((m) => m.score >= SONG_MIN_SCORE)
    .sort((a, b) => b.score - a.score)
    .slice(0, SONG_THEMES);
}

export type Member = { track: Track; song: ThemeSong };

export type PlaylistReading = {
  /** Songs in the playlist with lyrics we could read, one per song however many releases it has. */
  members: Member[];
  songCount: number;
  /** Themes that stand out from the library, strongest first; `strength` is the members' mean score. */
  clear: { theme: number; name: string; strength: number }[];
};

/** A playlist's mean on one theme varies by about 1/√songs by chance; the largest of many themes and playlists reaches ~3.5x that. */
const NOISE_MULTIPLE = 3.5;
/** Large playlists clear the noise easily, so this keeps tiny leanings from being called a theme. */
const MIN_STRENGTH = 0.2;
const MIN_MEMBERS = 8;
const MAX_THEMES = 6;

export function readPlaylist(index: ThemeIndex, lib: Library, playlist: Pick<Playlist, "trackIds">): PlaylistReading {
  const bySong = new Map<string, Member>();
  const ids = new Set(playlist.trackIds);
  for (const id of ids) {
    const track = lib.tracks[id];
    const song = track && songOf(index, track);
    if (track && song && !bySong.has(song.key)) bySong.set(song.key, { track, song });
  }
  const members = [...bySong.values()];
  const songCount = ids.size;
  if (members.length < MIN_MEMBERS) return { members, songCount, clear: [] };

  const floor = Math.max(MIN_STRENGTH, NOISE_MULTIPLE / Math.sqrt(members.length));
  const clear = index.themes
    .map((name, theme) => ({ theme, name, strength: members.reduce((sum, m) => sum + m.song.scores[theme]!, 0) / members.length }))
    .filter((t) => t.strength >= floor)
    .sort((a, b) => b.strength - a.strength)
    .slice(0, MAX_THEMES);
  return { members, songCount, clear };
}

/** The members that show a theme best, spread across artists before repeating one. */
export function themeExamples(index: ThemeIndex, reading: PlaylistReading, theme: number, limit: number) {
  const ranked = reading.members.toSorted((a, b) => b.song.scores[theme]! - a.song.scores[theme]!);
  const artists = new Set<string | undefined>();
  const spread = ranked.filter((m) => {
    const fresh = !artists.has(m.track.artists[0]?.id);
    artists.add(m.track.artists[0]?.id);
    return fresh;
  });
  const picked = [...spread, ...ranked.filter((m) => !spread.includes(m))].slice(0, limit);
  return picked.map((m) => ({ track: m.track, ...matchOf(index, m.song, theme) }));
}

/** About the top 7% of songs on a theme. Lower, and a song about summer "shares" a playlist's darkest theme. */
const SHARED_MIN_SCORE = 1.5;

/** Which of a playlist's clear themes one song also carries, for "this song shares…" beside a suggestion. */
export function sharedThemes(reading: PlaylistReading, index: ThemeIndex, track: Track) {
  const song = songOf(index, track);
  return song ? reading.clear.filter((t) => song.scores[t.theme]! >= SHARED_MIN_SCORE) : [];
}
