// The sorting screen: the current song playing, ranked playlist suggestions with the
// confident ones prechecked, keyboard controls, and a map of the song's sound neighbors.
// Hovering a playlist row narrows the map and the neighbor list to that playlist.
import { useEffect, useMemo, useRef, useState } from "react";
import { closestAmong } from "../core/audio.ts";
import { config } from "../core/config.ts";
import { sortTargets } from "../core/library.ts";
import { knownArtistSongs, suggest, type Suggestion } from "../core/suggest.ts";
import { RuleEditor } from "./RuleEditor.tsx";
import { SoundMap } from "./SoundMap.tsx";
import { usePlayer } from "./player.ts";
import { useApp, type Order } from "./store.ts";

const KEYED = 9;
const PART_COLORS = { rule: "#34d399", artist: "#60a5fa", audio: "#fbbf24", pairing: "#f472b6", prior: "#52525b" } as const;

const isTyping = (e: KeyboardEvent) => e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement;
const fmt = (ms: number) => `${Math.floor(ms / 60000)}:${String(Math.floor((ms % 60000) / 1000)).padStart(2, "0")}`;

export function SortView({ colors }: { colors: Map<string, string> }) {
  const { lib, model, audio, neighbors, queue, picked, order, removeFromLikes, history, togglePick, sortCurrent, skip, undo, setOrder, setRemoveFromLikes } =
    useApp();
  const player = usePlayer();
  const [query, setQuery] = useState("");
  const [ruleFor, setRuleFor] = useState<string | null>(null); // playlist whose artist rule is being edited
  const rules = useApp((s) => s.rules);
  const hidden = useApp((s) => s.hidden);
  const setHidden = useApp((s) => s.setHidden);
  const createPlaylist = useApp((s) => s.createPlaylist);
  const [cursor, setCursor] = useState(0);
  const [hovered, setHovered] = useState<string | null>(null); // playlist row under the mouse
  const searchRef = useRef<HTMLInputElement>(null);

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
    return [...checked.toSorted((a, b) => b.score - a.score), ...rest.slice(0, Math.max(KEYED - checked.length, 3))];
  }, [suggestions, picked]);
  // A row can vanish under the mouse (hidden, next song) without firing mouseleave.
  const focusPlaylist = hovered && rows.some((r) => r.playlistId === hovered) ? hovered : null;

  // Evidence per playlist: how many of the artist's songs / sound neighbors are in it.
  const evidence = useMemo(() => {
    if (!model || !track) return { artist: new Map<string, number>(), artistTotal: 0, near: new Map<string, number>(), nearTotal: 0 };
    const count = (ids: string[]) => {
      const m = new Map<string, number>();
      for (const id of ids) for (const p of model.membership.get(id) ?? []) m.set(p, (m.get(p) ?? 0) + 1);
      return m;
    };
    const artistSongs = [...knownArtistSongs(model, track)];
    const near = (neighbors?.(track.id) ?? []).filter((n) => model.membership.has(n.id)).slice(0, 15).map((n) => n.id);
    return { artist: count(artistSongs), artistTotal: artistSongs.length, near: count(near), nearTotal: near.length };
  }, [model, track, neighbors]);

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? targets.filter((p) => p.name.toLowerCase().includes(q)).slice(0, 8) : [];
  }, [query, targets]);
  // The search can also create a playlist named after the query; it's the last option.
  const newName = query.trim() && !targets.some((p) => p.name.toLowerCase() === query.trim().toLowerCase()) ? query.trim() : "";
  const optionCount = results.length + (newName ? 1 : 0);
  const create = () => (void createPlaylist(newName), setQuery(""));

  // Each new song starts on its own once you've started playback the first time.
  useEffect(() => {
    if (track) player.autoplay(track.id, track.durationMs);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [track?.id]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTyping(e) || ruleFor) return;
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === "z") return void (e.preventDefault(), undo());
      if (mod) return;
      if (/^[1-9]$/.test(e.key)) {
        const row = rows[Number(e.key) - 1];
        if (row) togglePick(row.playlistId);
      } else if (e.key === "Enter") (e.preventDefault(), sortCurrent()); // also stops a focused button "clicking"
      else if (e.key.toLowerCase() === "s") skip();
      else if (e.key === "/") (e.preventDefault(), searchRef.current?.focus());
      else if (e.key === " ") {
        e.preventDefault();
        if (track && player.trackId !== track.id) void player.play(track.id, track.durationMs);
        else player.toggle();
      } else if (e.key === "ArrowLeft") player.seekBy(-10_000);
      else if (e.key === "ArrowRight") player.seekBy(10_000);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [rows, track, player, togglePick, sortCurrent, skip, undo, ruleFor]);

  if (!lib || !model) return null;
  if (!track)
    return (
      <div className="grid h-96 place-items-center text-zinc-400">
        <div className="text-center">
          <div className="text-4xl">🎉</div>
          <div className="mt-2 text-lg text-zinc-200">Inbox zero</div>
          <div className="text-sm">Every liked song is sorted.</div>
        </div>
      </div>
    );

  const playingThis = player.trackId === track.id;

  return (
    <div className="grid gap-5 lg:grid-cols-[300px_minmax(0,1fr)_minmax(0,1fr)]">
      {/* Now playing */}
      <section className="space-y-4">
        <div className="flex items-center justify-between text-xs text-zinc-400">
          <span>
            <b className="text-zinc-200">{queue.length.toLocaleString()}</b> to sort · {history.length} sorted now
          </span>
          <select
            value={order}
            onChange={(e) => setOrder(e.target.value as Order)}
            className="rounded-md border border-white/10 bg-zinc-900 px-2 py-1 text-zinc-300"
          >
            <option value="similar" disabled={!audio}>
              Similar together{audio ? "" : " (needs audio)"}
            </option>
            <option value="confident">Most confident first</option>
            <option value="newest">Newest liked first</option>
          </select>
        </div>

        {track.album.imageUrl ? (
          <img src={track.album.imageUrl} alt="" className="aspect-square w-full rounded-xl object-cover shadow-2xl shadow-black/50" />
        ) : (
          <div className="aspect-square w-full rounded-xl bg-zinc-800" />
        )}
        <div>
          <h2 className="text-xl font-bold leading-tight text-zinc-50">{track.name}</h2>
          <p className="text-zinc-300">{track.artists.map((a) => a.name).join(", ")}</p>
          <p className="text-xs text-zinc-500">{track.album.name}</p>
        </div>

        <Progress playing={playingThis} duration={track.durationMs} />

        <div className="flex items-center gap-2">
          <button className="btn" onClick={() => player.seekBy(-10_000)} title="Back 10s (←)">
            −10
          </button>
          <button
            className="btn flex-1 bg-zinc-100 font-semibold text-zinc-950 hover:bg-white"
            onClick={() => (playingThis ? player.toggle() : void player.play(track.id, track.durationMs))}
          >
            {playingThis && !player.paused ? "Pause" : "Play"} <kbd>Space</kbd>
          </button>
          <button className="btn" onClick={() => player.seekBy(10_000)} title="Forward 10s (→)">
            +10
          </button>
        </div>
        <PlayerStatus onRetry={() => void player.play(track.id, track.durationMs)} />
        <DevicePicker />
      </section>

      {/* Suggestions */}
      <section className="space-y-3">
        <h3 className="text-sm font-semibold uppercase tracking-wider text-zinc-400">Playlists</h3>
        <div className="space-y-1.5">
          {rows.map((s, i) => (
            <Row
              key={s.playlistId}
              s={s}
              index={i}
              name={byId.get(s.playlistId)?.name ?? "?"}
              color={colors.get(s.playlistId)}
              checked={picked.includes(s.playlistId)}
              onToggle={() => togglePick(s.playlistId)}
              artistIn={evidence.artist.get(s.playlistId) ?? 0}
              artistTotal={evidence.artistTotal}
              nearIn={evidence.near.get(s.playlistId) ?? 0}
              nearTotal={evidence.nearTotal}
              rule={rules[s.playlistId]?.map((a) => a.name)}
              onEditRule={() => setRuleFor(s.playlistId)}
              hidden={hidden.includes(s.playlistId)}
              onHide={() => setHidden(s.playlistId, true)}
              onHover={(on) => setHovered(on ? s.playlistId : null)}
            />
          ))}
        </div>

        <div className="relative">
          <input
            ref={searchRef}
            value={query}
            onChange={(e) => (setQuery(e.target.value), setCursor(0))}
            onKeyDown={(e) => {
              if (e.key === "Escape") (setQuery(""), e.currentTarget.blur());
              if (e.key === "ArrowDown") (e.preventDefault(), setCursor((c) => Math.min(c + 1, optionCount - 1)));
              if (e.key === "ArrowUp") (e.preventDefault(), setCursor((c) => Math.max(c - 1, 0)));
              if (e.key === "Enter" && results[cursor]) (togglePick(results[cursor].id), setQuery(""));
              else if (e.key === "Enter" && newName && cursor === results.length) create();
            }}
            placeholder="Find or create a playlist…  /"
            className="w-full rounded-lg border border-white/10 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-500 focus:border-white/30 focus:outline-none"
          />
          {optionCount > 0 && (
            <div className="absolute z-20 mt-1 w-full overflow-hidden rounded-lg border border-white/10 bg-zinc-900 shadow-xl">
              {results.map((p, i) => (
                <div key={p.id} className={`flex items-center ${i === cursor ? "bg-white/10" : ""}`}>
                  <button
                    onMouseDown={(e) => (e.preventDefault(), togglePick(p.id), setQuery(""))}
                    className="flex min-w-0 flex-1 items-center gap-2 px-3 py-2 text-left text-sm"
                  >
                    <span className="size-2.5 shrink-0 rounded-full" style={{ background: colors.get(p.id) }} />
                    <span className="truncate text-zinc-200">{p.name}</span>
                    {rules[p.id] && <span className="truncate text-xs text-zinc-500">only {rules[p.id]!.map((a) => a.name).join(", ")}</span>}
                    {hidden.includes(p.id) && <span className="text-xs text-zinc-500">hidden</span>}
                    <span className="flex-1" />
                    {picked.includes(p.id) && <span className="text-xs text-emerald-400">checked</span>}
                  </button>
                  <button
                    onMouseDown={(e) => (e.preventDefault(), setHidden(p.id, !hidden.includes(p.id)))}
                    className="rounded px-2 py-1 text-xs text-zinc-400 hover:bg-white/10 hover:text-zinc-100"
                    title={hidden.includes(p.id) ? "Suggest this playlist again" : "Never suggest this playlist"}
                  >
                    {hidden.includes(p.id) ? "Unhide" : "Hide"}
                  </button>
                  <button
                    onMouseDown={(e) => (e.preventDefault(), setRuleFor(p.id), setQuery(""))}
                    className="mr-1 rounded px-2 py-1 text-xs text-zinc-400 hover:bg-white/10 hover:text-zinc-100"
                    title="Set artists for this playlist"
                  >
                    Artists…
                  </button>
                </div>
              ))}
              {newName && (
                <button
                  onMouseDown={(e) => (e.preventDefault(), create())}
                  className={`flex w-full items-center gap-2 px-3 py-2 text-left text-sm ${cursor === results.length ? "bg-white/10" : ""}`}
                >
                  <span className="grid size-2.5 shrink-0 place-items-center text-zinc-400">+</span>
                  <span className="truncate text-zinc-200">
                    Create “{newName}”
                  </span>
                  <span className="flex-1" />
                  <span className="text-xs text-zinc-500">private · checks it</span>
                </button>
              )}
            </div>
          )}
        </div>

        {hidden.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5 text-xs text-zinc-500">
            <span title="Never suggested, and songs only in these still count as unsorted">Hidden:</span>
            {hidden.map((id) => (
              <button
                key={id}
                onClick={() => setHidden(id, false)}
                className="rounded-full border border-white/10 px-2 py-0.5 text-zinc-400 hover:border-white/25 hover:text-zinc-100"
                title="Unhide: suggest this playlist again"
              >
                {byId.get(id)?.name ?? "Deleted playlist"} ×
              </button>
            ))}
          </div>
        )}

        <div className="space-y-2 rounded-xl border border-white/10 bg-zinc-900/60 p-3">
          <button
            disabled={picked.length === 0}
            onClick={sortCurrent}
            className="btn w-full bg-emerald-500 py-2.5 font-semibold text-emerald-950 hover:bg-emerald-400 disabled:bg-zinc-800 disabled:text-zinc-500"
          >
            {picked.length === 0 ? "Check at least one playlist" : `Sort into ${picked.length} playlist${picked.length > 1 ? "s" : ""}`} <kbd>Enter</kbd>
          </button>
          <p className="text-center text-xs text-zinc-500">
            Also adds to {lib.playlists.find((p) => p.id === config.allPlaylistId)?.name ?? "the all-songs playlist"} if missing
            {removeFromLikes ? " · removes from Liked Songs" : ""}
          </p>
          <div className="flex items-center justify-between gap-2 text-xs">
            <label className="flex items-center gap-1.5 text-zinc-400">
              <input type="checkbox" checked={removeFromLikes} onChange={(e) => setRemoveFromLikes(e.target.checked)} />
              Remove from Likes
            </label>
            <div className="flex gap-1.5">
              <button className="btn" onClick={skip}>
                Skip <kbd>S</kbd>
              </button>
              <button className="btn" onClick={undo} disabled={history.length === 0}>
                Undo <kbd>⌘Z</kbd>
              </button>
            </div>
          </div>
        </div>
        <p className="text-[11px] leading-relaxed text-zinc-500">
          <kbd>1</kbd>–<kbd>9</kbd> toggle · <kbd>/</kbd> search · <kbd>←</kbd>/<kbd>→</kbd> seek 10s · bars:{" "}
          <Legend />
        </p>
      </section>

      {ruleFor && byId.get(ruleFor) && (
        <RuleEditor playlist={byId.get(ruleFor)!} track={track} onClose={() => setRuleFor(null)} />
      )}

      {/* Sound neighbors */}
      <section className="space-y-3">
        <h3 className="text-sm font-semibold uppercase tracking-wider text-zinc-400">Sounds like</h3>
        {audio ? (
          <>
            <div className="overflow-hidden rounded-xl border border-white/10 bg-zinc-950">
              <SoundMap
                audio={audio}
                lib={lib}
                colors={colors}
                height={340}
                focusId={track.id}
                focusZoom={5}
                highlight={focusPlaylist ? [focusPlaylist] : undefined}
                onSelect={(id) => {
                  const t = lib.tracks[id];
                  if (t) void player.play(t.id, t.durationMs);
                }}
              />
            </div>
            <Neighbors trackId={track.id} colors={colors} playlistId={focusPlaylist} />
          </>
        ) : (
          <div className="rounded-xl border border-dashed border-white/15 p-6 text-sm text-zinc-400">
            No audio index yet. Once the embedding engine has processed your library, run <code>pnpm audio</code> and reload.
            Suggestions use artist overlap and playlist pairings until then.
          </div>
        )}
      </section>
    </div>
  );
}

