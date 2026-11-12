// Playlists tab: a workshop for one of your playlists. Split divides it into groups by sound or by what the lyrics
// are about, to save as smaller playlists (the parent stays as it is), Missing finds songs in your library it
// probably should have, and Doesn't fit lists its own songs least likely to belong. A playlist with an artist rule
// is checked against the rule instead: Missing is its artists' other songs, Doesn't fit the songs by anyone else.
import { useEffect, useMemo, useState } from "react";
import { doubted, missing, type Evidence, type Scored } from "../core/belong.ts";
import { config } from "../core/config.ts";
import { isArtistPlaylist, sortTargets, type Playlist, type Track } from "../core/library.ts";
import { soundGroups, themeGroups } from "../core/split.ts";
import type { ThemeIndex } from "../core/themes.ts";
import { closeTo, topArtists, traits, type TraitData } from "../core/traits.ts";
import { usePlayer } from "./player.ts";
import { useSets } from "./sets.ts";
import { useApp } from "./store.ts";
import { groupsOf, replaceGroup, updateGroup, useWorkshop, type By, type Group, type Split } from "./workshop.ts";

const SELECTED_KEY = "playlists-tab-selected";
const KS = [2, 3, 4, 5, 6] as const;
const DEFAULT_K = 3;
/** Smaller playlists show their songs instead of a split. */
const MIN_SPLIT = 4;
/** Groups smaller than this have no Split button. */
const MIN_SUBSPLIT = 8;
const CARD_SONGS = 8;
const PAGE = 40;
const MISSING_LIMIT = 200;
const CHIPS = 3;
const CLOSE = 2;

type Mode = "split" | "missing" | "doubted";
const MODES: Record<Mode, string> = { split: "Split", missing: "Missing", doubted: "Doesn't fit" };

const BYS: Record<By, string> = { sound: "Sound", lyrics: "Lyrics" };

type Sound = NonNullable<Evidence["sound"]>;

const artistNames = (t: Track) => t.artists.map((a) => a.name).join(", ");
const play = (t: Track) => void usePlayer.getState().play(t.id, t.durationMs);

function readSelected() {
  try {
    return localStorage.getItem(SELECTED_KEY);
  } catch {
    return null;
  }
}

