// Search songs by what their lyrics say: a remembered line, or a theme in any language. Each result
// shows the passage that matched, so it's easy to judge why the song came up.
import { useEffect, useMemo, useRef, useState } from "react";
import { sortTargets, type Track } from "../core/library.ts";
import { LINE_BREAK, type LyricHit } from "../core/lyrics.ts";
import { openInSpotify, usePlayer } from "./player.ts";
import { useApp } from "./store.ts";
import { useTitle } from "./useTitle.ts";

const DEBOUNCE_MS = 300;
const SHOWN = 60;

type Search =
  | { kind: "idle" }
  | { kind: "searching" }
  | { kind: "done"; hits: LyricHit[] }
  | { kind: "no-index" }
  | { kind: "error" };

export function LyricsView({ colors, onSortSong }: { colors: Map<string, string>; onSortSong: () => void }) {
  const { lib, queue, jumpTo } = useApp();
  const title = useTitle();
  const player = usePlayer();
  const [query, setQuery] = useState("");
  const [unsortedOnly, setUnsortedOnly] = useState(false);
  const [search, setSearch] = useState<Search>({ kind: "idle" });
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => inputRef.current?.focus(), []);

  useEffect(() => {
    const q = query.trim();
    if (!q) return setSearch({ kind: "idle" });
    setSearch({ kind: "searching" });
    const abort = new AbortController();
    const timer = setTimeout(() => {
      fetch(`/api/lyrics?q=${encodeURIComponent(q)}`, { signal: abort.signal })
        .then(async (res) => {
          if (res.status === 404) return setSearch({ kind: "no-index" });
          if (!res.ok) return setSearch({ kind: "error" });
          setSearch({ kind: "done", hits: (await res.json()) as LyricHit[] });
        })
        .catch((e: unknown) => {
          if (!abort.signal.aborted) {
            console.error(e);
            setSearch({ kind: "error" });
          }
        });
    }, DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      abort.abort();
    };
  }, [query]);

  const queued = useMemo(() => new Set(queue), [queue]);
  const tracksByKey = useMemo(() => {
    const map = new Map<string, Track[]>();
    for (const t of Object.values(lib?.tracks ?? {})) {
      const key = t.isrc ?? t.id;
      map.set(key, [...(map.get(key) ?? []), t]);
    }
    return map;
  }, [lib]);
  const playlistsOf = useMemo(() => {
    const map = new Map<string, { id: string; name: string }[]>();
    for (const p of sortTargets(lib ?? { playlists: [], liked: [], tracks: {}, fetchedAt: "", userId: "" }))
      for (const id of new Set(p.trackIds)) map.set(id, [...(map.get(id) ?? []), p]);
    return map;
  }, [lib]);

  const results = useMemo(() => {
    if (search.kind !== "done") return [];
    const seen = new Set<string>();
    const rows: { hit: LyricHit; track: Track; unsorted: boolean }[] = [];
    for (const hit of search.hits) {
      const releases = tracksByKey.get(hit.key) ?? [];
      // A song can have several Spotify releases: prefer the one waiting in the queue.
      const track = releases.find((t) => queued.has(t.id)) ?? releases[0];
      if (!track) continue;
      const dupe = `${track.name}|${track.artists[0]?.id}`;
      if (seen.has(dupe)) continue;
      seen.add(dupe);
      const unsorted = queued.has(track.id);
      if (!unsortedOnly || unsorted) rows.push({ hit, track, unsorted });
    }
    return rows.slice(0, SHOWN);
  }, [search, tracksByKey, queued, unsortedOnly]);

  return (
    <div className="mx-auto max-w-3xl">
      <div className="flex flex-wrap items-center gap-3">
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="A line you remember, or a theme: lonely in a big city, quiero volver a casa…"
          className="min-w-64 flex-1 rounded-lg border border-white/10 bg-zinc-900 px-4 py-2.5 text-[15px] text-zinc-50 placeholder:text-zinc-500 focus:border-white/30 focus:outline-none"
        />
        <label className="flex items-center gap-2 text-sm text-zinc-300">
          <input type="checkbox" checked={unsortedOnly} onChange={(e) => setUnsortedOnly(e.target.checked)} />
          Only unsorted
        </label>
      </div>

      <div className="mt-5 space-y-1">
        {search.kind === "idle" && <Note>Searches the lyrics of your library by meaning, across languages. Exact words come first.</Note>}
        {search.kind === "searching" && <Note>Searching… (the first search loads the model)</Note>}
        {search.kind === "no-index" && <Note>No lyric index yet. Run `pnpm lyrics`, then restart `pnpm dev`.</Note>}
        {search.kind === "error" && <Note>The search failed. See the `pnpm dev` output.</Note>}
        {search.kind === "done" && results.length === 0 && <Note>Nothing matches.</Note>}
        {results.map(({ hit, track, unsorted }) => (
          <article key={hit.key} className="flex gap-3 rounded-lg px-2 py-2.5 hover:bg-white/5">
            {track.album.imageUrl ? (
              <img src={track.album.imageUrl} alt="" className="size-12 shrink-0 rounded" />
            ) : (
              <div className="size-12 shrink-0 rounded bg-zinc-800" />
            )}
            <div className="min-w-0 flex-1">
              <div className="flex items-baseline gap-2">
                <h3 className="truncate text-sm font-semibold text-zinc-100">{title(track.id, track.name)}</h3>
                <span className="truncate text-xs text-zinc-400">{track.artists.map((a) => a.name).join(", ")}</span>
                {hit.exact && <span className="shrink-0 text-[11px] text-emerald-400">exact words</span>}
              </div>
              <p className="mt-1 whitespace-pre-line text-[13px] leading-snug text-zinc-400">{hit.passage.split(LINE_BREAK).join("\n")}</p>
              <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-zinc-500">
                {(playlistsOf.get(track.id) ?? []).slice(0, 4).map((p) => (
                  <span key={p.id} className="inline-flex items-center gap-1.5">
                    <span className="size-1.5 rounded-full" style={{ background: colors.get(p.id) }} />
                    {p.name}
                  </span>
                ))}
                {!playlistsOf.get(track.id) && <span>Not sorted yet</span>}
              </div>
            </div>
            <div className="flex shrink-0 flex-col gap-1">
              <button
                className="btn"
                onClick={() => (player.enabled ? void player.play(track.id, track.durationMs) : openInSpotify(track.id))}
              >
                Play
              </button>
              {unsorted && (
                <button
                  className="btn"
                  onClick={() => {
                    jumpTo(track.id);
                    onSortSong();
                  }}
                >
                  Sort
                </button>
              )}
            </div>
          </article>
        ))}
      </div>
    </div>
  );
}

function Note({ children }: { children: React.ReactNode }) {
  return <p className="px-2 py-3 text-sm text-zinc-500">{children}</p>;
}