/** Player hints and errors. */
function PlayerStatus({ onRetry }: { onRetry: () => void }) {
  const { devices, error, armed } = usePlayer();
  if (error)
    return (
      <p className="text-xs text-rose-400">
        {error}{" "}
        <button className="underline hover:text-rose-300" onClick={onRetry}>
          Retry
        </button>
      </p>
    );
  if (devices.length === 0)
    return <p className="text-xs text-amber-300">Open Spotify on your Mac or phone: the sorter plays through it.</p>;
  if (!armed) return <p className="text-xs text-zinc-400">Press Space or click Play to start; songs then play as they come up.</p>;
  return null;
}

/** Which Spotify app plays the previews. */
function DevicePicker() {
  const { devices, deviceId, setDevice } = usePlayer();
  if (devices.length === 0) return null;
  return (
    <label className="flex items-center gap-2 text-xs text-zinc-500">
      Playing on
      <select
        value={deviceId ?? ""}
        onChange={(e) => setDevice(e.target.value)}
        className="min-w-0 flex-1 rounded-md border border-white/10 bg-zinc-900 px-2 py-1 text-zinc-300"
      >
        {devices.map((d) => (
          <option key={d.id} value={d.id}>
            {d.name}
          </option>
        ))}
      </select>
    </label>
  );
}

