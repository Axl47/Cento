// Revisit tab: saved songs worth another look, from play history (see src/core/review.ts). Rediscover is favorites
// gone quiet, Fading is songs being tired of: skipped more than they were, or mid-song more than songs heard as often
// (each can be taken out of the playlists holding it, with Undo until you leave the tab), and Never played is songs saved but never heard.
import { useEffect, useMemo, useState } from "react";
import { sortTargets, type Playlist } from "../core/library.ts";
import type { YearPlays } from "../core/plays.ts";
import { fading, neverPlayed, rediscover, type Fade, type Stretch } from "../core/review.ts";
import { Empty, PAGE, ShowMore, SongButton } from "./rows.tsx";
import { useApp } from "./store.ts";

type List = "rediscover" | "fading" | "never";
const LISTS: Record<List, string> = { rediscover: "Rediscover", fading: "Fading", never: "Never played" };
const LIST_KEY = "revisit-tab-list";

const isList = (name: string | null): name is List => name !== null && Object.hasOwn(LISTS, name);

function storedList(): List {
  try {
    const name = localStorage.getItem(LIST_KEY);
    return isList(name) ? name : "rediscover";
  } catch {
    return "rediscover";
  }
}

const month = (iso: string) => new Date(iso).toLocaleDateString(undefined, { month: "short", year: "numeric" });

export function RevisitView({ colors }: { colors: Map<string, string> }) {
  const { lib, plays, playYears, midSkips } = useApp();
  const [list, setList] = useState(storedList);
  const [limit, setLimit] = useState(PAGE);
  useEffect(() => useApp.getState().loadPlays(), []);

  // The playlists as the tab opened, so a song taken out of one keeps its chip (with Undo) until you leave.
  const [playlists] = useState(() => (lib ? sortTargets(lib) : []));
  const holders = useMemo(() => {
    const of = new Map<string, Playlist[]>();
    for (const p of playlists.toSorted((a, b) => a.trackIds.length - b.trackIds.length))
      for (const id of p.trackIds) of.set(id, [...(of.get(id) ?? []), p]);
    return of;
  }, [playlists]);

  const lists = useMemo(() => {
    if (!lib || !plays || !playYears) return null;
    const saved = new Set(Object.keys(lib.tracks));
    const now = new Date();
    return { rediscover: rediscover(plays, saved, now), fading: fading(plays, playYears, midSkips, saved, now), never: neverPlayed(plays, lib) };
  }, [lib, plays, playYears, midSkips]);

  const choose = (next: List) => {
    setList(next);
    setLimit(PAGE);
    try {
      localStorage.setItem(LIST_KEY, next);
    } catch {
      // Remembering the list is a convenience.
    }
  };

  if (!lib || !lists) return null;
  const shown = lists[list];

  return (
    <div className="mx-auto max-w-4xl space-y-3">
      <nav className="flex w-max rounded-lg border border-white/10 bg-zinc-900 p-0.5 text-sm">
        {(Object.keys(LISTS) as List[]).map((l) => (
          <button
            key={l}
            onClick={() => choose(l)}
            className={`rounded-md px-3 py-1 ${list === l ? "bg-white/10 text-zinc-50" : "text-zinc-400 hover:text-zinc-200"}`}
          >
            {LISTS[l]} <span className="text-xs text-zinc-500">{lists[l].length}</span>
          </button>
        ))}
      </nav>
      <ul className="rounded-xl bg-zinc-900 px-3 py-2">
        {list === "rediscover" &&
          lists.rediscover.slice(0, limit).map((s) => (
            <Row key={s.id} id={s.id}>
              <Stat>
                peak {s.peak.year} · last {month(s.last)}
              </Stat>
            </Row>
          ))}
        {list === "fading" &&
          lists.fading.slice(0, limit).map((s) => (
            <Row key={s.id} id={s.id}>
              <YearBars years={s.years} />
              <Evidence fade={s} />
              <RemoveChips id={s.id} of={holders.get(s.id)} colors={colors} />
            </Row>
          ))}
        {list === "never" &&
          lists.never.slice(0, limit).map((s) => (
            <Row key={s.id} id={s.id}>
              {s.skips > 0 && <Stat>skipped {s.skips}×</Stat>}
              {s.addedAt && <Stat>added {month(s.addedAt)}</Stat>}
              <Chips of={holders.get(s.id)} colors={colors} />
            </Row>
          ))}
        {shown.length === 0 && <Empty>Nothing here</Empty>}
      </ul>
      {shown.length > limit && <ShowMore onClick={() => setLimit(limit + PAGE)} />}
    </div>
  );
}

