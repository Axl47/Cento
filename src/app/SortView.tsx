// The sorting screen: the current song, its ranked playlists as tiles (confident ones
// prechecked), the run of upcoming songs that would get the same picks, actions, and this
// session's sorts. The panel on the right explains the focused tile (hover or ↑↓).
import { useEffect, useMemo, useState } from "react";
import { sortTargets } from "../core/library.ts";
import { suggest, type Suggestion } from "../core/suggest.ts";
import { CommandPalette } from "./CommandPalette.tsx";
import { RuleEditor } from "./RuleEditor.tsx";
import { WhyPanel } from "./WhyPanel.tsx";
import { usePlayer } from "./player.ts";
import { initialPicks, useApp } from "./store.ts";

/** Tiles with a number key. */
const KEYED = 8;
/** How far ahead a run can reach. */
const MAX_RUN = 8;
/** Upcoming songs shown after the run. */
const UP_NEXT = 4;
const RECENT = 6;

const isTyping = (e: KeyboardEvent) => e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement;
const fmt = (ms: number) => `${Math.floor(ms / 60000)}:${String(Math.floor((ms % 60000) / 1000)).padStart(2, "0")}`;

export function SortView({ colors }: { colors: Map<string, string> }) {
  const { lib, model, neighbors, queue, picked, history, rules, hidden, togglePick, sort, skip, undo } = useApp();
  const player = usePlayer();
  const [ruleFor, setRuleFor] = useState<string | null>(null); // playlist whose artist rule is being edited
  const [palette, setPalette] = useState(false);
  // Both belong to one song; a new song starts with the top tile focused and the whole run in.
  const [focus, setFocus] = useState<{ track: string; playlist: string } | null>(null);
  const [excluded, setExcluded] = useState<{ track: string; ids: Set<string> } | null>(null);

  const trackId = queue[0];
  const track = trackId ? lib?.tracks[trackId] : undefined;
  const targets = useMemo(() => (lib ? sortTargets(lib) : []), [lib]);
  const byId = useMemo(() => new Map(targets.map((p) => [p.id, p])), [targets]);

  const suggestions = useMemo(
    () => (model && track ? suggest(model, track, picked, neighbors) : []),
    [model, track, picked, neighbors],
  );
  // Checked playlists first, then the best unchecked ones; number keys follow this order.
  // Picks the model doesn't suggest (hidden, or ruled out by an artist rule) still show, unscored.
  const rows = useMemo(() => {
    const checked = picked.map(
      (p): Suggestion =>
        suggestions.find((s) => s.playlistId === p) ?? { playlistId: p, score: 0, parts: { rule: 0, artist: 0, audio: 0, pairing: 0, prior: 0 } },
    );
    const rest = suggestions.filter((s) => !picked.includes(s.playlistId));
    return [...checked.toSorted((a, b) => b.score - a.score), ...rest.slice(0, Math.max(KEYED - checked.length, 2))];
  }, [suggestions, picked]);

  // A run: the songs right after this one that the model would precheck exactly the same way.
  // Prechecks only happen for artists you've sorted before, so a run is never sound alone.
  const run = useMemo(() => {
    if (!lib || !model || !trackId) return [];
    const key = (id: string) => initialPicks({ lib, model, neighbors }, id).toSorted().join();
    const mine = key(trackId);
    if (!mine) return [];
    const out: string[] = [];
    for (const id of queue.slice(1, 1 + MAX_RUN)) {
      if (key(id) !== mine) break;
      out.push(id);
    }
    return out;
  }, [lib, model, neighbors, queue, trackId]);

  const focused = rows.find((r) => focus && focus.track === trackId && r.playlistId === focus.playlist)?.playlistId ?? rows[0]?.playlistId;
  const left = excluded && excluded.track === trackId ? excluded.ids : new Set<string>();
  const runIn = run.filter((id) => !left.has(id));

  const focusAt = (i: number) => {
    const r = rows[(i + rows.length) % rows.length];
    if (r && trackId) setFocus({ track: trackId, playlist: r.playlistId });
  };
  const toggleRun = (id: string) => {
    if (!trackId) return;
    const ids = new Set(left);
    if (!ids.delete(id)) ids.add(id);
    setExcluded({ track: trackId, ids });
  };
  const sortOne = () => trackId && sort([trackId]);
  const sortRun = () => trackId && runIn.length > 0 && sort([trackId, ...runIn]);

  // Each new song starts on its own once you've started playback the first time.
  useEffect(() => {
    if (track) player.autoplay(track.id, track.durationMs);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [track?.id]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTyping(e) || ruleFor || palette) return;
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === "k") return void (e.preventDefault(), setPalette(true));
      if (mod && e.key.toLowerCase() === "z") return void (e.preventDefault(), undo());
      if (mod) return;
      const index = rows.findIndex((r) => r.playlistId === focused);
      if (/^[1-9]$/.test(e.key) && Number(e.key) <= KEYED) {
        const row = rows[Number(e.key) - 1];
        if (row) (togglePick(row.playlistId), focusAt(Number(e.key) - 1));
      } else if (e.key === "Enter") (e.preventDefault(), e.shiftKey ? sortRun() : sortOne()); // also stops a focused button "clicking"
      else if (e.key === "ArrowDown") (e.preventDefault(), focusAt(index + 1));
      else if (e.key === "ArrowUp") (e.preventDefault(), focusAt(index - 1));
      else if (e.key.toLowerCase() === "s") skip();
      else if (e.key === "/") (e.preventDefault(), setPalette(true));
      else if (e.key === " ") {
        e.preventDefault();
        if (track && player.trackId !== track.id) void player.play(track.id, track.durationMs);
        else player.toggle();
      } else if (e.key === "ArrowLeft") player.seekBy(-10_000);
      else if (e.key === "ArrowRight") player.seekBy(10_000);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  if (!lib || !model) return null;
  if (!track)
    return (
      <div className="grid h-96 place-items-center text-center">
        <div>
          <div className="text-3xl font-extrabold text-zinc-50">Inbox zero</div>
          <div className="mt-1 text-sm text-zinc-400">Every liked song is sorted.</div>
        </div>
      </div>
    );

  const playingThis = player.trackId === track.id;
  const upNext = queue.slice(1 + run.length, 1 + run.length + UP_NEXT);
  const recent = history.slice(-RECENT).toReversed();

  return (
    <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_380px]">
      <main className="min-w-0">
        <div className="mb-5 flex items-center gap-3 text-xs text-zinc-400">
          <span>
            <b className="font-bold text-zinc-100">{queue.length.toLocaleString()}</b> to sort
            {history.length > 0 && (
              <>
                {" · "}
                <b className="font-bold text-zinc-100">{history.length}</b> sorted
              </>
            )}
          </span>
          <button
            onClick={() => setPalette(true)}
            className="ml-auto flex items-center gap-2 rounded-lg border border-white/10 py-1 pl-2.5 pr-1.5 text-zinc-400 hover:border-white/25 hover:text-zinc-100"
          >
            Search, create, settings <kbd>⌘K</kbd>
          </button>
        </div>

        {/* The song */}
        <div className="grid grid-cols-[160px_minmax(0,1fr)] items-end gap-5 sm:grid-cols-[200px_minmax(0,1fr)]">
          {track.album.imageUrl ? (
            <img src={track.album.imageUrl} alt="" className="aspect-square w-full rounded-md object-cover shadow-2xl shadow-black/60" />
          ) : (
            <div className="aspect-square w-full rounded-md bg-zinc-900" />
          )}
          <div className="min-w-0">
            <h2 className="mb-2 text-4xl font-extrabold leading-[0.95] tracking-tight text-balance text-zinc-50 xl:text-5xl">{track.name}</h2>
            <p className="font-medium text-zinc-100">{track.artists.map((a) => a.name).join(", ")}</p>
            <p className="truncate text-xs text-zinc-400">{track.album.name}</p>
            <div className="mt-4 flex items-center gap-3">
              <button
                onClick={() => (playingThis ? player.toggle() : void player.play(track.id, track.durationMs))}
                className="grid size-9 shrink-0 place-items-center rounded-full bg-zinc-100 text-zinc-950 hover:bg-white"
                aria-label={playingThis && !player.paused ? "Pause" : "Play"}
              >
                {playingThis && !player.paused ? <PauseIcon /> : <PlayIcon />}
              </button>
              <Progress playing={playingThis} duration={track.durationMs} />
            </div>
            <PlayerStatus onRetry={() => void player.play(track.id, track.durationMs)} />
          </div>
        </div>

        {/* Playlists */}
        <div className="mt-7 grid grid-cols-[repeat(auto-fill,minmax(190px,1fr))] gap-1.5">
          {rows.map((s, i) => (
            <Tile
              key={s.playlistId}
              index={i}
              name={byId.get(s.playlistId)?.name ?? "?"}
              color={colors.get(s.playlistId) ?? "#a092ab"}
              score={s.score}
              checked={picked.includes(s.playlistId)}
              focused={s.playlistId === focused}
              muted={hidden.includes(s.playlistId)}
              ruled={!!rules[s.playlistId]}
              onToggle={() => (togglePick(s.playlistId), focusAt(i))}
              onFocus={() => focusAt(i)}
            />
          ))}
        </div>

        {/* The run, then what's after it */}
        {(run.length > 0 || upNext.length > 0) && (
          <div className="mt-6 border-t border-white/10 pt-4">
            {run.length > 0 && (
              <p className="mb-2.5 text-xs text-zinc-400">
                <b className="font-semibold text-zinc-100">{runIn.length + 1} in a row</b> with the same picks
              </p>
            )}
            <div className="-m-1 flex items-start gap-2.5 overflow-hidden p-1">
              {run.map((id) => (
                <Cover key={id} id={id} state={left.has(id) ? "out" : "in"} onClick={() => toggleRun(id)} />
              ))}
              {run.length > 0 && upNext.length > 0 && <span className="mx-1 w-px self-stretch bg-white/10" />}
              {upNext.map((id) => (
                <Cover key={id} id={id} state="later" />
              ))}
            </div>
          </div>
        )}

        {/* Actions */}
        <div className="mt-5 flex flex-wrap gap-2">
          <button
            disabled={picked.length === 0}
            onClick={sortOne}
            className="flex flex-1 items-center justify-between gap-3 rounded-lg bg-commit px-4 py-3 font-bold text-zinc-950 transition hover:brightness-110 disabled:bg-zinc-900 disabled:font-medium disabled:text-zinc-500"
          >
            {picked.length === 0 ? "Check a playlist" : `Sort into ${picked.length} playlist${picked.length > 1 ? "s" : ""}`}
            <kbd className="border-black/20 text-zinc-950">↵</kbd>
          </button>
          {runIn.length > 0 && (
            <button
              disabled={picked.length === 0}
              onClick={sortRun}
              className="flex flex-1 items-center justify-between gap-3 rounded-lg border border-white/15 px-4 py-3 hover:border-white/30 disabled:opacity-50"
            >
              Sort all {runIn.length + 1} <kbd>⇧↵</kbd>
            </button>
          )}
          <button onClick={skip} className="flex items-center gap-3 rounded-lg border border-white/15 px-4 py-3 hover:border-white/30">
            Skip <kbd>S</kbd>
          </button>
        </div>

        {/* This session */}
        {recent.length > 0 && (
          <div className="mt-5 flex flex-wrap gap-1.5">
            {recent.map((h) => (
              <span key={h.trackId} className="inline-flex items-center gap-2 rounded-full border border-white/10 py-0.5 pl-2.5 pr-0.5 text-xs text-zinc-200">
                {h.picked.slice(0, 3).map((p) => (
                  <span key={p} className="-mr-1 size-2 rounded-full" style={{ background: colors.get(p) }} />
                ))}
                <span className="ml-1 max-w-48 truncate">{lib.tracks[h.trackId]?.name}</span>
                <button
                  onClick={() => undo(h.trackId)}
                  className="rounded-full px-2 py-0.5 text-zinc-500 hover:bg-white/10 hover:text-zinc-100"
                  title={h === history.at(-1) ? "Undo (⌘Z)" : "Undo"}
                >
                  Undo
                </button>
              </span>
            ))}
          </div>
        )}
      </main>

      <aside className="min-w-0 lg:border-l lg:border-white/10 lg:pl-8">
        {focused && <WhyPanel track={track} playlistId={focused} colors={colors} onEditRule={() => setRuleFor(focused)} />}
      </aside>

      {palette && <CommandPalette colors={colors} onClose={() => setPalette(false)} onEditRule={setRuleFor} />}
      {ruleFor && byId.get(ruleFor) && <RuleEditor playlist={byId.get(ruleFor)!} track={track} onClose={() => setRuleFor(null)} />}
    </div>
  );
}