function Row(props: {
  s: Suggestion;
  index: number;
  name: string;
  color: string | undefined;
  checked: boolean;
  onToggle: () => void;
  artistIn: number;
  artistTotal: number;
  nearIn: number;
  nearTotal: number;
  /** Artist names of this playlist's rule, if it has one. */
  rule: string[] | undefined;
  onEditRule: () => void;
  /** Hidden playlists only show up here when picked from search. */
  hidden: boolean;
  onHide: () => void;
  onHover: (on: boolean) => void;
}) {
  const { s, index, name, color, checked, onToggle } = props;
  const why = [
    props.hidden ? "hidden from suggestions" : null,
    props.rule ? `artist rule: ${props.rule.join(", ")}` : null,
    props.artistIn ? `${props.artistIn}/${props.artistTotal} of the artist's songs` : null,
    props.nearIn ? `${props.nearIn}/${props.nearTotal} closest-sounding songs` : null,
    s.parts.pairing > 0.02 ? "goes with your picks" : null,
  ].filter(Boolean);
  return (
    <div className="group relative" onMouseEnter={() => props.onHover(true)} onMouseLeave={() => props.onHover(false)}>
    <button
      onClick={onToggle}
      className={`flex w-full items-center gap-3 rounded-lg border py-2 pl-3 pr-28 text-left transition ${
        checked ? "border-emerald-500/60 bg-emerald-500/10" : "border-white/5 bg-zinc-900/60 hover:border-white/15"
      }`}
    >
      <span
        className={`grid size-5 shrink-0 place-items-center rounded text-xs font-bold ${
          checked ? "bg-emerald-500 text-emerald-950" : "border border-white/20 text-transparent"
        }`}
      >
        ✓
      </span>
      <span className="w-4 shrink-0 font-mono text-xs text-zinc-500">{index < KEYED ? index + 1 : ""}</span>
      <span className="size-2.5 shrink-0 rounded-full" style={{ background: color }} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm text-zinc-100">{name}</span>
        <span className="block truncate text-[11px] text-zinc-500">{why.join(" · ") || "little evidence"}</span>
      </span>
      <span className="flex h-2 w-24 shrink-0 overflow-hidden rounded-full bg-zinc-800">
        {(Object.keys(PART_COLORS) as (keyof typeof PART_COLORS)[]).map((k) => (
          <span key={k} style={{ width: `${s.parts[k] * 100}%`, background: PART_COLORS[k] }} />
        ))}
      </span>
      <span className="w-8 shrink-0 text-right font-mono text-xs text-zinc-400">{Math.round(s.score * 100)}</span>
    </button>
    <div className="absolute right-2 top-1/2 flex -translate-y-1/2 gap-0.5">
      {!props.hidden && (
        <button
          onClick={props.onHide}
          className="rounded px-1.5 py-1 text-xs text-zinc-500 opacity-0 transition hover:bg-white/10 hover:text-zinc-100 focus:opacity-100 group-hover:opacity-100"
          title="Never suggest this playlist (e.g. a Best of)"
        >
          Hide
        </button>
      )}
      <button
        onClick={props.onEditRule}
        className={`rounded px-1.5 py-1 text-xs transition hover:bg-white/10
 hover:text-zinc-100 ${
          props.rule ? "text-emerald-300" : "text-zinc-500 opacity-0 group-hover:opacity-100 focus:opacity-100"
        }`}
        title="Only suggest this playlist for certain artists"
      >
        Artists…
      </button>
    </div>
    </div>

  );
}

