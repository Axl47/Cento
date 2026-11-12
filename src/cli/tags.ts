// Builds data/tags.json: each library song's likeliest genres and its moods, for describing groups of songs.
//
//   pnpm tags
//
// Reads Stemma's per-song tags (TAGS_FILE, default ~/.cache/audio-embed-engine/tags/tags.jsonl, written by its
// bench/tags.py from the stored sound vectors) and keeps the top genres and the moods that tell playlists apart,
// keyed by library track id. Exits quietly when that file doesn't exist, so the daily refresh can always run it.
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { MOODS, type TagsFile } from "../core/tags.ts";

const OUT = "data/tags.json";
const TOP_GENRES = 5;
const source = process.env.TAGS_FILE ?? join(homedir(), ".cache/audio-embed-engine/tags/tags.jsonl");

if (!existsSync(source)) {
  console.log(`${OUT}: skipped, no ${source}`);
  process.exit(0);
}

type EngineTags = { key: string; genre_discogs400: [label: string, p: number][] } & Record<(typeof MOODS)[number], number>;

const lines = async <T>(path: string) => (await readFile(path, "utf8")).split("\n").filter(Boolean).map((l) => JSON.parse(l) as T);
const round2 = (x: number) => Math.round(x * 100) / 100;

const byKey = new Map((await lines<EngineTags>(source)).map((t) => [t.key, t]));
const genres = new Map<string, number>();
const file: TagsFile = { genres: [], moods: [...MOODS], songs: {} };
// The engine names a song by its ISRC, or by its Spotify id when it has none.
const tracks = await lines<{ key: string; isrc: string | null }>("data/tracks.jsonl");
for (const t of tracks) {
  const tags = byKey.get(t.isrc?.toUpperCase() ?? t.key);
  if (!tags) continue;
  const top = tags.genre_discogs400.slice(0, TOP_GENRES);
  file.songs[t.key] = [
    // "Hip Hop---Trap" -> "Trap": the style says enough.
    top.map(([label]) => {
      const name = label.split("---").at(-1)!;
      if (!genres.has(name)) genres.set(name, file.genres.push(name) - 1);
      return genres.get(name)!;
    }),
    top.map(([, p]) => round2(p)),
    MOODS.map((mood) => round2(tags[mood])),
  ];
}
const json = JSON.stringify(file);
await writeFile(OUT, json);
console.log(`${OUT}: ${Object.keys(file.songs).length} of ${tracks.length} songs, ${file.genres.length} genres, ${Math.round(json.length / 1024)} KB`);