function Row({ id, children }: { id: string; children: React.ReactNode }) {
  const track = useApp((s) => s.lib?.tracks[id]);
  if (!track) return null;
  return (
    <li className="flex items-center gap-3 border-t border-white/5 py-1.5 first:border-t-0">
      <SongButton track={track} />
      {children}
    </li>
  );
}

const Stat = ({ children }: { children: React.ReactNode }) => <span className="shrink-0 font-mono text-[11px] text-zinc-400">{children}</span>;

/** Plays per year from the song's first through this one as bars, the skipped part in red, scaled to its busiest year. */
function YearBars({ years }: { years: readonly YearPlays[] }) {
  const most = Math.max(...years.map((y) => y.plays + y.skips));
  const height = (n: number) => `${(22 * n) / most}px`;
  const first = years[0]?.year ?? 0;
  const all = Array.from({ length: new Date().getFullYear() - first + 1 }, (_, i) => {
    const year = first + i;
    return years.find((y) => y.year === year) ?? { year, plays: 0, skips: 0, shuffled: 0 };
  });
  return (
    <span className="flex h-[22px] shrink-0 items-end gap-0.5">
      {all.map((y) => (
        <span key={y.year} title={`${y.year}: ${y.plays} played, ${y.skips} skipped`} className="flex w-1.5 flex-col justify-end">
          <span className="bg-rose-400" style={{ height: height(y.skips) }} />
          <span className="bg-zinc-500" style={{ height: height(y.plays) }} />
        </span>
      ))}
    </span>
  );
}

const share = (s: Stretch) => `${Math.round((100 * s.skips) / (s.plays + s.skips))}%`;

/**
 * Why a song is fading: the share of plays skipped before last year, then since, with the counts behind each, and/or
 * its skips past 30 s against how many songs heard as often get.
 */
const Evidence = ({ fade: { rise, mid } }: { fade: Fade }) => (
  <span className="w-36 shrink-0 font-mono text-[11px] leading-tight text-zinc-400">
    {rise && <Rise {...rise} />}
    {rise && mid && <br />}
    {mid && (
      <span title="Skipped after 30 s, against songs played as often">
        mid-song skips <span className="text-rose-400">{mid.skips}</span>
        <br />
        {Math.round(mid.expected)} expected
      </span>
    )}
  </span>
);

const Rise = ({ then, now }: { then: Stretch; now: Stretch }) => (
  <span title="Skipped, before last year → since">
    skips {share(then)} → <span className="text-rose-400">{share(now)}</span>
    <br />
    {then.skips}/{then.plays + then.skips} → {now.skips}/{now.plays + now.skips}
  </span>
);

const chip = "flex min-w-0 max-w-40 items-center gap-1 rounded-full bg-white/[0.06] px-2 py-0.5 text-[11px] text-zinc-300";

function Chips({ of, colors }: { of: Playlist[] | undefined; colors: Map<string, string> }) {
  return (
    <span className="hidden w-72 shrink-0 flex-wrap gap-1 sm:flex">
      {(of ?? []).map((p) => (
        <span key={p.id} className={chip}>
          <span className="size-1.5 shrink-0 rounded-full" style={{ background: colors.get(p.id) }} />
          <span className="truncate">{p.name}</span>
        </span>
      ))}
    </span>
  );
}

/** The playlists holding a song, each with × to take it out of that one; a taken-out chip offers Undo. */
function RemoveChips({ id, of, colors }: { id: string; of: Playlist[] | undefined; colors: Map<string, string> }) {
  const current = useApp((s) => s.lib?.playlists);
  const holds = (p: Playlist) => current?.find((c) => c.id === p.id)?.trackIds.includes(id) ?? false;
  const { addToPlaylist, removeFromPlaylist } = useApp.getState();
  return (
    <span className="flex w-72 shrink-0 flex-wrap gap-1">
      {(of ?? []).map((p) =>
        holds(p) ? (
          <button key={p.id} className={`${chip} hover:bg-white/10`} title={`Remove from ${p.name}`} onClick={() => removeFromPlaylist(p.id, [id])}>
            <span className="size-1.5 shrink-0 rounded-full" style={{ background: colors.get(p.id) }} />
            <span className="truncate">{p.name}</span>
            <span className="text-zinc-500">×</span>
          </button>
        ) : (
          <button key={p.id} className={`${chip} opacity-60 hover:opacity-100`} onClick={() => addToPlaylist(p.id, [id], true)}>
            <span className="truncate line-through">{p.name}</span>
            <span className="text-rose-300">Undo</span>
          </button>
        ),
      )}
    </span>
  );
}
