// The Eras tab: a written history of taste, from data/eras.json (`pnpm eras`). The timeline of monthly listening,
// colored by era, stays on top; clicking an era opens it as a chapter below: its story, then the facts behind it.
// The open era is in the address (`#eras/2021-10`), so a reload or Back keeps or closes it.
import { useEffect, useState } from "react";
import type { Era, ErasFile, Shift } from "../core/eras.ts";
import { openInSpotify, usePlayer } from "./player.ts";
import { useApp } from "./store.ts";

const COLORS = ["#e08a6d", "#c9a2e8", "#7fc8a9", "#8aa9f0", "#f0c35a", "#ef7fb0", "#a3c76a", "#f29b52", "#6fd0e0"];
const colorOf = (i: number) => COLORS[i % COLORS.length]!;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const monthName = (key: string) => `${MONTHS[Number(key.slice(5)) - 1]} ${key.slice(0, 4)}`;
const BAR_HEIGHT = 120;
const LIST = 5;

/** "Oct 2021 – Feb 2022"; the latest era runs to "now". */
const span = (era: Era, last: boolean) => `${monthName(era.from)} – ${last ? "now" : monthName(era.to)}`;
const pct = (share: number) => `${Math.round(share * 100)}%`;

const eraInUrl = () => decodeURIComponent(location.hash.split("/")[1] ?? "") || null;

