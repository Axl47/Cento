// Build tab: turns a handful of songs into a playlist. The ordered list is the screen: a bar between each two
// songs shows how smoothly one hands off to the next (click it to hear the seam), songs that don't fit are
// marked, and rough handoffs say why (tempo, level, key) and offer songs to put in between. Drag to reorder (a
// dragged song is pinned to its slot), Smooth reorders the rest, ⌘Z undoes. The right column shows the set's
// energy arc above songs to add or the set on the map.
import { useEffect, useMemo, useRef, useState } from "react";
import { sortTargets, primaryPlaylists, type Library, type Track } from "../core/library.ts";
import { energyArc, handoffReasons, loudnessSpan } from "../core/features.ts";
import { additions, fillers, handoff, misfits, smoothestOrder, twoGroups, type Sound } from "../core/setlist.ts";
import { parseSpotifyLinks } from "../core/spotify.ts";
import { resolveLinks } from "./links.ts";
import { openInSpotify, usePlayer } from "./player.ts";
import { DEFAULT_NAME, useSets, type BuildSet, type Contents } from "./sets.ts";
import { SoundMap } from "./SoundMap.tsx";
import { PauseIcon, PlayIcon } from "./SortView.tsx";
import { useApp } from "./store.ts";
import { songKey } from "./useBridge.ts";

/**
 * Handoff thresholds, from the library: songs in a playlist's own order hand off at a median of 0.63 (a fifth below
 * 0.55), the smoothest order of the same songs at 0.71 (a quarter below 0.65), two random songs at 0.47.
 */
const SMOOTH = 0.65;
const ROUGH = 0.55;
const BAR_COLORS = { smooth: "#7fd1ae", middling: "#a092ab", rough: "#ff8f7a" };
const BAD = "#ff8f7a";
const UNSORTED = "#71717a";
/** Longest handoff bar, in pixels; a bar's length runs from the random-pair baseline (none) to 1 (all of it). */
const BAR_PX = 96;
/** How much of each song a handoff plays: the end of the first, then the start of the next. */
const SEAM_MS = 15_000;
/** How long before a song ends the next one is started, to cover the round trip to Spotify. */
const ADVANCE_EARLY_MS = 300;
/** Until Spotify reports the song playing, the switch runs on a timer this much shorter than the seam. */
const UNCONFIRMED_EARLY_MS = 1000;
const SUGGESTIONS = 10;
const FILLERS = 3;
const SEARCH_RESULTS = 8;
const START_PLAYLISTS = 12;
const CHIPS = 8;

const artistNames = (t: Track) => t.artists.map((a) => a.name).join(", ");