/** The tab. `onOpenBuild` switches to the Build tab after a group was opened there as a new set. */
export function PlaylistsView({ colors, onOpenBuild }: { colors: Map<string, string>; onOpenBuild: () => void }) {
  const { lib, audio, vectors, classifier, features, languages, tags, themes, rules, hidden } = useApp();
  const [selected, setSelected] = useState(readSelected);
  const [filter, setFilter] = useState("");
  const [mode, setMode] = useState<Mode>("split");

  useEffect(() => {
    useApp.getState().loadFeatures();
    useApp.getState().loadTags();
  }, []);
  useEffect(() => {
    try {
      if (selected) localStorage.setItem(SELECTED_KEY, selected);
    } catch {
      // Blocked storage only means the selection resets on reload.
    }
  }, [selected]);

  const playlists = useMemo(() => (lib ? sortTargets(lib).toSorted((a, b) => b.trackIds.length - a.trackIds.length) : []), [lib]);
  const all = useMemo(() => lib?.playlists.find((p) => p.id === config.allPlaylistId)?.trackIds ?? [], [lib]);
  const sound = useMemo((): Sound | undefined => (audio && vectors ? { index: audio, vectors } : undefined), [audio, vectors]);
  // Until one is picked (or when the picked one is gone), the biggest playlist is open.
  const playlist = playlists.find((p) => p.id === selected) ?? playlists[0];
  const rule = playlist && rules[playlist.id];
  const evidence = useMemo((): Evidence => {
    const artists = rule && new Set(rule.map((a) => a.id));
    return { classifier, sound, byRule: artists && lib ? (id) => !!lib.tracks[id]?.artists.some((a) => artists.has(a.id)) : undefined };
  }, [classifier, sound, rule, lib]);
  const data = useMemo((): TraitData | null => (lib ? { lib, features, languages, tags } : null), [lib, features, languages, tags]);
  // trackId -> the playlists it's in, smallest first: the chips on Missing and Doesn't fit rows.
  const memberOf = useMemo(() => {
    const out = new Map<string, Playlist[]>();
    for (const p of playlists.toReversed()) for (const id of p.trackIds) out.set(id, [...(out.get(id) ?? []), p]);
    return out;
  }, [playlists]);

  // Playlists a split group can turn out to be close to: the ones about a sound, not artist compilations or hidden lists.
  const soundPlaylists = useMemo(
    () => (lib ? playlists.filter((p) => !hidden.includes(p.id) && !rules[p.id] && !isArtistPlaylist(lib, p)) : []),
    [lib, playlists, hidden, rules],
  );

  const headerTraits = useMemo(() => (data && playlist ? traits(data, playlist.trackIds, all) : []), [data, playlist, all]);

  if (!lib || !data) return null;
  const q = filter.trim().toLowerCase();
  const shown = q ? playlists.filter((p) => p.name.toLowerCase().includes(q)) : playlists;

  return (
    <div className="grid gap-6 md:grid-cols-[260px_minmax(0,1fr)]">
      <aside className="min-w-0 md:sticky md:top-4 md:max-h-[calc(100vh-6rem)] md:self-start md:overflow-y-auto">
        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter"
          className="mb-2 w-full rounded-lg border border-white/10 bg-transparent px-2.5 py-1.5 text-sm text-zinc-100 placeholder:text-zinc-500 focus:border-white/30 focus:outline-none"
        />
        <ul className="max-h-64 overflow-y-auto md:max-h-none">
          {shown.map((p) => (
            <li key={p.id}>
              <button
                onClick={() => setSelected(p.id)}
                className={`flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-sm ${p.id === playlist?.id ? "bg-white/10 text-zinc-50" : "text-zinc-300 hover:bg-white/5"} ${hidden.includes(p.id) ? "opacity-50" : ""}`}
              >
                <span className="size-2 shrink-0 rounded-full" style={{ background: colors.get(p.id) }} />
                <span className="min-w-0 flex-1 truncate">{p.name}</span>
                <span className="shrink-0 text-xs text-zinc-500">{p.trackIds.length}</span>
              </button>
            </li>
          ))}
        </ul>
      </aside>

      {playlist && (
        <main className="min-w-0">
          <header className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-2">
            <h2 className="min-w-0 truncate text-lg font-semibold text-zinc-50">{playlist.name}</h2>
            <span className="text-sm text-zinc-400">{playlist.trackIds.length} songs</span>
            <Chips words={headerTraits} />
            <Segmented className="ml-auto" options={Object.keys(MODES) as Mode[]} value={mode} label={(m) => MODES[m]} onChange={setMode} />
          </header>
          {mode === "split" && <SplitPane key={playlist.id} playlist={playlist} sound={sound} themes={themes} data={data} others={soundPlaylists} colors={colors} onOpenBuild={onOpenBuild} />}
          {mode === "missing" && <MissingPane key={playlist.id} playlist={playlist} all={all} evidence={evidence} memberOf={memberOf} colors={colors} />}
          {mode === "doubted" && <DoubtedPane key={playlist.id} playlist={playlist} evidence={evidence} memberOf={memberOf} colors={colors} />}
        </main>
      )}
    </div>
  );
}

/** Short words as dim chips. */
function Chips({ words }: { words: string[] }) {
  if (words.length === 0) return null;
  return (
    <span className="flex flex-wrap gap-1">
      {words.map((w) => (
        <span key={w} className="rounded-full bg-white/[0.06] px-2 py-0.5 text-xs text-zinc-400">
          {w}
        </span>
      ))}
    </span>
  );
}