/** A playlist the song could go in; the bar is the model's confidence, in the playlist's color. */
function Tile(props: {
  index: number;
  name: string;
  color: string;
  score: number;
  checked: boolean;
  focused: boolean;
  /** Hidden playlists only show up here when picked from search. */
  muted: boolean;
  ruled: boolean;
  onToggle: () => void;
  onFocus: () => void;
}) {
  const { index, name, color, score, checked, focused } = props;
  return (
    <button
      onClick={props.onToggle}
      onMouseEnter={props.onFocus}
      title={props.ruled ? "Has an artist rule" : undefined}
      className={`relative rounded-lg border py-2.5 pl-10 pr-3 text-left transition-colors ${
        checked ? "" : focused ? "border-white/20 bg-zinc-900" : "border-transparent bg-zinc-900"
      }`}
      style={checked ? { borderColor: color, background: `color-mix(in oklab, ${color} 20%, var(--color-zinc-900))` } : undefined}
    >
      <span
        className={`absolute left-3 top-3 grid size-[18px] place-items-center rounded text-[11px] font-bold ${checked ? "text-zinc-950" : "border border-white/15 text-zinc-400"}`}
        style={checked ? { background: color } : undefined}
      >
        {checked ? "✓" : index < KEYED ? index + 1 : ""}
      </span>
      <span className={`block truncate font-medium ${props.muted ? "text-zinc-400" : "text-zinc-50"}`}>{name}</span>
      <span className="mt-2 block h-[3px] rounded-full bg-white/10">
        <span className="block h-full rounded-full" style={{ width: `${Math.min(score, 1) * 100}%`, background: color }} />
      </span>
    </button>
  );
}