export function BuildView({ colors }: { colors: Map<string, string> }) {
  const { lib, audio, vectors, edges, features, hidden } = useApp();
  const { sets, currentId, change, undo, rename, split } = useSets();
  const current = sets.find((s) => s.id === currentId)!;
  const player = usePlayer();
  const seam = useSeam();
  const [side, setSide] = useState<"add" | "map">("add");
  const [mark, setMark] = useState<string | null>(null); // song hovered in the list, pointed out on the map
  const [gap, setGap] = useState<string | null>(null); // the song whose rough handoff to the next is open
  const [dragging, setDragging] = useState<string | null>(null);
  const [dropAt, setDropAt] = useState<number | null>(null);

  useEffect(() => {
    if (audio) useApp.getState().loadEdges();
  }, [audio]);
  useEffect(() => useApp.getState().loadFeatures(), []);

  const onMap = useMemo(() => new Set(audio?.ids ?? []), [audio]);
  const span = useMemo(() => (features ? loudnessSpan(features) : null), [features]);
  const sound = useMemo((): Sound | null => (audio && vectors ? { index: audio, vectors, edges: edges ?? undefined } : null), [audio, vectors, edges]);
  const primary = useMemo(() => (lib ? primaryPlaylists(sortTargets(lib, hidden)) : new Map<string, string>()), [lib, hidden]);
  // One release per song, preferring one on the map: what search, suggestions and gap fillers draw from.
  const pool = useMemo(() => {
    const best = new Map<string, Track>();
    for (const t of Object.values(lib?.tracks ?? {})) {
      const had = best.get(songKey(t));
      if (!had || (!onMap.has(had.id) && onMap.has(t.id))) best.set(songKey(t), t);
    }
    return best;
  }, [lib, onMap]);

  const { ids, extra } = current;
  const trackOf = (id: string): Track | undefined => lib?.tracks[id] ?? extra[id];
  const inSet = useMemo(
    () =>
      new Set(
        ids.flatMap((id) => {
          const t = lib?.tracks[id] ?? extra[id];
          return t ? [songKey(t)] : [];
        }),
      ),
    [ids, extra, lib],
  );
  const fresh = (t: Track) => pool.get(songKey(t))?.id === t.id && !inSet.has(songKey(t));

  // Songs with a sound vector; the others get no handoffs and keep their slot when smoothing.
  const placed = useMemo(() => (sound ? ids.filter((id) => onMap.has(id)) : []), [sound, ids, onMap]);
  const steps = useMemo(
    () => ids.slice(1).map((to, i) => (sound && onMap.has(ids[i]!) && onMap.has(to) ? handoff(sound, ids[i]!, to) : null)),
    [sound, ids, onMap],
  );
  const flagged = useMemo(() => (sound ? misfits(sound, placed) : []), [sound, placed]);
  // More than a quarter not fitting means the set is really two groups.
  const groups = useMemo(() => (sound && flagged.length > placed.length / 4 ? twoGroups(sound, ids) : null), [sound, flagged, placed, ids]);
  const suggestions = useMemo(() => {
    if (!sound || !lib) return [];
    return additions(sound, placed, (id) => !!lib.tracks[id] && fresh(lib.tracks[id]), SUGGESTIONS).flatMap((s) => lib.tracks[s.id] ?? []);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sound, lib, placed, pool, inSet]);
  const gapFill = useMemo(() => {
    const at = gap ? ids.indexOf(gap) : -1;
    if (!sound || !lib || at < 0 || at === ids.length - 1) return [];
    const candidates = [...pool.values()].filter((t) => onMap.has(t.id) && !inSet.has(songKey(t))).map((t) => t.id);
    return fillers(sound, gap!, ids[at + 1]!, candidates, FILLERS).flatMap((f) => lib.tracks[f.id] ?? []);
  }, [gap, ids, sound, lib, pool, onMap, inSet]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      const isUndo = mod && !e.shiftKey && e.key.toLowerCase() === "z";
      // Typing keeps its keys; an empty input (as after adding songs) still lets ⌘Z undo the set.
      if (e.target instanceof HTMLInputElement && !(isUndo && e.target.value === "")) return;
      if (isUndo) (e.preventDefault(), undo());
      else if (!mod && e.key === " ") (e.preventDefault(), usePlayer.getState().toggle());
      else if (e.key === "Escape") setGap(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [undo]);

  if (!lib) return null;

  const keyOf = (id: string, known: Contents["extra"]) => {
    const t = lib.tracks[id] ?? known[id];
    return t ? songKey(t) : id;
  };
  /** Adds songs at `at` (the end by default), skipping ones already in the set as any release. */
  const addSongs = (newIds: string[], newExtra: Track[] = [], at?: number) =>
    change((c) => {
      const known = { ...c.extra, ...Object.fromEntries(newExtra.map((t) => [t.id, t])) };
      const taken = new Set(c.ids.map((id) => keyOf(id, known)));
      const added = newIds.filter((id) => !taken.has(keyOf(id, known)) && (taken.add(keyOf(id, known)), true));
      const slot = at ?? c.ids.length;
      return {
        ids: [...c.ids.slice(0, slot), ...added, ...c.ids.slice(slot)],
        extra: { ...c.extra, ...Object.fromEntries(newExtra.filter((t) => added.includes(t.id) && !lib.tracks[t.id]).map((t) => [t.id, t])) },
      };
    });
  const remove = (id: string) =>
    change((c) => ({ ids: c.ids.filter((x) => x !== id), pinned: c.pinned.filter((x) => x !== id), extra: Object.fromEntries(Object.entries(c.extra).filter(([x]) => x !== id)) }));
  const move = (id: string, to: number) =>
    change((c) => {
      const next = c.ids.filter((x) => x !== id);
      next.splice(to > c.ids.indexOf(id) ? to - 1 : to, 0, id);
      return { ids: next, pinned: [...new Set([...c.pinned, id])] };
    });
  const togglePin = (id: string) => change((c) => ({ pinned: c.pinned.includes(id) ? c.pinned.filter((x) => x !== id) : [...c.pinned, id] }));
  const smooth = () =>
    sound &&
    change((c) => ({
      ids: smoothestOrder(sound, c.ids, (id) => trackOf(id)?.artists[0]?.id, new Set([...c.pinned, ...c.ids.filter((id) => !onMap.has(id))])),
    }));
  const startFrom = (playlist: { name: string; trackIds: string[] }) => {
    if (ids.length === 0 && current.name === DEFAULT_NAME) rename(playlist.name);
    addSongs(playlist.trackIds);
  };
  const play = (t: Track) => {
    seam.stop();
    void player.play(t.id, t.durationMs);
  };

  const input = (big: boolean) => (
    <AddSongs big={big} lib={lib} pool={pool} onMap={onMap} fresh={fresh} onSongs={addSongs} onPlaylist={startFrom} />
  );

  if (ids.length === 0) {
    const recent = sortTargets(lib)
      .map((p) => ({ p, last: Object.values(p.addedAt ?? {}).reduce((a, b) => (a > b ? a : b), "") }))
      .sort((a, b) => b.last.localeCompare(a.last))
      .slice(0, START_PLAYLISTS);
    return (
      <div className="mx-auto mt-[16vh] max-w-xl space-y-5">
        {sets.length > 1 && (
          <div className="flex justify-end">
            <SetMenu label="Sets" />
          </div>
        )}
        {input(true)}
        <div className="flex flex-wrap gap-1.5">
          {recent.map(({ p }) => (
            <button key={p.id} onClick={() => startFrom(p)} className="rounded-full bg-white/5 px-3 py-1 text-sm text-zinc-300 hover:bg-white/10 hover:text-zinc-100">
              {p.name}
            </button>
          ))}
        </div>
      </div>
    );
  }

  const minutes = Math.round(ids.reduce((sum, id) => sum + (trackOf(id)?.durationMs ?? 0), 0) / 60_000);
  const playing = player.trackId;
  const roughOnMap = new Set(sound ? placed.filter((id, k) => k < placed.length - 1 && handoff(sound, id, placed[k + 1]!) < ROUGH) : []);

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1.45fr)_minmax(0,1fr)]">
      <div className="min-w-0">
        <div className="mb-3 flex items-center gap-2">
          <input
            aria-label="Set name"
            value={current.name}
            onChange={(e) => rename(e.target.value)}
            onBlur={(e) => !e.target.value.trim() && rename(DEFAULT_NAME)}
            className="min-w-0 flex-1 rounded-md bg-transparent px-1 py-0.5 text-base font-semibold text-zinc-50 hover:bg-white/5 focus:bg-white/5 focus:outline-none"
          />
          <SetMenu />
          <span className="whitespace-nowrap text-sm text-zinc-400">
            {ids.length} · {minutes} min
          </span>
          <button className="btn" disabled={!sound || ids.length < 3} onClick={smooth}>
            Smooth
          </button>
          <SaveButton set={current} />
        </div>

        <ol onDragLeave={(e) => !e.currentTarget.contains(e.relatedTarget as Node | null) && setDropAt(null)}>
          {ids.map((id, i) => {
            const track = trackOf(id);
            if (!track) return null;
            const step = i > 0 ? steps[i - 1]! : null;
            const prev = ids[i - 1];
            const misfit = !groups && flagged.includes(id);
            const pinned = current.pinned.includes(id);
            const after = features?.get(id);
            const before = prev && features?.get(prev);
            return (
              <li
                key={id}
                className={`relative ${dragging === id ? "opacity-40" : ""}`}
                draggable
                onDragStart={(e) => {
                  setDragging(id);
                  e.dataTransfer.effectAllowed = "move";
                  e.dataTransfer.setData("text/plain", track.name);
                }}
                onDragOver={(e) => {
                  if (!dragging) return;
                  e.preventDefault();
                  const box = e.currentTarget.getBoundingClientRect();
                  setDropAt(i + (e.clientY > box.top + box.height / 2 ? 1 : 0));
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  if (dragging && dropAt !== null) move(dragging, dropAt);
                }}
                onDragEnd={() => (setDragging(null), setDropAt(null))}
                onMouseEnter={() => setMark(onMap.has(id) ? id : null)}
                onMouseLeave={() => setMark(null)}
              >
                {dropAt === i && <DropLine edge="top" />}
                {dropAt === ids.length && i === ids.length - 1 && <DropLine edge="bottom" />}
                {prev && step !== null ? (
                  <Joint
                    value={step}
                    baseline={audio?.baseline ?? 0}
                    playing={seam.seam?.from.id === prev && seam.seam.to.id === id}
                    open={gap === prev}
                    reasons={before && after ? handoffReasons(before, after) : []}
                    onPlay={() => {
                      const from = trackOf(prev);
                      if (from) seam.start(from, track);
                    }}
                    onRough={() => setGap(gap === prev ? null : prev)}
                  />
                ) : (
                  i > 0 && <div className="h-4" />
                )}
                {gap === prev && gapFill.length > 0 && (
                  <div className="mb-1 ml-[38px] rounded-lg border border-dashed border-white/20 px-2 py-1">
                    {gapFill.map((t) => (
                      <Suggestion key={t.id} track={t} onPlay={() => play(t)} onAdd={() => (addSongs([t.id], [], i), setGap(null))} />
                    ))}
                  </div>
                )}
                <div
                  className={`group flex cursor-grab items-center gap-2.5 rounded-lg px-2 py-1.5 active:cursor-grabbing ${playing === id ? "bg-zinc-800" : "bg-zinc-900"}`}
                  style={misfit ? { boxShadow: `inset 2px 0 0 ${BAD}` } : undefined}
                >
                  <span className="w-4 shrink-0 text-right text-xs text-zinc-500">{i + 1}</span>
                  <span className="size-2 shrink-0 rounded-full" style={{ background: colors.get(primary.get(id) ?? "") ?? UNSORTED }} />
                  <button className="min-w-0 flex-1 truncate text-left text-sm text-zinc-100" onClick={() => play(track)}>
                    {track.name} <span className="text-xs text-zinc-400">{artistNames(track)}</span>
                    {misfit && <span className="text-xs" style={{ color: BAD }}> · doesn't fit</span>}
                  </button>
                  {after?.steady && after.bpm && (
                    <span title="BPM" className="shrink-0 text-xs text-zinc-500">
                      {Math.round(after.bpm)}
                    </span>
                  )}
                  {misfit ? (
                    <button className="btn px-2 py-0.5 text-xs" onClick={() => remove(id)}>
                      Remove
                    </button>
                  ) : (
                    <button aria-label={`Remove ${track.name}`} className="invisible px-1 text-zinc-500 hover:text-zinc-100 group-hover:visible" onClick={() => remove(id)}>
                      ×
                    </button>
                  )}
                  <button
                    aria-label={pinned ? `Unpin ${track.name}` : `Pin ${track.name}`}
                    aria-pressed={pinned}
                    title={pinned ? "Pinned: Smooth leaves it here" : "Pin: Smooth leaves it here"}
                    className={`w-3 text-[11px] ${pinned ? "text-zinc-100" : "text-zinc-600 hover:text-zinc-300"}`}
                    onClick={() => togglePin(id)}
                  >
                    {pinned ? "●" : "○"}
                  </button>
                </div>
              </li>
            );
          })}
        </ol>
        <div className="mt-3">{input(false)}</div>
        {player.error && <p className="mt-2 text-xs text-rose-400">{player.error}</p>}
        {seam.seam && <SeamStrip from={seam.seam.from} to={seam.seam.to} />}
      </div>

      <aside className="min-w-0 space-y-3">
        {groups && (
          <TwoGroups
            groups={groups}
            trackOf={trackOf}
            onKeep={() => change((c) => ({ ids: c.ids.filter((id) => !groups[1].includes(id)), pinned: c.pinned.filter((id) => !groups[1].includes(id)) }))}
            onSplit={() => split(groups[1])}
          />
        )}
        {features && span && <EnergyArc ids={ids} energy={energyArc(ids, features, span)} nameOf={(id) => trackOf(id)?.name ?? ""} marked={mark} />}
        {!audio ? null : !vectors ? (
          <p className="text-sm text-zinc-500">Loading the sound vectors…</p>
        ) : (
          <>
            <div className="inline-flex overflow-hidden rounded-lg border border-white/10 text-sm">
              {(["add", "map"] as const).map((s) => (
                <button key={s} onClick={() => setSide(s)} className={`px-3 py-1 ${side === s ? "bg-white/10 text-zinc-50" : "text-zinc-400 hover:text-zinc-200"}`}>
                  {s === "add" ? "Add" : "Map"}
                </button>
              ))}
            </div>
            {side === "add" ? (
              suggestions.length > 0 && (
                <div className="rounded-xl bg-zinc-900 px-3 py-2">
                  {suggestions.map((t) => (
                    <Suggestion key={t.id} track={t} onPlay={() => play(t)} onAdd={() => addSongs([t.id])} />
                  ))}
                </div>
              )
            ) : (
              <SoundMap
                audio={audio}
                lib={lib}
                colors={colors}
                height={480}
                scene={{ kind: "set", ids: placed, rough: roughOnMap, ringed: groups ? groups[1] : flagged, dashed: suggestions.map((t) => t.id) }}
                mark={mark}
              />
            )}
          </>
        )}
      </aside>
    </div>
  );
}