function Legend() {
  return (
    <>
      {(Object.entries(PART_COLORS) as [keyof typeof PART_COLORS, string][]).map(([k, c]) => (
        <span key={k} className="mr-2 inline-flex items-center gap-1">
          <span className="inline-block size-2 rounded-sm" style={{ background: c }} />
          {k === "audio" ? "sounds like" : k === "rule" ? "artist rule" : k}
        </span>
      ))}
    </>
  );
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
    <div>
      <div
        className="h-1.5 cursor-pointer rounded-full bg-zinc-800"
        onClick={(e) => {
          const rect = e.currentTarget.getBoundingClientRect();
          if (playing) seekTo(((e.clientX - rect.left) / rect.width) * duration);
        }}
      >
        <div className="h-full rounded-full bg-zinc-100" style={{ width: `${pct}%` }} />
      </div>
      <div className="mt-1 flex justify-between font-mono text-[11px] text-zinc-500">
        <span>{fmt(now)}</span>
        <span>{fmt(duration)}</span>
      </div>
    </div>
  );
}

/**
 * Closest sorted songs by sound, clickable to hear them. With `playlistId`, that playlist's
 * closest songs (exact, once the vectors load), down to the library's random-pair baseline.
 */
function Neighbors({ trackId, colors, playlistId }: { trackId: string; colors: Map<string, string>; playlistId: string | null }) {
  const { lib, model, neighbors, audio, vectors } = useApp();
  const play = usePlayer((s) => s.play);
  if (!lib || !model || !neighbors || !audio) return null;
  // Songs the embedding engine couldn't fetch or decode have no sound to compare.
  if (!audio.ids.includes(trackId))
    return <p className="px-2 py-1.5 text-xs text-zinc-500">No audio for this song (no preview found), so there's nothing to compare it to.</p>;
  const names = new Map(lib.playlists.map((p) => [p.id, p.name]));
  // Playlist trackIds rather than model.membership, so hidden playlists work too.
  const members = playlistId ? (lib.playlists.find((p) => p.id === playlistId)?.trackIds ?? []) : null;
  const near = !members
    ? neighbors(trackId).filter((n) => model.membership.has(n.id)).slice(0, 6)
    : vectors
      ? closestAmong(audio, vectors, trackId, members, 6)
      : neighbors(trackId).filter((n) => members.includes(n.id)).slice(0, 6);
  if (playlistId && near.length === 0)
    return <p className="px-2 py-1.5 text-xs text-zinc-500">No songs in {names.get(playlistId)} sound similar.</p>;
  return (
    <div className="space-y-1">
      {near.map((n) => {
        const t = lib.tracks[n.id];
        if (!t) return null;
        return (
          <button
            key={n.id}
            onClick={() => void play(t.id, t.durationMs)}
            className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs hover:bg-white/5"
            title="Play"
          >
            <span className="w-8 font-mono text-zinc-500">{Math.round(n.sim * 100)}%</span>
            <span className="min-w-0 flex-1 truncate text-zinc-200">
              {t.name} <span className="text-zinc-500">· {t.artists[0]?.name}</span>
            </span>
            {(playlistId ? [playlistId] : (model.membership.get(n.id) ?? []).slice(0, 2)).map((p) => (
              <span key={p} className="rounded px-1.5 py-0.5 text-[10px] text-zinc-950" style={{ background: colors.get(p) }}>
                {names.get(p)}
              </span>
            ))}
          </button>
        );
      })}
    </div>
  );
}
