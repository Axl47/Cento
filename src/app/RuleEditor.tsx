// Dialog for a playlist's artist rule: "this playlist is for these artists". Artists come
// from your library (autocomplete, ranked by how many of your songs they're on), with
// quick picks for artists who dominate the playlist or are on the current song.
import { useEffect, useMemo, useRef, useState } from "react";
import type { Playlist, Track } from "../core/library.ts";
import type { ArtistRules } from "../core/suggest.ts";
import { useApp } from "./store.ts";

type Artist = ArtistRules[string][number];

/** Lowercase without accents, so "rauw" finds "Rauw Alejandro" and "bebe" finds "Bébé". */
const fold = (s: string) => s.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();

export function RuleEditor({ playlist, track, onClose }: { playlist: Playlist; track: Track | undefined; onClose: () => void }) {
  const { lib, rules, setRule } = useApp();
  const [draft, setDraft] = useState<Artist[]>(() => rules[playlist.id] ?? []);
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => inputRef.current?.focus(), []);

  // Every artist in the library with how many songs they're on.
  const artists = useMemo(() => {
    const byId = new Map<string, Artist & { songs: number }>();
    for (const t of Object.values(lib?.tracks ?? {}))
      for (const a of t.artists) {
        const e = byId.get(a.id) ?? { ...a, songs: 0 };
        e.songs++;
        byId.set(a.id, e);
      }
    return [...byId.values()].sort((a, b) => b.songs - a.songs);
  }, [lib]);

  const chosen = new Set(draft.map((a) => a.id));
  const add = (a: Artist) => {
    if (!chosen.has(a.id)) setDraft((d) => [...d, { id: a.id, name: a.name }]);
    setQuery("");
    setCursor(0);
    inputRef.current?.focus();
  };

  const results = useMemo(() => {
    const q = fold(query.trim());
    if (!q) return [];
    return artists
      .filter((a) => !chosen.has(a.id) && fold(a.name).includes(q))
      .sort((a, b) => Number(fold(b.name).startsWith(q)) - Number(fold(a.name).startsWith(q)) || b.songs - a.songs)
      .slice(0, 8);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, artists, draft]);

  // Artists on at least a quarter of the playlist, plus the current song's artists.
  const quickPicks = useMemo(() => {
    const counts = new Map<string, Artist & { n: number }>();
    for (const id of playlist.trackIds)
      for (const a of lib?.tracks[id]?.artists ?? []) {
        const e = counts.get(a.id) ?? { ...a, n: 0 };
        e.n++;
        counts.set(a.id, e);
      }
    const dominant = [...counts.values()]
      .filter((a) => a.n / Math.max(playlist.trackIds.length, 1) >= 0.25)
      .sort((a, b) => b.n - a.n)
      .slice(0, 4)
      .map((a) => ({ id: a.id, name: a.name, label: `${Math.round((a.n / playlist.trackIds.length) * 100)}% of playlist` }));
    const fromSong = (track?.artists ?? []).map((a) => ({ id: a.id, name: a.name, label: "this song" }));
    const seen = new Set<string>();
    return [...dominant, ...fromSong].filter((a) => !chosen.has(a.id) && !seen.has(a.id) && seen.add(a.id));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playlist, track, lib, draft]);

  // What the rule would cover.
  const coverage = useMemo(() => {
    if (!lib || draft.length === 0) return null;
    const matches = (id: string) => lib.tracks[id]?.artists.some((a) => chosen.has(a.id)) ?? false;
    return {
      library: Object.keys(lib.tracks).filter(matches).length,
      inPlaylist: playlist.trackIds.filter(matches).length,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lib, draft, playlist]);

  const save = () => {
    setRule(playlist.id, draft);
    onClose();
  };

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-4"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
      onKeyDown={(e) => {
        e.stopPropagation(); // keep the sort screen's shortcuts out of the dialog
        if (e.key === "Escape") onClose();
        if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) save();
      }}
    >
      <div role="dialog" aria-label={`Artists for ${playlist.name}`} className="w-full max-w-md space-y-4 rounded-2xl border border-white/10 bg-zinc-900 p-5 shadow-2xl">
        <div>
          <h2 className="text-base font-semibold text-zinc-50">Artists for “{playlist.name}”</h2>
          <p className="mt-1 text-xs leading-relaxed text-zinc-400">
            Songs by any of these artists get this playlist checked automatically. It won't be suggested for any other song,
            though you can still add one by hand through search.
          </p>
        </div>

        <div className="flex min-h-9 flex-wrap gap-1.5">
          {draft.map((a) => (
            <span key={a.id} className="inline-flex items-center gap-1 rounded-full bg-emerald-500/15 py-1 pl-3 pr-1 text-sm text-emerald-200">
              {a.name}
              <button
                onClick={() => setDraft((d) => d.filter((x) => x.id !== a.id))}
                className="grid size-5 place-items-center rounded-full text-emerald-300 hover:bg-white/10"
                aria-label={`Remove ${a.name}`}
              >
                ×
              </button>
            </span>
          ))}
          {draft.length === 0 && <span className="py-1 text-sm text-zinc-500">No artists yet: suggestions use your sorting history.</span>}
        </div>

        <div className="relative">
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => (setQuery(e.target.value), setCursor(0))}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") (e.preventDefault(), setCursor((c) => Math.min(c + 1, results.length - 1)));
              if (e.key === "ArrowUp") (e.preventDefault(), setCursor((c) => Math.max(c - 1, 0)));
              if (e.key === "Enter" && !e.metaKey && !e.ctrlKey && results[cursor]) (e.preventDefault(), add(results[cursor]));
              if (e.key === "Backspace" && !query && draft.length) setDraft((d) => d.slice(0, -1));
            }}
            placeholder="Add an artist from your library…"
            className="w-full rounded-lg border border-white/10 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-500 focus:border-white/30 focus:outline-none"
          />
          {results.length > 0 && (
            <div className="absolute z-10 mt-1 w-full overflow-hidden rounded-lg border border-white/10 bg-zinc-900 shadow-xl">
              {results.map((a, i) => (
                <button
                  key={a.id}
                  onMouseDown={(e) => (e.preventDefault(), add(a))}
                  onMouseEnter={() => setCursor(i)}
                  className={`flex w-full items-center justify-between px-3 py-2 text-left text-sm ${i === cursor ? "bg-white/10" : ""}`}
                >
                  <span className="text-zinc-100">{a.name}</span>
                  <span className="text-xs text-zinc-500">
                    {a.songs} song{a.songs > 1 ? "s" : ""}
                  </span>
                </button>
              ))}
            </div>
          )}
          {query.trim() && results.length === 0 && <p className="mt-1 text-xs text-zinc-500">No artist in your library matches.</p>}
        </div>

        {quickPicks.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5 text-xs">
            <span className="text-zinc-500">Suggested:</span>
            {quickPicks.map((a) => (
              <button key={a.id} onClick={() => add(a)} className="rounded-full border border-white/10 px-2.5 py-1 text-zinc-300 hover:border-white/30">
                + {a.name} <span className="text-zinc-500">· {a.label}</span>
              </button>
            ))}
          </div>
        )}

        {coverage && (
          <p className="text-xs text-zinc-400">
            Covers {coverage.inPlaylist} of this playlist's {playlist.trackIds.length} songs · {coverage.library} songs in your library
          </p>
        )}

        <div className="flex items-center justify-between gap-2 pt-1">
          {rules[playlist.id] ? (
            <button className="text-xs text-rose-400 hover:text-rose-300" onClick={() => (setRule(playlist.id, []), onClose())}>
              Remove rule
            </button>
          ) : (
            <span />
          )}
          <div className="flex gap-2">
            <button className="btn" onClick={onClose}>
              Cancel
            </button>
            <button className="btn bg-emerald-500 font-semibold text-emerald-950 hover:bg-emerald-400" onClick={save}>
              Save <kbd>⌘↵</kbd>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