const DropLine = ({ edge }: { edge: "top" | "bottom" }) => (
  <div className={`pointer-events-none absolute inset-x-0 z-10 h-0.5 rounded-full bg-zinc-100 ${edge === "top" ? "-top-px" : "-bottom-px"}`} />
);

/** The bar between two songs: how smooth the handoff is. Click to hear it; a rough one can open songs to put in between. */
function Joint({
  value,
  baseline,
  playing,
  open,
  reasons,
  onPlay,
  onRough,
}: {
  value: number;
  baseline: number;
  playing: boolean;
  open: boolean;
  reasons: string[];
  onPlay: () => void;
  onRough: () => void;
}) {
  const kind = value >= SMOOTH ? "smooth" : value < ROUGH ? "rough" : "middling";
  const share = Math.min(Math.max((value - baseline) / (1 - baseline), 0), 1);
  return (
    <div className={`flex items-center gap-2 pl-[38px] text-[11px] ${kind === "rough" ? "h-6" : "h-4"}`}>
      <button onClick={onPlay} aria-label="Play the handoff" title="Play the handoff" className="group flex h-full items-center gap-2">
        <span className="block h-[3px] rounded-full" style={{ width: Math.max(share * BAR_PX, 16), background: BAR_COLORS[kind] }} />
        <span className={`text-[9px] ${playing ? "text-zinc-100" : "text-zinc-400 opacity-0 group-hover:opacity-100"}`}>▶</span>
      </button>
      {kind === "rough" && (
        <button onClick={onRough} aria-expanded={open} className="hover:underline" style={{ color: BAD }}>
          rough
        </button>
      )}
      {kind === "rough" && reasons.length > 0 && <span className="text-zinc-500">· {reasons.join(" · ")}</span>}
    </div>
  );
}