export function ErasView() {
  const [file, setFile] = useState<ErasFile | null | undefined>(undefined);
  const [openId, setOpenId] = useState(eraInUrl);

  useEffect(() => {
    void fetch("/api/eras")
      .then((res) => (res.ok ? (res.json() as Promise<ErasFile>) : null))
      .then(setFile, () => setFile(null));
    const onHash = () => setOpenId(eraInUrl());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const open = (id: string | null) => {
    if (id === openId) return;
    history.pushState(null, "", id ? `#eras/${id}` : "#eras");
    setOpenId(id);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && openId) open(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  if (file === undefined) return <p className="px-2 py-3 text-sm text-zinc-500">Loading…</p>;
  if (!file?.eras.length) return <p className="px-2 py-3 text-sm text-zinc-500">No eras yet. Run `pnpm eras` and reload.</p>;

  const index = file.eras.findIndex((e) => e.id === openId);
  const era = file.eras[index];
  return (
    <div className="mx-auto max-w-5xl">
      <Timeline file={file} openIndex={index} onOpen={(i) => open(i === index ? null : file.eras[i]!.id)} />
      {era ? (
        <Chapter era={era} index={index} file={file} onOpen={open} />
      ) : (
        <div className="mt-6 grid gap-8 md:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
          {file.intro && <p className="max-w-prose text-sm leading-relaxed text-zinc-300">{file.intro}</p>}
          <ol className="space-y-0.5">
            {file.eras.map((e, i) => (
              <li key={e.id}>
                <button onClick={() => open(e.id)} className="flex w-full items-baseline gap-3 rounded-md px-2.5 py-1.5 text-left hover:bg-white/5">
                  <span className="size-2 shrink-0 self-center rounded-full" style={{ background: colorOf(i) }} />
                  <span className="w-40 shrink-0 text-sm text-zinc-100">{span(e, i === file.eras.length - 1)}</span>
                  <span className="truncate text-sm text-zinc-400">{e.artists.slice(0, 3).map((a) => a.name).join(", ")}</span>
                </button>
              </li>
            ))}
          </ol>
        </div>
      )}
    </div>
  );
}

/** Hours per month, one bar each, in its era's color; the open era stands out. A click opens the bar's era. */
function Timeline({ file, openIndex, onOpen }: { file: ErasFile; openIndex: number; onOpen: (era: number) => void }) {
  const max = Math.max(...file.months.map((m) => m.hours));
  return (
    <div>
      <div className="flex items-end gap-px" style={{ height: BAR_HEIGHT }}>
        {file.months.map((m) => (
          <button
            key={m.month}
            onClick={() => onOpen(m.era)}
            title={`${monthName(m.month)}: ${Math.round(m.hours)} h`}
            className="h-full flex-1 cursor-pointer"
            style={{ display: "flex", alignItems: "flex-end" }}
          >
            <span
              className="block w-full rounded-t-[1px] transition-opacity"
              style={{ height: `${Math.max(1, (m.hours / max) * 100)}%`, background: colorOf(m.era), opacity: openIndex < 0 || m.era === openIndex ? 1 : 0.35 }}
            />
          </button>
        ))}
      </div>
      <div className="relative mt-1 h-4 text-[10px] text-zinc-500">
        {file.months.map((m, i) =>
          m.month.endsWith("-01") ? (
            <span key={m.month} className="absolute" style={{ left: `${(i / file.months.length) * 100}%` }}>
              {m.month.slice(0, 4)}
            </span>
          ) : null,
        )}
      </div>
    </div>
  );
}

/** One era as a chapter: heading, story, then artists, defining songs, and how its sound and lyrics differed from usual. */
function Chapter({ era, index, file, onOpen }: { era: Era; index: number; file: ErasFile; onOpen: (id: string | null) => void }) {
  const lib = useApp((s) => s.lib);
  const player = usePlayer();
  const last = index === file.eras.length - 1;
  const [prev, next] = [file.eras[index - 1], file.eras[index + 1]];
  const play = (id: string) => {
    const durationMs = lib?.tracks[id]?.durationMs;
    if (player.enabled && durationMs) void player.play(id, durationMs);
    else openInSpotify(id);
  };
  return (
    <article className="mt-6 max-w-3xl">
      <button onClick={() => onOpen(null)} className="mb-3 text-xs text-zinc-500 hover:text-zinc-300">
        ← All eras
      </button>
      <header className="flex flex-wrap items-baseline gap-x-3">
        <span className="size-2.5 self-center rounded-full" style={{ background: colorOf(index) }} />
        <h2 className="text-2xl font-extrabold tracking-tight text-zinc-50">{span(era, last)}</h2>
        <span className="text-xs text-zinc-500">
          {Math.round(era.hours).toLocaleString()} h · {era.distinctSongs.toLocaleString()} songs
        </span>
      </header>
      {era.story && <p className="mt-3 leading-relaxed text-zinc-200">{era.story}</p>}

      <div className="mt-6 grid gap-6 sm:grid-cols-3">
        <section>
          <Label>Artists</Label>
          {era.artists.slice(0, LIST).map((a) => (
            <div key={a.name} className="flex gap-2 text-sm leading-7">
              <span className="flex-1 truncate text-zinc-200">{a.name}</span>
              <span className="text-zinc-500">{pct(a.share)}</span>
            </div>
          ))}
        </section>
        <section>
          <Label>Defining songs</Label>
          <ol className="space-y-1">
            {era.songs.slice(0, LIST).map((s) => (
              <li key={s.trackId}>
                <button onClick={() => play(s.trackId)} className="text-left text-sm leading-snug text-zinc-200 hover:text-zinc-50">
                  {s.name} <span className="text-zinc-500">· {s.artist}</span>
                </button>
              </li>
            ))}
          </ol>
        </section>
        <section>
          <Label>Sound</Label>
          <Tags shift={era.genres} more={3} less={0} />
          <Tags shift={era.moods} more={1} less={0} />
          <Label className="mt-3">Lyrics</Label>
          <Tags shift={era.themes} more={3} less={2} />
        </section>
      </div>

      <nav className="mt-8 flex justify-between text-sm text-zinc-400">
        {prev ? (
          <button onClick={() => onOpen(prev.id)} className="hover:text-zinc-200">
            ← {span(prev, false)}
          </button>
        ) : (
          <span />
        )}
        {next && (
          <button onClick={() => onOpen(next.id)} className="hover:text-zinc-200">
            {span(next, index + 1 === file.eras.length - 1)} →
          </button>
        )}
      </nav>
    </article>
  );
}

const Label = ({ children, className = "" }: { children: string; className?: string }) => (
  <h3 className={`mb-1.5 text-[10px] font-medium uppercase tracking-widest text-zinc-500 ${className}`}>{children}</h3>
);

/** What rose (↑) and fell (↓) against all-time listening. */
const Tags = ({ shift, more, less }: { shift: Shift; more: number; less: number }) => (
  <div className="mb-1 flex flex-wrap gap-1">
    {shift.more.slice(0, more).map((d) => (
      <span key={d.name} className="rounded-full bg-white/[0.07] px-2 py-0.5 text-xs text-zinc-200">
        ↑ {d.name}
      </span>
    ))}
    {shift.less.slice(0, less).map((d) => (
      <span key={d.name} className="rounded-full bg-white/[0.04] px-2 py-0.5 text-xs text-zinc-500">
        ↓ {d.name}
      </span>
    ))}
  </div>
);
