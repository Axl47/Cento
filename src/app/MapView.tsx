// Full-size sound map with a playlist legend (hover to preview, click to highlight several at once), song
// search, a card for the selected song with how it compares to the library, and bridges: start one from the
// selected song, and the next song chosen is where it ends.
import { useEffect, useMemo, useState } from "react";
import { firstAdded, inbox, sortTargets } from "../core/library.ts";
import { BridgePanel } from "./BridgePanel.tsx";
import { SongEvidence } from "./SongEvidence.tsx";
import { SoundMap, type MapScene } from "./SoundMap.tsx";
import { usePlayer } from "./player.ts";
import { useApp } from "./store.ts";
import { useTitle } from "./useTitle.ts";
import { useBridge } from "./useBridge.ts";
import { useHoverIntent } from "./useHoverIntent.ts";

export function MapView({ colors, onSortSong }: { colors: Map<string, string>; onSortSong: (id: string) => void }) {
  const { lib, audio, hidden, uncounted } = useApp();
  const title = useTitle();
  const play = usePlayer((s) => s.play);
  const [highlight, setHighlight] = useState<string[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [from, setFrom] = useState(""); // yyyy-mm-dd; empty means no limit on that side
  const [to, setTo] = useState("");
  const [height, setHeight] = useState(() => Math.max(window.innerHeight - 140, 420));
  const [mark, setMark] = useState<string | null>(null); // song hovered beside the map, pointed out on it
  const legendHover = useHoverIntent<string>();
  const bridge = useBridge();

  useEffect(() => {
    const onResize = () => setHeight(Math.max(window.innerHeight - 140, 420));
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.metaKey || e.ctrlKey) return;
      if (e.key === "Escape") return bridge.from ? bridge.close() : setSelected(null);
      if (e.key.toLowerCase() === "b" && selected && !bridge.from) bridge.start(selected);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const legend = useMemo(() => {
    if (!lib || !audio) return [];
    const has = new Set(audio.ids);
    return sortTargets(lib, hidden)
      .map((p) => ({ p, n: p.trackIds.filter((id) => has.has(id)).length }))
      .filter((x) => x.n > 0)
      .sort((a, b) => b.n - a.n);
  }, [lib, audio, hidden]);

  const dates = useMemo(() => (lib ? firstAdded(lib) : new Map<string, string>()), [lib]);
  const only = useMemo(() => {
    if (!from && !to) return null;
    return new Set(
      (audio?.ids ?? []).filter((id) => {
        const day = dates.get(id)?.slice(0, 10);
        return day !== undefined && (!from || day >= from) && (!to || day <= to);
      }),
    );
  }, [audio, dates, from, to]);
  const undated = useMemo(() => (audio?.ids ?? []).filter((id) => !dates.has(id)).length, [audio, dates]);

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
  const inInbox = selected ? inbox(lib, hidden, uncounted).some((l) => l.id === selected) : false;

  const playlistsOf = (id: string) => sortTargets(lib).filter((p) => p.trackIds.includes(id));

  const scene: MapScene = bridge.from
    ? { kind: "bridge", ids: bridge.ids.length > 0 ? bridge.ids : [bridge.from] }
    : selected
      ? { kind: "song", id: selected }
      : { kind: "overview" };
  // A click on the map or a search result: the end of a bridge being started, else the song to look at.
  const choose = (id: string) => {
    if (bridge.picking) bridge.finish(id);
    else if (!bridge.from) setSelected(id);
  };
  const hoveredPlaylist = legendHover.current;
  const shown = hoveredPlaylist && !highlight.includes(hoveredPlaylist) ? [...highlight, hoveredPlaylist] : highlight;

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_340px]">
      <div className="relative min-w-0">
        <SoundMap audio={audio} lib={lib} colors={colors} height={height} scene={scene} highlight={shown} only={only} mark={mark} onSelect={choose} colorable />
        {bridge.picking && (
          <p className="pointer-events-none absolute left-1/2 top-3 -translate-x-1/2 rounded-full bg-zinc-950/90 px-3 py-1.5 text-xs text-zinc-100 shadow-xl">
            Click the song to bridge to · <kbd>Esc</kbd> cancels
          </p>
        )}
      </div>

      <aside className="space-y-4 lg:max-h-[max(calc(100vh-140px),420px)] lg:overflow-y-auto lg:pr-1">
        {bridge.to ? (
          <BridgePanel key={`${bridge.from}-${bridge.to}`} bridge={bridge} onMark={setMark} />
        ) : (
          <>
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
                  onClick={() => (choose(t!.id), setQuery(""))}
                  className="block w-full truncate px-3 py-2 text-left text-sm text-zinc-200 hover:bg-white/10"
                >
                  {t!.name} <span className="text-zinc-500">· {t!.artists[0]?.name}</span>
                </button>
              ))}
            </div>
          )}
        </div>

        {bridge.picking && (
          <div className="flex items-center gap-2 rounded-lg bg-zinc-900 p-3 text-sm text-zinc-300">
            <span className="min-w-0 flex-1">
              Bridging from <b className="font-semibold text-zinc-50">{bridge.from && title(bridge.from, lib.tracks[bridge.from]?.name ?? "")}</b>. Choose where it ends on the map or by searching.
            </span>
            <button className="btn" onClick={bridge.close}>
              Cancel
            </button>
          </div>
        )}

        {track && !bridge.from && (
          <div className="space-y-2 rounded-lg bg-zinc-900 p-3">
            <div className="flex gap-3">
              {track.album.imageUrl && <img src={track.album.imageUrl} alt="" className="size-14 rounded-md object-cover" />}
              <div className="min-w-0">
                <div className="truncate font-semibold text-zinc-100">{title(track.id, track.name)}</div>
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
            <div className="flex flex-wrap gap-2">
              <button className="btn flex-1" onClick={() => void play(track.id, track.durationMs)}>
                Play
              </button>
              <button className="btn flex-1 whitespace-nowrap" onClick={() => bridge.start(track.id)} title="Then choose the song it ends on (B)">
                Bridge from here
              </button>
              {inInbox && (
                <button className="btn flex-1 whitespace-nowrap bg-emerald-500 text-emerald-950 hover:bg-emerald-400" onClick={() => onSortSong(track.id)}>
                  Sort now
                </button>
              )}
            </div>
          </div>
        )}

        {track && !bridge.from && <SongEvidence track={track} playlistId={hoveredPlaylist ?? (highlight.length === 1 ? highlight[0]! : null)} colors={colors} mark={mark} onMark={setMark} />}

        <div>
          <div className="mb-1.5 flex items-center justify-between text-xs uppercase tracking-wider text-zinc-500">
            <span>Added between</span>
            {only && (
              <button className="normal-case text-zinc-300 hover:text-white" onClick={() => (setFrom(""), setTo(""))}>
                clear
              </button>
            )}
          </div>
          <div className="grid grid-cols-2 gap-2">
            {([["From", from, setFrom], ["To", to, setTo]] as const).map(([label, value, set]) => (
              <input
                key={label}
                type="date"
                aria-label={`Added ${label.toLowerCase()}`}
                value={value}
                onChange={(e) => set(e.target.value)}
                className="w-full rounded-lg border border-white/10 bg-zinc-900 px-2 py-1.5 text-xs text-zinc-100 [color-scheme:dark] focus:border-white/30 focus:outline-none"
              />
            ))}
          </div>
          {only && (
            <p className="mt-1.5 text-xs text-zinc-500">
              {only.size.toLocaleString()} songs in range
              {undated > 0 && ` · ${undated.toLocaleString()} have no date until you resync`}
            </p>
          )}
        </div>

        <div>
          <div className="mb-1.5 flex items-center justify-between text-xs uppercase tracking-wider text-zinc-500">
            <span>Playlists</span>
            {highlight.length > 0 && (
              <button className="normal-case text-zinc-300 hover:text-white" onClick={() => setHighlight([])}>
                clear
              </button>
            )}
          </div>
          <div className="space-y-0.5">
            {legend.map(({ p, n }) => (
              <button
                key={p.id}
                onClick={() => setHighlight((h) => (h.includes(p.id) ? h.filter((x) => x !== p.id) : [...h, p.id]))}
                onMouseEnter={() => legendHover.hover(p.id)}
                onMouseLeave={() => legendHover.hover(null)}
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
        <p className="text-[11px] text-zinc-500">Scroll to zoom, drag to pan. Zoomed out shows where each playlist's songs concentrate; zoom in for songs. Click playlists to compare them. Esc clears the selected song.</p>
          </>
        )}
      </aside>
    </div>
  );
}