/** Pixels above and below the arc's line, so the top and bottom dots aren't clipped. */
const ARC_PAD = 5;
const ARC_HEIGHT = 54;

/** The set's loudness song by song (null leaves a gap), the song hovered in the list enlarged; hidden until three songs have it. */
function EnergyArc({ ids, energy, nameOf, marked }: { ids: string[]; energy: (number | null)[]; nameOf: (id: string) => string; marked: string | null }) {
  if (energy.filter((e) => e !== null).length < 3) return null;
  const x = (i: number) => `${ids.length > 1 ? (i / (ids.length - 1)) * 100 : 50}%`;
  const y = (e: number) => ARC_PAD + (1 - e) * (ARC_HEIGHT - 2 * ARC_PAD);
  return (
    <div className="space-y-2 rounded-xl bg-zinc-900 p-3">
      <h4 className="text-[11px] font-medium uppercase tracking-wider text-zinc-500">Energy</h4>
      <div className="px-1.5">
        <svg width="100%" height={ARC_HEIGHT} className="overflow-visible">
          {energy.map((e, i) => {
            const next = energy[i + 1];
            return e !== null && next != null ? <line key={i} x1={x(i)} y1={y(e)} x2={x(i + 1)} y2={y(next)} stroke="#52525b" strokeWidth={1.5} /> : null;
          })}
          {energy.map((e, i) => {
            const id = ids[i]!;
            return e === null ? null : (
              <g key={id}>
                <title>{nameOf(id)}</title>
                <circle cx={x(i)} cy={y(e)} r={8} fill="transparent" />
                <circle cx={x(i)} cy={y(e)} r={marked === id ? 4 : 2.5} fill={marked === id ? "#fafafa" : "#a1a1aa"} />
              </g>
            );
          })}
        </svg>
      </div>
    </div>
  );
}

