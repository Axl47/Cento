// Sonic bridges: pick two songs and get a list that travels gradually from one to the other. It lives
// here until you save it, so a bridge can be listened to and adjusted before it becomes a playlist.
import { useEffect, useMemo, useState } from "react";
import { buildBridge, hops, type Candidate } from "../core/bridge.ts";
import type { Track } from "../core/library.ts";
import { SoundMap } from "./SoundMap.tsx";
import { openInSpotify, usePlayer } from "./player.ts";
import { useApp } from "./store.ts";

const MIN_LENGTH = 5;
const MAX_LENGTH = 40;
const MATCHES = 8;
/** How long before a song ends the next one is started, to cover the round trip to Spotify. */
const ADVANCE_EARLY_MS = 300;

export function BridgesView({ colors }: { colors: Map<string, string> }) {
  const { lib, audio, vectors, saveBridge } = useApp();
  const player = usePlayer();
  const [from, setFrom] = useState<string | null>(null);
  const [to, setTo] = useState<string | null>(null);
  const [length, setLength] = useState(12);
  const [replaced, setReplaced] = useState<string[]>([]); // songs taken out of this bridge
  const [listening, setListening] = useState(false); // playing through the list, rather than one song
  const [savedAs, setSavedAs] = useState<string | null>(null);
  const [mark, setMark] = useState<string | null>(null);

  // One release per song, and only songs with sound vectors.
  const candidates = useMemo(() => {
    const seen = new Set<string>();
    return (audio?.ids ?? []).flatMap((id): (Candidate & { track: Track })[] => {
      const track = lib?.tracks[id];
      if (!track) return [];
      const key = `${track.name}|${track.artists[0]?.id}`;
      if (seen.has(key)) return [];
      seen.add(key);
      return [{ id, artist: track.artists[0]?.id, track }];
    });
  }, [audio, lib]);
  const byId = useMemo(() => new Map(candidates.map((c) => [c.id, c])), [candidates]);

  const ends = from && to && from !== to ? ([byId.get(from), byId.get(to)] as const) : null;
  const ids = useMemo(() => {
    if (!ends?.[0] || !ends[1] || !audio || !vectors) return [];
    return buildBridge(audio, vectors, ends[0], ends[1], length, candidates.filter((c) => !replaced.includes(c.id)));
  }, [ends?.[0], ends?.[1], audio, vectors, length, candidates, replaced]); // eslint-disable-line react-hooks/exhaustive-deps
  const steps = useMemo(() => (audio && vectors ? hops(audio, vectors, ids) : []), [audio, vectors, ids]);
  const shown = useMemo(() => new Set(ids), [ids]);

  useEffect(() => setSavedAs(null), [ids]);

  // Spotify can't be handed this list as a queue from here, so the next song is started as each one ends.
  const nowAt = player.trackId ? ids.indexOf(player.trackId) : -1;
  const following = listening && nowAt >= 0 && !player.paused ? lib?.tracks[ids[nowAt + 1] ?? ""] : undefined;
  useEffect(() => {
    if (!following) return;
    const left = player.duration - player.position - (performance.now() - player.updatedAt);
    const timer = setTimeout(() => void player.play(following.id, following.durationMs, 0), Math.max(left - ADVANCE_EARLY_MS, 0));
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [following?.id, player.position, player.updatedAt, player.duration]);

  const choose = (set: (id: string | null) => void) => (id: string | null) => {
    set(id);
    setReplaced([]);
    setListening(false);
  };
  const playAt = (track: Track) => {
    if (!player.enabled) return openInSpotify(track.id);
    setListening(true);
    void player.play(track.id, track.durationMs, 0);
  };

  if (!lib || !audio) return <p className="px-2 py-3 text-sm text-zinc-500">Bridges need sound vectors. Run `pnpm audio` and reload.</p>;

  const first = lib.tracks[ids[0] ?? ""];
  const last = lib.tracks[ids.at(-1) ?? ""];
  const name = first && last ? `${first.name} → ${last.name}` : "";
  return (
    <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_minmax(380px,0.8fr)]">
      <main className="min-w-0">
        <div className="grid gap-3 sm:grid-cols-2">
          <SongPicker label="From" chosen={from} candidates={candidates} onChoose={choose(setFrom)} />
          <SongPicker label="To" chosen={to} candidates={candidates} onChoose={choose(setTo)} />
        </div>
        <label className="mt-4 flex items-center gap-3 text-xs text-zinc-400">
          Songs
          <input type="range" min={MIN_LENGTH} max={MAX_LENGTH} value={length} onChange={(e) => setLength(Number(e.target.value))} className="w-48" />
          <b className="font-semibold text-zinc-100">{length}</b>
        </label>

        {!vectors && <p className="mt-5 text-sm text-zinc-500">Loading the sound vectors…</p>}
        {vectors && ids.length === 0 && <p className="mt-5 text-sm text-zinc-500">Pick two different songs to build a bridge between them.</p>}

        {ids.length > 0 && (
          <>
            <div className="mt-5 flex flex-wrap items-center gap-3 text-xs text-zinc-400">
              <span>
                Biggest jump <b className="font-semibold text-zinc-100">{Math.round(Math.min(...steps) * 100)}%</b> alike · two random songs are about {Math.round(audio.baseline * 100)}%
              </span>
              <span className="ml-auto flex gap-2">
                {first && (
                  <button className="btn" onClick={() => playAt(first)}>
                    Play all
                  </button>
                )}
                <button
                  className="btn"
                  disabled={savedAs === name}
                  title="Creates a private playlist, hidden from sorting suggestions"
                  onClick={() => {
                    saveBridge(name, ids);
                    setSavedAs(name);
                  }}
                >
                  {savedAs === name ? "Saved" : "Save to Spotify"}
                </button>
              </span>
            </div>
            <ol className="mt-3">
              {ids.map((id, i) => {
                const track = lib.tracks[id];
                if (!track) return null;
                const isEnd = i === 0 || i === ids.length - 1;
                return (
                  <li key={id}>
                    {i > 0 && <p className="ml-[3.25rem] py-0.5 text-[11px] text-zinc-500">{Math.round(steps[i - 1]! * 100)}% alike</p>}
                    <div
                      onMouseEnter={() => setMark(id)}
                      onMouseLeave={() => setMark(null)}
                      className={`flex items-center gap-3 rounded-lg px-2 py-1.5 hover:bg-white/5 ${i === nowAt ? "bg-white/10" : ""}`}
                    >
                      <Cover track={track} />
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-sm font-semibold text-zinc-100">{track.name}</div>
                        <div className="truncate text-xs text-zinc-400">{track.artists.map((a) => a.name).join(", ")}</div>
                      </div>
                      <button className="btn" onClick={() => playAt(track)}>
                        Play
                      </button>
                      {!isEnd && (
                        <button className="btn" title="Take this song out and find another" onClick={() => setReplaced((r) => [...r, id])}>
                          Replace
                        </button>
                      )}
                    </div>
                  </li>
                );
              })}
            </ol>
          </>
        )}
      </main>

      <aside className="min-w-0">
        {ids.length > 0 && (
          <div className="sticky top-4 overflow-hidden rounded-lg bg-zinc-900">
            <SoundMap audio={audio} lib={lib} colors={colors} height={560} only={shown} mark={mark} onSelect={(id) => lib.tracks[id] && playAt(lib.tracks[id])} />
          </div>
        )}
      </aside>
    </div>
  );
}