/** A row of mutually exclusive buttons. */
function Segmented<T extends string | number>({
  options,
  value,
  label = String,
  onChange,
  className = "",
}: {
  options: readonly T[];
  value: T;
  label?: (v: T) => string;
  onChange: (v: T) => void;
  className?: string;
}) {
  return (
    <div className={`inline-flex overflow-hidden rounded-lg border border-white/10 text-sm ${className}`}>
      {options.map((o) => (
        <button key={o} onClick={() => onChange(o)} className={`px-3 py-1 ${value === o ? "bg-white/10 text-zinc-50" : "text-zinc-400 hover:text-zinc-200"}`}>
          {label(o)}
        </button>
      ))}
    </div>
  );
}

/** Title and artists; clicking plays it. */
function SongButton({ track }: { track: Track }) {
  return (
    <button className="min-w-0 flex-1 truncate text-left text-sm text-zinc-100" onClick={() => play(track)}>
      {track.name} <span className="text-xs text-zinc-400">{artistNames(track)}</span>
    </button>
  );
}

/** The playlist's groups, by sound or by lyrics, as cards to rename, trim, split further, and save. */
function SplitPane({
  playlist,
  sound,
  themes,
  data,
  others,
  colors,
  onOpenBuild,
}: {
  playlist: Playlist;
  sound: Sound | undefined;
  themes: ThemeIndex | null;
  data: TraitData;
  /** The playlists a group can be close to. */
  others: Playlist[];
  colors: Map<string, string>;
  onOpenBuild: () => void;
}) {
  const split = useWorkshop((s) => s.splits[playlist.id]);
  const change = useWorkshop((s) => s.change);
  const big = playlist.trackIds.length >= MIN_SPLIT;
  const words = useMemo(() => split?.groups.map((g) => traits(data, g.ids, playlist.trackIds)) ?? [], [split?.groups, data, playlist.trackIds]);
  const close = useMemo(() => {
    const rest = others.filter((p) => p.id !== playlist.id);
    return (
      split?.groups.map((g) =>
        closeTo(g.ids, playlist.trackIds, rest, CLOSE).flatMap(({ id, count }) => {
          const p = rest.find((o) => o.id === id);
          return p ? [{ name: p.name, color: colors.get(id), count }] : [];
        }),
      ) ?? []
    );
  }, [split?.groups, others, playlist, colors]);
  // Each group's default name takes its theme, or its first trait that no earlier group's took, or its number.
  const defaults = useMemo(() => {
    const used = new Set<string>();
    return words.map((w, i) => {
      const pick = split?.groups[i]?.theme ?? w.find((x) => !used.has(x));
      if (pick) used.add(pick);
      return `${playlist.name} · ${pick ?? i + 1}`;
    });
  }, [words, split?.groups, playlist.name]);

  /** Groups the whole playlist anew into `k`, discarding edits. */
  const regroup = (by: By, k: number) => {
    if (by === "lyrics") {
      if (!themes) return;
      const { groups, names, unplaced } = themeGroups(themes, data.lib, playlist.trackIds, k);
      change(playlist.id, () => ({ by, k, groups: groupsOf(groups, names), unplaced }));
    } else if (sound) {
      const { groups, unplaced } = soundGroups(sound, playlist.trackIds, k);
      change(playlist.id, () => ({ by, k, groups: groupsOf(groups), unplaced }));
    }
  };
  useEffect(() => {
    if (!split && sound && big) regroup("sound", DEFAULT_K);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [split, sound, big]);

  if (!big)
    return (
      <div className="rounded-xl bg-zinc-900 px-3 py-2">
        {playlist.trackIds.map((id) => {
          const t = data.lib.tracks[id];
          return t ? <div key={id} className="flex py-1"><SongButton track={t} /></div> : null;
        })}
      </div>
    );
  if (!sound || !split) return null;

  const edit = (fn: (s: Split) => Split) => change(playlist.id, (s) => fn(s!));
  return (
    <div className="@container">
      <div className="mb-3 flex flex-wrap gap-2">
        {themes && <Segmented options={Object.keys(BYS) as By[]} value={split.by} label={(by) => BYS[by]} onChange={(by) => by !== split.by && regroup(by, split.k)} />}
        <Segmented options={KS} value={split.k} onChange={(k) => k !== split.k && regroup(split.by, k)} />
      </div>
      <div className="grid gap-3 @2xl:grid-cols-2 @5xl:grid-cols-3">
        {split.groups.map((g, i) => (
          <GroupCard
            key={g.key}
            group={g}
            words={words[i] ?? []}
            close={close[i] ?? []}
            fallback={defaults[i] ?? playlist.name}
            data={data}
            onEdit={(fn) => edit((s) => updateGroup(s, g.key, fn))}
            onSplit={() => edit((s) => replaceGroup(s, g.key, soundGroups(sound, g.ids, 2).groups))}
            onSaved={() => change(playlist.id, (s) => updateGroup(s!, g.key, () => ({ saved: true })))}
            onOpenBuild={onOpenBuild}
          />
        ))}
      </div>
      {split.unplaced.length > 0 && (
        <p className="mt-3 text-xs text-zinc-500">
          {split.unplaced.length === 1 ? "1 song has" : `${split.unplaced.length} songs have`} {split.by === "lyrics" ? "no clear theme" : "no sound yet"}
        </p>
      )}
    </div>
  );
}

/** One group: its name, what sets it apart, its songs, and what to do with it. */
function GroupCard({
  group,
  words,
  close,
  fallback,
  data,
  onEdit,
  onSplit,
  onSaved,
  onOpenBuild,
}: {
  group: Group;
  /** What sets the group apart from the rest of the playlist. */
  words: string[];
  /** Playlists you already have that hold much of the group, with how many of its songs. */
  close: { name: string; color: string | undefined; count: number }[];
  /** The name shown until one is typed. */
  fallback: string;
  data: TraitData;
  onEdit: (fn: (g: Group) => Partial<Group>) => void;
  onSplit: () => void;
  onSaved: () => void;
  onOpenBuild: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const pendingWrites = useApp((s) => s.pendingWrites);
  const artists = useMemo(() => topArtists(data.lib, group.ids, 3), [data.lib, group.ids]);
  const name = group.name ?? fallback;
  const songs = expanded ? group.ids : group.ids.slice(0, CARD_SONGS);
  const saving = group.saving && !group.saved && pendingWrites > 0;

  return (
    <div className="flex min-w-0 flex-col gap-2 rounded-xl bg-zinc-900 p-3">
      <input
        aria-label="Group name"
        value={name}
        onChange={(e) => onEdit(() => ({ name: e.target.value }))}
        onBlur={(e) => !e.target.value.trim() && onEdit(() => ({ name: null }))}
        className="-mx-1 min-w-0 rounded-md bg-transparent px-1 py-0.5 text-base font-semibold text-zinc-50 hover:bg-white/5 focus:bg-white/5 focus:outline-none"
      />
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-sm text-zinc-400">{group.ids.length}</span>
        <Chips words={words} />
        {close.map((p) => (
          <span key={p.name} title={`${p.count} of ${group.ids.length} are in ${p.name}`} className="flex min-w-0 items-center gap-1 rounded-full bg-white/[0.06] px-2 py-0.5 text-xs text-zinc-300">
            <span className="size-1.5 shrink-0 rounded-full" style={{ background: p.color }} />
            <span className="truncate">{p.name}</span>
            <span className="text-zinc-500">{Math.round((p.count / group.ids.length) * 100)}%</span>
          </span>
        ))}
      </div>
      {artists.length > 0 && <p className="truncate text-xs text-zinc-500">{artists.join(", ")}</p>}
      <ul className={expanded ? "max-h-80 overflow-y-auto" : ""}>
        {songs.map((id) => {
          const t = data.lib.tracks[id];
          if (!t) return null;
          return (
            <li key={id} className="group flex items-center gap-1 py-0.5">
              <SongButton track={t} />
              <button
                aria-label={`Drop ${t.name}`}
                className="invisible px-1 text-zinc-500 hover:text-zinc-100 group-hover:visible"
                onClick={() => onEdit((g) => ({ ids: g.ids.filter((x) => x !== id) }))}
              >
                ×
              </button>
            </li>
          );
        })}
      </ul>
      {!expanded && group.ids.length > CARD_SONGS && (
        <button className="self-start text-xs text-zinc-400 hover:text-zinc-100" onClick={() => setExpanded(true)}>
          Show all {group.ids.length}
        </button>
      )}
      <div className="mt-auto flex flex-wrap gap-1.5 pt-1">
        {group.ids.length >= MIN_SUBSPLIT && (
          <button className="btn px-2 py-0.5 text-xs" onClick={onSplit}>
            Split
          </button>
        )}
        <button
          className="btn px-2 py-0.5 text-xs"
          onClick={() => {
            useSets.getState().open(name, group.ids);
            onOpenBuild();
          }}
        >
          Open in Build
        </button>
        <button
          className="btn ml-auto border-transparent bg-commit px-2 py-0.5 text-xs font-semibold text-zinc-950 hover:bg-commit/85"
          disabled={group.saved || saving}
          onClick={() => {
            onEdit(() => ({ saving: true }));
            useApp.getState().savePlaylist(name.trim() || fallback, group.ids, onSaved);
          }}
        >
          {group.saved ? "Saved" : saving ? "Saving…" : "Save as playlist"}
        </button>
      </div>
    </div>
  );
}

/** Up to CHIPS of the playlists a song is in (other than `except`), smallest first, in their colors. */
function PlaylistChips({ of, except, colors }: { of: Playlist[] | undefined; except: string; colors: Map<string, string> }) {
  const shown = (of ?? []).filter((p) => p.id !== except).slice(0, CHIPS);
  return (
    <span className="hidden min-w-0 shrink gap-1 overflow-hidden sm:flex">
      {shown.map((p) => (
        <span key={p.id} className="flex min-w-0 max-w-32 items-center gap-1 rounded-full bg-white/[0.06] px-2 py-0.5 text-[11px] text-zinc-300">
          <span className="size-1.5 shrink-0 rounded-full" style={{ background: colors.get(p.id) }} />
          <span className="truncate">{p.name}</span>
        </span>
      ))}
    </span>
  );
}

/** How likely a song belongs, 0–1, as a thin bar. */
const ScoreBar = ({ score }: { score: number }) => (
  <span className="h-[3px] w-12 shrink-0 rounded-full bg-white/10">
    <span className="block h-full rounded-full bg-zinc-300" style={{ width: `${score * 100}%` }} />
  </span>
);

type RowsProps = { playlist: Playlist; evidence: Evidence; memberOf: Map<string, Playlist[]>; colors: Map<string, string> };

/** Songs in your library the playlist probably should have; checked ones can be added to it. */
function MissingPane({ playlist, all, evidence, memberOf, colors }: RowsProps & { all: string[] }) {
  const lib = useApp((s) => s.lib)!;
  const [checked, setChecked] = useState<ReadonlySet<string>>(new Set());
  const [limit, setLimit] = useState(PAGE);

  const found = useMemo(() => {
    const members = new Set(playlist.trackIds);
    return missing(evidence, playlist, new Set(all.filter((id) => !members.has(id))), MISSING_LIMIT);
  }, [evidence, playlist, all]);
  const picked = found.filter((s) => checked.has(s.id)).map((s) => s.id);

  const toggle = (id: string) =>
    setChecked((c) => {
      const next = new Set(c);
      if (!next.delete(id)) next.add(id);
      return next;
    });

  return (
    <div className="rounded-xl bg-zinc-900 px-3 pb-2">
      <div className="sticky top-0 z-10 -mx-3 flex justify-end rounded-t-xl bg-zinc-900 px-3 py-2">
        <button
          className="btn px-2.5 py-0.5 text-xs"
          disabled={picked.length === 0}
          onClick={() => {
            useApp.getState().addToPlaylist(playlist.id, picked);
            setChecked(new Set());
          }}
        >
          Add {picked.length}
        </button>
      </div>
      <Rows
        scored={found.slice(0, limit)}
        lib={lib}
        render={(s, t) => (
          <>
            <input type="checkbox" aria-label={`Pick ${t.name}`} checked={checked.has(s.id)} onChange={() => toggle(s.id)} className="accent-zinc-300" />
            <SongButton track={t} />
            <PlaylistChips of={memberOf.get(s.id)} except={playlist.id} colors={colors} />
            {!evidence.byRule && <ScoreBar score={s.score} />}
          </>
        )}
      />
      {found.length === 0 && <Empty>Nothing missing</Empty>}
      {found.length > limit && <ShowMore onClick={() => setLimit(limit + PAGE)} />}
    </div>
  );
}

/** The playlist's songs least likely to belong; each can be removed from it, and put back until you leave. */
function DoubtedPane({ playlist, evidence, memberOf, colors }: RowsProps) {
  const lib = useApp((s) => s.lib)!;
  const [removed, setRemoved] = useState<ReadonlySet<string>>(new Set());
  const [limit, setLimit] = useState(PAGE);
  // The songs as the pane opened, so removed rows keep their place.
  const [ids] = useState(playlist.trackIds);
  const found = useMemo(() => doubted(evidence, { id: playlist.id, trackIds: ids }), [evidence, playlist.id, ids]);
  const { addToPlaylist, removeFromPlaylist } = useApp.getState();

  const mark = (id: string, gone: boolean) =>
    setRemoved((r) => {
      const next = new Set(r);
      if (gone) next.add(id);
      else next.delete(id);
      return next;
    });

  return (
    <div className="rounded-xl bg-zinc-900 px-3 py-2">
      <Rows
        scored={found.slice(0, limit)}
        lib={lib}
        dimmed={removed}
        render={(s, t) => (
          <>
            <SongButton track={t} />
            <PlaylistChips of={memberOf.get(s.id)} except={playlist.id} colors={colors} />
            {!evidence.byRule && <ScoreBar score={s.score} />}
            {removed.has(s.id) ? (
              <button className="btn w-20 px-2 py-0.5 text-xs opacity-100" onClick={() => (addToPlaylist(playlist.id, [s.id]), mark(s.id, false))}>
                Undo
              </button>
            ) : (
              <button className="btn w-20 px-2 py-0.5 text-xs" onClick={() => (removeFromPlaylist(playlist.id, [s.id]), mark(s.id, true))}>
                Remove
              </button>
            )}
          </>
        )}
      />
      {found.length === 0 && <Empty>Everything fits</Empty>}
      {found.length > limit && <ShowMore onClick={() => setLimit(limit + PAGE)} />}
    </div>
  );
}

/** Scored songs as rows; `render` fills each row. */
function Rows({
  scored,
  lib,
  dimmed,
  render,
}: {
  scored: Scored[];
  lib: { tracks: Record<string, Track> };
  dimmed?: ReadonlySet<string>;
  render: (s: Scored, t: Track) => React.ReactNode;
}) {
  return (
    <ul>
      {scored.map((s) => {
        const t = lib.tracks[s.id];
        return t ? (
          <li key={s.id} className={`flex items-center gap-2.5 py-1 ${dimmed?.has(s.id) ? "[&>*:not(:last-child)]:opacity-40" : ""}`}>
            {render(s, t)}
          </li>
        ) : null;
      })}
    </ul>
  );
}

const Empty = ({ children }: { children: string }) => <p className="py-1 text-sm text-zinc-500">{children}</p>;

const ShowMore = ({ onClick }: { onClick: () => void }) => (
  <button className="mt-1 text-xs text-zinc-400 hover:text-zinc-100" onClick={onClick}>
    Show more
  </button>
);