function Suggestion({ track, onPlay, onAdd }: { track: Track; onPlay: () => void; onAdd: () => void }) {
  return (
    <div className="flex items-center gap-2 py-1 text-sm">
      <button aria-label={`Play ${track.name}`} className="text-zinc-500 hover:text-zinc-100" onClick={onPlay}>
        <PlayIcon />
      </button>
      <div className="min-w-0 flex-1 truncate text-zinc-100">
        {track.name} <span className="text-xs text-zinc-400">{artistNames(track)}</span>
      </div>
      <button aria-label={`Add ${track.name}`} className="grid size-5 shrink-0 place-items-center rounded-md border border-white/10 text-zinc-400 hover:bg-white/5 hover:text-zinc-100" onClick={onAdd}>
        +
      </button>
    </div>
  );
}

function TwoGroups({ groups, trackOf, onKeep, onSplit }: { groups: [string[], string[]]; trackOf: (id: string) => Track | undefined; onKeep: () => void; onSplit: () => void }) {
  const chips = (ids: string[]) => (
    <div className="flex flex-wrap gap-1">
      {ids.slice(0, CHIPS).map((id) => (
        <span key={id} className="max-w-48 truncate rounded-full bg-white/[0.07] px-2 py-0.5 text-xs text-zinc-200">
          {trackOf(id)?.name}
        </span>
      ))}
      {ids.length > CHIPS && <span className="px-1 py-0.5 text-xs text-zinc-500">+{ids.length - CHIPS}</span>}
    </div>
  );
  return (
    <div className="space-y-2 rounded-xl bg-zinc-900 p-3">
      <h4 className="text-[11px] font-medium uppercase tracking-wider text-zinc-500">Two groups</h4>
      {chips(groups[0])}
      {chips(groups[1])}
      <div className="flex gap-1.5 pt-1">
        <button className="btn px-2 py-0.5 text-xs" onClick={onKeep}>
          Keep first
        </button>
        <button className="btn px-2 py-0.5 text-xs" onClick={onSplit} title="Moves the second group into a new set">
          Split
        </button>
      </div>
    </div>
  );
}