function Cover({ track }: { track: Track }) {
  return track.album.imageUrl ? <img src={track.album.imageUrl} alt="" className="size-10 shrink-0 rounded" /> : <div className="size-10 shrink-0 rounded bg-zinc-800" />;
}

/** A search box that becomes the chosen song. */
function SongPicker({
  label,
  chosen,
  candidates,
  onChoose,
}: {
  label: string;
  chosen: string | null;
  candidates: (Candidate & { track: Track })[];
  onChoose: (id: string | null) => void;
}) {
  const [query, setQuery] = useState("");
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const matches = words.length
    ? candidates
        .filter(({ track }) => {
          const text = `${track.name} ${track.artists.map((a) => a.name).join(" ")}`.toLowerCase();
          return words.every((w) => text.includes(w));
        })
        .slice(0, MATCHES)
    : [];
  const track = candidates.find((c) => c.id === chosen)?.track;

  if (track)
    return (
      <div className="flex items-center gap-3 rounded-lg border border-white/10 bg-zinc-900 px-3 py-2">
        <Cover track={track} />
        <div className="min-w-0 flex-1">
          <div className="text-[11px] text-zinc-500">{label}</div>
          <div className="truncate text-sm font-semibold text-zinc-100">{track.name}</div>
          <div className="truncate text-xs text-zinc-400">{track.artists[0]?.name}</div>
        </div>
        <button className="btn" onClick={() => onChoose(null)}>
          Change
        </button>
      </div>
    );
  return (
    <div className="relative">
      <input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder={`${label}: search your library`}
        aria-label={`${label} song`}
        className="w-full rounded-lg border border-white/10 bg-zinc-900 px-4 py-2.5 text-sm text-zinc-50 placeholder:text-zinc-500 focus:border-white/30 focus:outline-none"
      />
      {matches.length > 0 && (
        <ul className="absolute z-10 mt-1 w-full overflow-hidden rounded-lg border border-white/10 bg-zinc-900 shadow-xl">
          {matches.map(({ id, track: t }) => (
            <li key={id}>
              <button
                className="block w-full truncate px-3 py-2 text-left text-sm text-zinc-100 hover:bg-white/10"
                onClick={() => {
                  onChoose(id);
                  setQuery("");
                }}
              >
                {t.name} <span className="text-xs text-zinc-400">{t.artists[0]?.name}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
