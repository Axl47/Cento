// Full-size sound map with a playlist legend (click to highlight, several at once), song search, and a
// card for the selected song.
import { useEffect, useMemo, useState } from "react";
import { inbox, sortTargets } from "../core/library.ts";
import { SoundMap } from "./SoundMap.tsx";
import { usePlayer } from "./player.ts";
import { useApp } from "./store.ts";

export function MapView({ colors, onSortSong }: { colors: Map<string, string>; onSortSong: (id: string) => void }) {
  const { lib, audio, hidden } = useApp();
  const play = usePlayer((s) => s.play);
  const [highlight, setHighlight] = useState<string[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [height, setHeight] = useState(() => Math.max(window.innerHeight - 140, 420));

  useEffect(() => {
    const onResize = () => setHeight(Math.max(window.innerHeight - 140, 420));
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const legend = useMemo(() => {
    if (!lib || !audio) return [];
    const has = new Set(audio.ids);
    return sortTargets(lib, hidden)
      .map((p) => ({ p, n: p.trackIds.filter((id) => has.has(id)).length }))
      .filter((x) => x.n > 0)
      .sort((a, b) => b.n - a.n);
  }, [lib, audio, hidden]);

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q || !lib || !audio) return [];
    return audio.ids
      .map((id) => lib.tracks[id])
      .filter((t) => t && `${t.name} ${t.artists.map((a) => a.name).join(" ")}`.toLowerCase().includes(q))
      .slice(0, 8);
  }, [query, lib, audio]);

  if (!lib) return null;
  if (!audio)
    return (
      <div className="rounded-xl border border-dashed border-white/15 p-10 text-center text-zinc-400">
        The sound map needs audio embeddings. Once the embedding engine has processed your library, run{" "}
        <code>pnpm audio</code> and reload.
      </div>
    );

  const track = selected ? lib.tracks[selected] : undefined;
  const inInbox = selected ? inbox(lib, hidden).some((l) => l.id === selected) : false;

  const playlistsOf = (id: string) => sortTargets(lib).filter((p) => p.trackIds.includes(id));

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_280px]">
      <div className="overflow-hidden rounded-xl border border-white/10 bg-zinc-950">
        <SoundMap
          audio={audio}
          lib={lib}
          colors={colors}
          height={height}
          focusId={selected}
          highlight={highlight}
          onSelect={setSelected}
        />
      </div>

      <aside className="space-y-4">
        <div className="relative">
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === "Escape" && setQuery("")}
            placeholder="Find a song…"
            className="w-full rounded-lg border border-white/10 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-500 focus:border-white/30 focus:outline-none"
          />
          {results.length > 0 && (
            <div className="absolute z-20 mt-1 w-full overflow-hidden rounded-lg border border-white/10 bg-zinc-900 shadow-xl">
              {results.map((t) => (
                <button
                  key={t!.id}
                  onClick={() => (setSelected(t!.id), setQuery(""))}
                  className="block w-full truncate px-3 py-2 text-left text-sm text-zinc-200 hover:bg-white/10"
                >
                  {t!.name} <span className="text-zinc-500">· {t!.artists[0]?.name}</span>
                </button>
              ))}
            </div>
          )}
        </div>

        {track && (
          <div className="space-y-2 rounded-xl border border-white/10 bg-zinc-900/60 p-3">
            <div className="flex gap-3">
              {track.album.imageUrl && <img src={track.album.imageUrl} alt="" className="size-14 rounded-md object-cover" />}
              <div className="min-w-0">
                <div className="truncate font-semibold text-zinc-100">{track.name}</div>
                <div className="truncate text-sm text-zinc-400">{track.artists.map((a) => a.name).join(", ")}</div>
              </div>
            </div>
            <div className="flex flex-wrap gap-1">
              {playlistsOf(track.id).map((p) => (
                <span key={p.id} className="rounded px-1.5 py-0.5 text-[11px] text-zinc-950" style={{ background: colors.get(p.id) }}>
                  {p.name}
                </span>
              ))}
              {playlistsOf(track.id).length === 0 && <span className="text-xs text-zinc-500">Not sorted yet</span>}
            </div>
            <div className="flex gap-2">
              <button className="btn flex-1" onClick={() => void play(track.id, track.durationMs)}>
                Play
              </button>
              {inInbox && (
                <button className="btn flex-1 bg-emerald-500 text-emerald-950 hover:bg-emerald-400" onClick={() => onSortSong(track.id)}>
                  Sort now
                </button>
              )}
            </div>
          </div>
        )}

        <div>
          <div className="mb-1.5 flex items-center justify-between text-xs uppercase tracking-wider text-zinc-500">
            <span>Playlists</span>
            {highlight.length > 0 && (
              <button className="normal-case text-zinc-300 hover:text-white" onClick={() => setHighlight([])}>
                clear
              </button>
            )}
          </div>
          <div className="max-h-[calc(100vh-380px)] min-h-48 space-y-0.5 overflow-y-auto pr-1">
            {legend.map(({ p, n }) => (
              <button
                key={p.id}
                onClick={() => setHighlight((h) => (h.includes(p.id) ? h.filter((x) => x !== p.id) : [...h, p.id]))}
                className={`flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-sm ${
                  highlight.includes(p.id) ? "bg-white/10 text-zinc-50" : "text-zinc-300 hover:bg-white/5"
                }`}
              >
                <span className="size-2.5 shrink-0 rounded-full" style={{ background: colors.get(p.id) }} />
                <span className="min-w-0 flex-1 truncate">{p.name}</span>
                <span className="font-mono text-xs text-zinc-500">{n}</span>
              </button>
            ))}
            <div className="flex items-center gap-2 px-2 py-1 text-sm text-zinc-500">
              <span className="size-2.5 rounded-full bg-zinc-500" /> Unsorted
            </div>
          </div>
        </div>
        <p className="text-[11px] text-zinc-500">Scroll to zoom, drag to pan. Zoomed out shows where each playlist's songs concentrate; zoom in for songs. Click playlists to compare them.</p>
      </aside>
    </div>
  );
}