/** Switches between sets, or starts a new one; `label` shows beside the arrow where no set name sits next to it. */
function SetMenu({ label }: { label?: string }) {
  const { sets, currentId, select, add } = useSets();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: PointerEvent) => !(e.target instanceof Node && ref.current?.contains(e.target)) && setOpen(false);
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [open]);
  return (
    <div ref={ref} className="relative">
      <button className="btn px-2" aria-label="Sets" aria-expanded={open} onClick={() => setOpen(!open)}>
        {label ? `${label} ▾` : "▾"}
      </button>
      {open && (
        <div className="absolute right-0 top-full z-30 mt-1 w-64 rounded-lg border border-white/10 bg-zinc-900 p-1 shadow-xl">
          {sets.map((s) => (
            <button
              key={s.id}
              onClick={() => (select(s.id), setOpen(false))}
              className={`flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-sm hover:bg-white/10 ${s.id === currentId ? "text-zinc-50" : "text-zinc-300"}`}
            >
              <span className="min-w-0 flex-1 truncate">{s.name}</span>
              <span className="text-xs text-zinc-500">{s.ids.length}</span>
            </button>
          ))}
          <button onClick={() => (add(), setOpen(false))} className="w-full rounded-md px-2.5 py-1.5 text-left text-sm text-zinc-400 hover:bg-white/10 hover:text-zinc-100">
            New set
          </button>
        </div>
      )}
    </div>
  );
}

/** Saves the set as a private playlist (out of sorting), then offers to update that playlist rather than make another. */
function SaveButton({ set }: { set: BuildSet }) {
  const saveList = useApp((s) => s.saveList);
  const pendingWrites = useApp((s) => s.pendingWrites);
  const markSaved = useSets((s) => s.markSaved);
  const [saving, setSaving] = useState<string | null>(null); // the set being saved
  useEffect(() => {
    if (pendingWrites === 0) setSaving(null);
  }, [pendingWrites]);
  const upToDate = set.saved?.name === set.name && set.saved.ids.join() === set.ids.join();
  const busy = saving === set.id;
  return (
    <button
      className="btn whitespace-nowrap border-transparent bg-commit font-semibold text-zinc-950 hover:bg-commit/85"
      disabled={busy || upToDate}
      title={set.saved ? undefined : "Creates a private playlist, hidden from sorting suggestions"}
      onClick={() => {
        const { id, name, ids } = set;
        setSaving(id);
        saveList(name, ids, set.saved?.playlistId, (playlistId) => markSaved(id, { playlistId, ids, name }));
      }}
    >
      {busy ? "Saving…" : upToDate ? "Saved" : set.saved ? "Update playlist" : "Save to Spotify"}
    </button>
  );
}