/** An upcoming song: in the run (outlined, click to leave out), left out, or just later in the queue. */
function Cover({ id, state, onClick }: { id: string; state: "in" | "out" | "later"; onClick?: () => void }) {
  const t = useApp((s) => s.lib?.tracks[id]);
  if (!t) return null;
  return (
    <button
      onClick={onClick}
      disabled={!onClick}
      title={state === "later" ? t.name : `${t.name} (${state === "in" ? "click to leave out" : "click to include"})`}
      className="w-16 shrink-0 text-left disabled:cursor-default"
    >
      <span
        className={`block size-16 rounded bg-zinc-900 bg-cover bg-center outline-2 outline-offset-2 transition ${
          state === "in" ? "outline-commit" : state === "out" ? "opacity-30 outline-transparent" : "opacity-50 outline-transparent"
        }`}
        style={{ backgroundImage: t.album.imageUrl ? `url(${t.album.imageUrl})` : undefined }}
      />
      <span className={`mt-2 block truncate text-[11px] ${state === "in" ? "text-zinc-100" : state === "out" ? "text-zinc-500 line-through" : "text-zinc-500"}`}>
        {t.name}
      </span>
    </button>
  );
}

/** Player hints and errors. */
function PlayerStatus({ onRetry }: { onRetry: () => void }) {
  const { devices, error, armed } = usePlayer();
  if (error)
    return (
      <p className="mt-2 text-xs text-rose-400">
        {error}{" "}
        <button className="underline hover:text-rose-300" onClick={onRetry}>
          Retry
        </button>
      </p>
    );
  if (devices.length === 0) return <p className="mt-2 text-xs text-amber-300">Open Spotify on your Mac or phone: the sorter plays through it.</p>;
  if (!armed) return <p className="mt-2 text-xs text-zinc-400">Press Space to start; songs then play as they come up.</p>;
  return null;
}

