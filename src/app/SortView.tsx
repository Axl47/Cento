// The sorting screen: the current song, its ranked playlists as tiles (confident ones
// prechecked), the run of upcoming songs that would get the same picks, actions, what's known
// about the focused playlist, and this session's sorts. The right side shows where the song
// sits by sound: among its nearest songs, or against the tile being hovered (or chosen with ↑↓).
import { useEffect, useMemo, useState } from "react";
import { sortTargets, type Track } from "../core/library.ts";
import { LINE_BREAK } from "../core/lyrics.ts";
import { knownArtistSongs, suggest, type Suggestion } from "../core/suggest.ts";
import { readPlaylist, songThemes } from "../core/themes.ts";
import { songWords } from "../core/traits.ts";
import { CommandPalette } from "./CommandPalette.tsx";
import { RuleEditor } from "./RuleEditor.tsx";
import { PlaylistInfo } from "./PlaylistInfo.tsx";
import { SongEvidence } from "./SongEvidence.tsx";
import { SoundMap } from "./SoundMap.tsx";
import { openInSpotify, usePlayer } from "./player.ts";
import { initialPicks, useApp } from "./store.ts";
import { useHoverIntent } from "./useHoverIntent.ts";

/** Tiles with a number key. */
const KEYED = 8;
/** How far ahead a run can reach. */
const MAX_RUN = 8;
/** Upcoming songs shown after the run. */
const UP_NEXT = 4;
const RECENT = 6;

const isTyping = (e: KeyboardEvent) => e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement;
export const fmt = (ms: number) => `${Math.floor(ms / 60000)}:${String(Math.floor((ms % 60000) / 1000)).padStart(2, "0")}`;