/**
 * The input at the bottom of the list (or the whole screen for an empty set): pasted Spotify links (tracks, albums,
 * playlists, several at once) are added as they're pasted; typing searches the library's songs and playlists.
 */
function AddSongs({
  big,
  lib,
  pool,
  onMap,
  fresh,
  onSongs,
  onPlaylist,
}: {
  big: boolean;
  lib: Library;
  pool: Map<string, Track>;
  onMap: ReadonlySet<string>;
  fresh: (t: Track) => boolean;
  onSongs: (ids: string[], extra: Track[]) => void;
  onPlaylist: (p: { name: string; trackIds: string[] }) => void;
}) {
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  type Result = { key: string; label: string; detail: string; run: () => void };
  const results = ((): Result[] => {
    const q = query.trim().toLowerCase();
    if (q.length < 2 || parseSpotifyLinks(query).length) return [];
    const playlists = lib.playlists
      .filter((p) => p.name.toLowerCase().includes(q))
      .slice(0, 3)
      .map((p) => ({ key: p.id, label: p.name, detail: `${p.trackIds.length} songs`, run: () => onPlaylist(p) }));
    const songs = [...pool.values()]
      .filter((t) => fresh(t) && `${t.name} ${t.artists.map((a) => a.name).join(" ")}`.toLowerCase().includes(q))
      .slice(0, SEARCH_RESULTS)
      .map((t) => ({ key: t.id, label: t.name, detail: artistNames(t), run: () => onSongs([t.id], []) }));
    return [...playlists, ...songs];
  })();

  /** Adds every song behind the links; a link that fails doesn't stop the others. */
  const addLinks = async (text: string) => {
    setBusy(true);
    setError(null);
    const ids: string[] = [];
    const extra: Track[] = [];
    let failed = 0;
    for (const link of parseSpotifyLinks(text)) {
      try {
        const got = await resolveLinks(lib, onMap, [link]);
        ids.push(...got.ids);
        extra.push(...got.extra);
      } catch (e) {
        console.error(e);
        failed++;
      }
    }
    onSongs(ids, extra);
    setBusy(false);
    setQuery("");
    if (failed) setError(failed === 1 ? "Spotify couldn't open one of those links." : `Spotify couldn't open ${failed} of those links.`);
  };

  const choose = (r: Result | undefined) => {
    if (!r) return;
    r.run();
    setQuery("");
    setCursor(0);
  };

  return (
    <div className="relative">
      <input
        value={query}
        disabled={busy}
        onChange={(e) => (setQuery(e.target.value), setCursor(0), setError(null))}
        onPaste={(e) => {
          const text = e.clipboardData.getData("text");
          if (parseSpotifyLinks(text).length) (e.preventDefault(), void addLinks(text));
        }}
        onKeyDown={(e) => {
          if (e.key === "Escape") setQuery("");
          else if (e.key === "ArrowDown") (e.preventDefault(), setCursor((c) => Math.min(c + 1, results.length - 1)));
          else if (e.key === "ArrowUp") (e.preventDefault(), setCursor((c) => Math.max(c - 1, 0)));
          else if (e.key === "Enter") {
            e.preventDefault();
            if (parseSpotifyLinks(query).length) void addLinks(query);
            else choose(results[cursor]);
          }
        }}
        placeholder={busy ? "Adding…" : "Paste a Spotify link, or search"}
        autoFocus={big}
        className={`w-full rounded-lg border border-dashed border-white/20 bg-transparent text-zinc-100 placeholder:text-zinc-500 focus:border-white/40 focus:outline-none ${
          big ? "px-4 py-3.5 text-lg" : "px-3 py-2 text-sm"
        }`}
      />
      {error && <p className="mt-1.5 text-xs text-rose-400">{error}</p>}
      {results.length > 0 && (
        <div className="absolute z-20 mt-1 w-full overflow-hidden rounded-lg border border-white/10 bg-zinc-900 shadow-xl">
          {results.map((r, i) => (
            <button
              key={r.key}
              onMouseEnter={() => setCursor(i)}
              onClick={() => choose(r)}
              className={`flex w-full items-center gap-2 px-3 py-2 text-left text-sm ${i === cursor ? "bg-white/10" : ""}`}
            >
              <span className="min-w-0 truncate text-zinc-100">{r.label}</span>
              <span className="ml-auto shrink-0 truncate text-xs text-zinc-500">{r.detail}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** The handoff playing: its two songs, and how far through it is, with the switch between them marked. */
function SeamStrip({ from, to }: { from: Track; to: Track }) {
  const { trackId, paused, position, duration, updatedAt, toggle } = usePlayer();
  const [, tick] = useState(0);
  useEffect(() => {
    if (paused) return;
    const timer = setInterval(() => tick((t) => t + 1), 250);
    return () => clearInterval(timer);
  }, [paused]);
  const now = paused ? position : position + (performance.now() - updatedAt);
  const elapsed = trackId === from.id ? SEAM_MS - (duration - now) : trackId === to.id ? SEAM_MS + now : 0;
  const share = Math.min(Math.max(elapsed / (2 * SEAM_MS), 0), 1);
  return (
    <div className="sticky bottom-3 mt-3 flex items-center gap-3 rounded-lg bg-zinc-800 px-3 py-2 text-xs text-zinc-200 shadow-xl">
      <button aria-label={paused ? "Play" : "Pause"} className="text-zinc-300 hover:text-zinc-50" onClick={toggle}>
        {paused ? <PlayIcon /> : <PauseIcon />}
      </button>
      <span className="max-w-[55%] truncate">
        {from.name} → {to.name}
      </span>
      <div className="relative h-[3px] flex-1 rounded-full bg-white/10">
        <div className="h-full rounded-full bg-zinc-100" style={{ width: `${share * 100}%` }} />
        <div className="absolute -bottom-[3px] -top-[3px] left-1/2 w-px bg-zinc-400" />
      </div>
    </div>
  );
}

type Seam = { from: Track; to: Track; phase: "out" | "in" };

/**
 * Plays a handoff on Spotify: the last SEAM_MS of `from`, then the first SEAM_MS of `to`, then pauses. The switch
 * is timed from the position Spotify reports (on a timer until it reports one). It stops following along, without
 * touching playback, once something else plays.
 */
function useSeam() {
  const { trackId, paused, position, updatedAt, duration } = usePlayer();
  const [seam, setSeam] = useState<Seam | null>(null);
  const live = useRef<Seam | null>(null);
  /** Whether Spotify has reported this phase's song playing yet. */
  const seen = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const enter = (next: Seam | null) => {
    live.current = next;
    seen.current = false;
    setSeam(next);
  };
  const after = (ms: number, fn: () => void) => {
    clearTimeout(timer.current);
    timer.current = setTimeout(fn, Math.max(ms, 0));
  };
  const stop = () => {
    clearTimeout(timer.current);
    enter(null);
  };
  const finish = () => {
    const p = usePlayer.getState();
    if (p.trackId === live.current?.to.id && !p.paused) p.toggle();
    stop();
  };
  const switchToNext = () => {
    const s = live.current;
    if (!s) return;
    enter({ ...s, phase: "in" });
    void usePlayer.getState().play(s.to.id, s.to.durationMs, 0);
    after(SEAM_MS + UNCONFIRMED_EARLY_MS, finish);
  };
  const start = (from: Track, to: Track) => {
    const p = usePlayer.getState();
    if (!p.enabled) return openInSpotify(from.id);
    enter({ from, to, phase: "out" });
    void p.play(from.id, from.durationMs, Math.max(from.durationMs - SEAM_MS, 0) / from.durationMs);
    after(SEAM_MS - UNCONFIRMED_EARLY_MS, switchToNext);
  };

  useEffect(() => {
    const s = live.current;
    if (!s) return;
    const expected = s.phase === "out" ? s.from.id : s.to.id;
    if (trackId === expected) {
      seen.current = true;
      if (paused) return clearTimeout(timer.current);
      const at = position + (performance.now() - updatedAt);
      if (s.phase === "out") after(duration - at - ADVANCE_EARLY_MS, switchToNext);
      else after(SEAM_MS - at, finish);
    } else if (seen.current && trackId !== s.from.id && trackId !== s.to.id) stop();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trackId, paused, position, updatedAt, duration]);
  useEffect(() => () => clearTimeout(timer.current), []);

  return { seam, start, stop };
}
