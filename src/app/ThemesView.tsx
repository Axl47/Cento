// What each playlist's lyrics are about: the themes that stand out from the rest of the library, each
// with the passages that show it, so the claim can be checked by reading them. Also the songs that
// sound like a playlist but say something else, for cleaning one up.
import { useMemo, useState } from "react";
import type { Track } from "../core/library.ts";
import { sortTargets } from "../core/library.ts";
import { LINE_BREAK } from "../core/lyrics.ts";
import { readPlaylist, soundWithoutMeaning, themeExamples } from "../core/themes.ts";
import { openInSpotify, usePlayer } from "./player.ts";
import { useApp } from "./store.ts";
import { useTitle } from "./useTitle.ts";

const EXAMPLES = 3;
const MISMATCHES = 8;
/** A theme this strong fills its bar, on every playlist, so bars compare across playlists. */
const FULL_BAR = 1.5;

export function ThemesView({ colors }: { colors: Map<string, string> }) {
  const { lib, themes, classifier } = useApp();
  const [selected, setSelected] = useState<string | null>(null);
  const readings = useMemo(
    () =>
      lib && themes
        ? sortTargets(lib)
            .map((playlist) => ({ playlist, reading: readPlaylist(themes, lib, playlist) }))
            .filter((r) => r.reading.members.length > 0)
        : [],
    [lib, themes],
  );
  const current = readings.find((r) => r.playlist.id === selected) ?? readings[0];

  if (!themes || !current)
    return <p className="px-2 py-3 text-sm text-zinc-500">Loading… If this stays, run `pnpm lyrics` and reload.</p>;

  const { playlist, reading } = current;
  const color = colors.get(playlist.id) ?? "#a092ab";
  const mismatches = soundWithoutMeaning(themes, reading, (t) => classifier?.score(t.id, playlist.id), MISMATCHES);
  return (
    <div className="grid gap-8 lg:grid-cols-[300px_minmax(0,1fr)]">
      <nav className="space-y-0.5 lg:max-h-[calc(100vh-6rem)] lg:overflow-y-auto lg:pr-2">
        {readings.map((r) => (
          <button
            key={r.playlist.id}
            onClick={() => setSelected(r.playlist.id)}
            className={`block w-full rounded-md px-2.5 py-1.5 text-left ${r === current ? "bg-white/10" : "hover:bg-white/5"}`}
          >
            <span className="flex items-center gap-2 text-sm text-zinc-100">
              <span className="size-2 shrink-0 rounded-full" style={{ background: colors.get(r.playlist.id) }} />
              <span className="truncate">{r.playlist.name}</span>
            </span>
            <span className="ml-4 block truncate text-xs text-zinc-500">{r.reading.clear[0]?.name ?? "No clear theme"}</span>
          </button>
        ))}
      </nav>

      <main className="min-w-0 max-w-3xl">
        <h2 className="text-2xl font-extrabold tracking-tight text-zinc-50">{playlist.name}</h2>
        <p className="mt-1 text-xs text-zinc-400">
          Read from the {reading.members.length} of {reading.songCount} songs with lyrics. Each theme is compared with your whole library, within the song's language.
        </p>

        {reading.clear.length === 0 && (
          <p className="mt-5 text-sm text-zinc-300">
            No theme stands out from the rest of your library, so what holds this playlist together is probably its sound or language rather than what the songs say.
          </p>
        )}
        <div className="mt-5 space-y-1">
          {reading.clear.map((t, i) => (
            <details key={`${playlist.id}:${t.theme}`} open={i === 0} className="rounded-lg px-2 py-1.5 open:bg-white/[0.03]">
              <summary className="flex cursor-pointer list-none items-center gap-3">
                <span className="w-64 shrink-0 truncate text-sm font-medium text-zinc-100">{t.name}</span>
                <span className="h-1.5 flex-1 rounded-full bg-white/10" title={`${t.strength.toFixed(2)} standard deviations above a typical song in your library`}>
                  <span className="block h-full rounded-full" style={{ width: `${Math.min(t.strength / FULL_BAR, 1) * 100}%`, background: color }} />
                </span>
              </summary>
              <div className="mt-2 space-y-1">
                {themeExamples(themes, reading, t.theme, EXAMPLES).map((e) => (
                  <SongPassage key={e.track.id} track={e.track} passage={e.passage} />
                ))}
              </div>
            </details>
          ))}
        </div>

        {mismatches.length > 0 && (
          <section className="mt-8 border-t border-white/10 pt-5">
            <h3 className="text-sm font-bold text-zinc-50">Sounds right, says something else</h3>
            <p className="mt-1 text-xs text-zinc-400">Songs here that sound like the playlist, but whose lyrics are far from its themes. Worth a listen when cleaning up.</p>
            <div className="mt-2 space-y-1">
              {mismatches.map((m) => (
                <SongPassage key={m.track.id} track={m.track} passage={m.instead.passage} note={`Reads more like ${m.instead.name}`} />
              ))}
            </div>
          </section>
        )}
      </main>
    </div>
  );
}

function SongPassage({ track, passage, note }: { track: Track; passage: string; note?: string }) {
  const title = useTitle();
  const player = usePlayer();
  return (
    <article className="flex gap-3 rounded-lg px-2 py-2">
      {track.album.imageUrl ? (
        <img src={track.album.imageUrl} alt="" className="size-10 shrink-0 rounded" />
      ) : (
        <div className="size-10 shrink-0 rounded bg-zinc-800" />
      )}
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <h3 className="truncate text-sm font-semibold text-zinc-100">{title(track.id, track.name)}</h3>
          <span className="truncate text-xs text-zinc-400">{track.artists.map((a) => a.name).join(", ")}</span>
        </div>
        {note && <p className="mt-0.5 text-xs text-zinc-300">{note}</p>}
        <p className="mt-1 whitespace-pre-line text-[13px] leading-snug text-zinc-400">{passage.split(LINE_BREAK).join("\n")}</p>
      </div>
      <button className="btn h-fit shrink-0" onClick={() => (player.enabled ? void player.play(track.id, track.durationMs) : openInSpotify(track.id))}>
        Play
      </button>
    </article>
  );
}