export function SortView({ colors }: { colors: Map<string, string> }) {
  const { lib, model, audio, neighbors, queue, picked, history, rules, hidden, togglePick, sort, skip, undo } = useApp();
  const player = usePlayer();
  const [ruleFor, setRuleFor] = useState<string | null>(null); // playlist whose artist rule is being edited
  const [palette, setPalette] = useState(false);
  // Both belong to one song; a new song starts with no tile focused and the whole run in.
  const tile = useHoverIntent<{ track: string; playlist: string }>();
  const [excluded, setExcluded] = useState<{ track: string; ids: Set<string> } | null>(null);
  const [mark, setMark] = useState<string | null>(null); // song hovered anywhere, pointed out on the map

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
  // Only artists you've sorted before can be in one: a run is never sorted on sound alone.
  const run = useMemo(() => {
    if (!lib || !model || !trackId) return [];
    const known = (id: string) => knownArtistSongs(model, lib.tracks[id]!).size > 0;
    const key = (id: string) => initialPicks({ lib, model, neighbors }, id).toSorted().join();
    const mine = key(trackId);
    if (!mine || !known(trackId)) return [];
    const out: string[] = [];
    for (const id of queue.slice(1, 1 + MAX_RUN)) {
      if (key(id) !== mine || !known(id)) break;
      out.push(id);
    }
    return out;
  }, [lib, model, neighbors, queue, trackId]);

  const inRows = (focus: typeof tile.current) => (focus && focus.track === trackId ? rows.find((r) => r.playlistId === focus.playlist)?.playlistId : undefined);
  const focused = inRows(tile.current);
  // Stays on the last playlist looked at, so its buttons can be reached and the page doesn't jump.
  const infoFor = focused ?? inRows(tile.last) ?? rows[0]?.playlistId;
  const left = excluded && excluded.track === trackId ? excluded.ids : new Set<string>();
  const runIn = run.filter((id) => !left.has(id));

  const focusAt = (i: number) => {
    const r = rows[(i + rows.length) % rows.length];
    if (r && trackId) tile.set({ track: trackId, playlist: r.playlistId });
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
        if (row) togglePick(row.playlistId);
      } else if (e.key === "Enter") (e.preventDefault(), e.shiftKey ? sortRun() : sortOne()); // also stops a focused button "clicking"
      else if (e.key === "ArrowDown") (e.preventDefault(), focusAt(index + 1));
      else if (e.key === "ArrowUp") (e.preventDefault(), focusAt(index < 0 ? rows.length - 1 : index - 1));
      else if (e.key === "Escape") tile.set(null);
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
      <div>
        <UncountedRow onAdd={() => setPalette(true)} />
        <div className="grid h-96 place-items-center text-center">
          <div>
            <div className="text-3xl font-extrabold text-zinc-50">Inbox zero</div>
            <div className="mt-1 text-sm text-zinc-400">Every liked song is sorted.</div>
          </div>
        </div>
        {palette && <CommandPalette colors={colors} onClose={() => setPalette(false)} onEditRule={setRuleFor} />}
      </div>
    );

  const playingThis = player.trackId === track.id;
  const upNext = queue.slice(1 + run.length, 1 + run.length + UP_NEXT);
  const recent = history.slice(-RECENT).toReversed();

  return (
    <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_minmax(420px,0.8fr)]">
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
        <UncountedRow onAdd={() => setPalette(true)} />

        {/* The song */}
        <div className="grid grid-cols-[160px_minmax(0,1fr)] items-end gap-5 sm:grid-cols-[200px_minmax(0,1fr)]">
          {/* Opens the song in the Spotify app: a way to listen that doesn't need the player API. */}
          <a
            href={`spotify:track:${track.id}`}
            onClick={(e) => (e.preventDefault(), openInSpotify(track.id))}
            title="Open in Spotify"
            className="block transition hover:brightness-110"
          >
            {track.album.imageUrl ? (
              <img src={track.album.imageUrl} alt={`${track.name} in Spotify`} className="aspect-square w-full rounded-md object-cover shadow-2xl shadow-black/60" />
            ) : (
              <div className="aspect-square w-full rounded-md bg-zinc-900" />
            )}
          </a>
          <div className="min-w-0">
            <h2 className="mb-2 text-4xl font-extrabold leading-[0.95] tracking-tight text-balance text-zinc-50 xl:text-5xl">{track.name}</h2>
            <p className="font-medium text-zinc-100">{track.artists.map((a) => a.name).join(", ")}</p>
            <p className="truncate text-xs text-zinc-400">{track.album.name}</p>
            <SongSound trackId={track.id} />
            <SongThemes track={track} playlistIds={rows.map((r) => r.playlistId)} colors={colors} />
            {player.enabled && (
              <>
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
              </>
            )}
          </div>
        </div>

        {/* Playlists */}
        <div className="mt-7 grid grid-cols-[repeat(auto-fill,minmax(170px,1fr))] gap-1.5">
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
              onToggle={() => togglePick(s.playlistId)}
              onHover={(on) => tile.hover(on && trackId ? { track: trackId, playlist: s.playlistId } : null)}
            />
          ))}
        </div>

        {/* The run, then what's after it */}
        {(run.length > 0 || upNext.length > 0) && (
          <div className="mt-6 border-t border-white/10 pt-4">
            <p className="mb-2.5 text-xs text-zinc-400">
              {run.length > 0 ? (
                <>
                  <b className="font-semibold text-zinc-100">{runIn.length + 1} in a row</b> with the same picks
                </>
              ) : (
                "Up next"
              )}
            </p>
            <div className="-m-1 flex items-start gap-2.5 overflow-hidden p-1">
              {run.map((id) => (
                <Cover key={id} id={id} state={left.has(id) ? "out" : "in"} onClick={() => toggleRun(id)} onMark={setMark} />
              ))}
              {run.length > 0 && upNext.length > 0 && <span className="mx-1 w-px self-stretch bg-white/10" />}
              {upNext.map((id) => (
                <Cover key={id} id={id} state="later" onMark={setMark} />
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

        {infoFor && <PlaylistInfo playlistId={infoFor} track={track} colors={colors} onEditRule={() => setRuleFor(infoFor)} />}

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

      <aside className="min-w-0 space-y-5 lg:border-l lg:border-white/10 lg:pl-8">
        <h3 className="flex items-center gap-2 font-bold text-zinc-50">
          {focused && <span className="size-2.5 shrink-0 rounded-full" style={{ background: colors.get(focused) }} />}
          <span className="min-w-0 flex-1 truncate">{focused ? byId.get(focused)?.name : "Nearest by sound"}</span>
        </h3>
        {audio && (
          <SoundMap
            audio={audio}
            lib={lib}
            colors={colors}
            height={400}
            scene={{ kind: "song", id: track.id }}
            highlight={focused ? [focused] : []}
            mark={mark}
            onSelect={(id) => {
              const t = lib.tracks[id];
              if (t) void player.play(t.id, t.durationMs);
            }}
          />
        )}
        <SongEvidence track={track} playlistId={focused ?? null} colors={colors} mark={mark} onMark={setMark} />
      </aside>

      {palette && <CommandPalette colors={colors} onClose={() => setPalette(false)} onEditRule={setRuleFor} />}
      {ruleFor && byId.get(ruleFor) && <RuleEditor playlist={byId.get(ruleFor)!} track={track} onClose={() => setRuleFor(null)} />}
    </div>
  );
}

/** The song in a few words (genres, mood, tempo, key), once the tags and features have loaded. */
function SongSound({ trackId }: { trackId: string }) {
  const { tags, features } = useApp();
  useEffect(() => {
    useApp.getState().loadTags();
    useApp.getState().loadFeatures();
  }, []);
  const words = songWords(tags?.get(trackId), features?.get(trackId));
  return words.length ? <p className="mt-1 truncate text-xs text-zinc-400">{words.join(" · ")}</p> : null;
}

/** What the song's lyrics lean toward, the lines that show it, and which suggested playlists have that theme too. A hint: the ranking never sees it. */
function SongThemes({ track, playlistIds, colors }: { track: Track; playlistIds: string[]; colors: Map<string, string> }) {
  const { lib, themes } = useApp();
  const note = useMemo(() => {
    if (!lib || !themes) return null;
    const leans = songThemes(themes, track);
    const lead = leans[0];
    if (!lead) return null;
    const playlists = playlistIds.flatMap((id) => {
      const playlist = lib.playlists.find((p) => p.id === id);
      return playlist && readPlaylist(themes, lib, playlist).clear.some((t) => t.theme === lead.theme) ? [playlist] : [];
    });
    return { leans, lead, playlists };
  }, [lib, themes, track, playlistIds]);
  if (!note) return null;
  return (
    <div className="mt-2 text-xs text-zinc-400">
      <p>
        Lyrics lean toward <b className="font-semibold text-zinc-200">{note.leans.map((m) => m.name).join(" and ")}</b>
        {note.playlists.map((p) => (
          <span key={p.id} className="ml-2 inline-flex items-center gap-1 text-zinc-500">
            <span className="size-1.5 rounded-full" style={{ background: colors.get(p.id) }} />
            {p.name}
          </span>
        ))}
      </p>
      <p className="mt-0.5 line-clamp-2 text-zinc-500" title={note.lead.passage.split(LINE_BREAK).join("\n")}>
        {note.lead.passage}
      </p>
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
  onHover: (on: boolean) => void;
}) {
  const { index, name, color, score, checked, focused } = props;
  return (
    <button
      onClick={props.onToggle}
      onMouseEnter={() => props.onHover(true)}
      onMouseLeave={() => props.onHover(false)}
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

/** An upcoming song: in the run (outlined, click to leave out), left out, or just later in the queue. Hover marks it on the map. */
function Cover({
  id,
  state,
  onClick,
  onMark,
}: {
  id: string;
  state: "in" | "out" | "later";
  onClick?: () => void;
  onMark: (id: string | null) => void;
}) {
  const t = useApp((s) => s.lib?.tracks[id]);
  if (!t) return null;
  return (
    <button
      onClick={onClick}
      onMouseEnter={() => onMark(id)}
      onMouseLeave={() => onMark(null)}
      aria-disabled={!onClick}
      title={state === "later" ? t.name : `${t.name} (${state === "in" ? "click to leave out" : "click to include"})`}
      className={`w-16 shrink-0 text-left ${onClick ? "" : "cursor-default"}`}
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
  const { devices, error, armed, setEnabled } = usePlayer();
  if (error)
    return (
      <p className="mt-2 text-xs text-rose-400">
        {error}{" "}
        <button className="underline hover:text-rose-300" onClick={onRetry}>
          Retry
        </button>{" "}
        <button className="underline hover:text-rose-300" onClick={() => setEnabled(false)} title="Back on from ⌘K">
          Turn off player
        </button>
      </p>
    );
  if (devices.length === 0) return <p className="mt-2 text-xs text-amber-300">Open Spotify on your Mac or phone: Cento plays through it.</p>;
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

export const PlayIcon = () => (
  <svg viewBox="0 0 16 16" className="ml-0.5 size-3.5" fill="currentColor" aria-hidden>
    <path d="M4 2.5v11l9-5.5z" />
  </svg>
);
export const PauseIcon = () => (
  <svg viewBox="0 0 16 16" className="size-3.5" fill="currentColor" aria-hidden>
    <path d="M3.5 2.5h3v11h-3zM9.5 2.5h3v11h-3z" />
  </svg>
);

/** The on/off row for playlists that shouldn't count as sorted, for doing a rough pass and a proper one later. */
function UncountedRow({ onAdd }: { onAdd: () => void }) {
  const { lib, uncounted, shelf } = useApp();
  const { setUncounted, dropFromShelf } = useApp.getState();
  const name = (id: string) => lib?.playlists.find((p) => p.id === id)?.name ?? "Deleted playlist";
  return (
    <div className="-mt-2 mb-5 flex flex-wrap items-center gap-1.5 text-xs text-zinc-400">
      <span>Not counted as sorted:</span>
      {shelf.map((id) => {
        const on = uncounted.includes(id);
        return (
          <span key={id} className={`inline-flex items-center rounded-full border ${on ? "border-white/40 bg-white/10 text-zinc-100" : "border-white/10 text-zinc-500"}`}>
            <button aria-pressed={on} onClick={() => setUncounted(id, !on)} className="py-0.5 pl-2.5 pr-1 hover:text-zinc-50">
              {name(id)}
            </button>
            <button aria-label={`Remove ${name(id)} from this row`} onClick={() => dropFromShelf(id)} className="py-0.5 pl-1 pr-2 text-zinc-500 hover:text-zinc-100">
              ×
            </button>
          </span>
        );
      })}
      <button onClick={onAdd} title="Search for a playlist, then choose Don't count" className="text-zinc-500 underline-offset-2 hover:text-zinc-200 hover:underline">
        {shelf.length ? "Add…" : "Add a playlist…"}
      </button>
    </div>
  );
}