/** Smooth progress bar; click to seek. */
function Progress({ playing, duration }: { playing: boolean; duration: number }) {
  const { position, updatedAt, paused, seekTo } = usePlayer();
  const [, tick] = useState(0);
  useEffect(() => {
    if (!playing || paused) return;
    const id = setInterval(() => tick((t) => t + 1), 250);
    return () => clearInterval(id);
  }, [playing, paused]);
  const now = playing ? (paused ? position : position + (performance.now() - updatedAt)) : 0;
  const pct = Math.min(now / duration, 1) * 100;
  return (
    <div className="flex min-w-0 flex-1 items-center gap-2.5 text-[11px] text-zinc-400">
      <span>{fmt(now)}</span>
      <div
        className="h-1 flex-1 cursor-pointer rounded-full bg-zinc-800"
        onClick={(e) => {
          const rect = e.currentTarget.getBoundingClientRect();
          if (playing) seekTo(((e.clientX - rect.left) / rect.width) * duration);
        }}
      >
        <div className="h-full rounded-full bg-zinc-100" style={{ width: `${pct}%` }} />
      </div>
      <span>{fmt(duration)}</span>
    </div>
  );
}

const PlayIcon = () => (
  <svg viewBox="0 0 16 16" className="ml-0.5 size-3.5" fill="currentColor" aria-hidden>
    <path d="M4 2.5v11l9-5.5z" />
  </svg>
);
const PauseIcon = () => (
  <svg viewBox="0 0 16 16" className="size-3.5" fill="currentColor" aria-hidden>
    <path d="M3.5 2.5h3v11h-3zM9.5 2.5h3v11h-3z" />
  </svg>
);
