// The Parts pane of the Playlists tab: which playlists are parts of this one, their songs it's still missing,
// playlists that look like parts, and its own songs that are in no part yet, each with the parts it sounds closest to.
import { useMemo, useState } from "react";
import { placements, type Evidence, type Part } from "../core/belong.ts";
import { likelyParts, strays, unplaced } from "../core/family.ts";
import type { Playlist } from "../core/library.ts";
import { Empty, PAGE, ShowMore, SongButton } from "./rows.tsx";
import { useApp } from "./store.ts";

/** Parts offered on each song that's in none. */
const OFFERED = 3;
/** From this score up, a song sounds like it belongs in a part; below it the part is offered dimmed. */
const LIKELY = 0.6;
/** Parts scoring this close to a song's best one show on its row; the others only while it's pointed at. */
const CLOSE = 0.1;
/** Playlists listed when searching for one to add as a part. */
const FOUND = 6;

type Sound = NonNullable<Evidence["sound"]>;

const Dot = ({ color }: { color: string | undefined }) => <span className="size-2 shrink-0 rounded-full" style={{ background: color }} />;

export function PartsPane({
  playlist,
  playlists,
  sound,
  colors,
  onOpen,
}: {
  playlist: Playlist;
  /** Every playlist that could be a part, biggest first. */
  playlists: Playlist[];
  sound: Sound | undefined;
  colors: Map<string, string>;
  /** Opens another playlist in the tab. */
  onOpen: (playlistId: string) => void;
}) {
  const { lib, parents, rules, hidden } = useApp();
  const { setPart, addToPlaylist, removeFromPlaylist } = useApp.getState();
  const [query, setQuery] = useState("");
  const [limit, setLimit] = useState(PAGE);

  const parts = useMemo(() => playlists.filter((p) => parents[p.id]?.includes(playlist.id)), [playlists, parents, playlist.id]);
  const likely = useMemo(() => likelyParts(parents, playlist, playlists), [parents, playlist, playlists]);
  const q = query.trim().toLowerCase();
  const found = q
    ? playlists.filter((p) => p.id !== playlist.id && !parts.includes(p) && p.name.toLowerCase().includes(q)).slice(0, FOUND)
    : likely.flatMap((c) => playlists.find((p) => p.id === c.id && !hidden.includes(p.id)) ?? []);
  const shared = new Map(likely.map((c) => [c.id, c.shared]));

  // The songs in no part as the parts stood when they last changed, so a placed song keeps its row (with Undo).
  const partsKey = parts.map((p) => p.id).join();
  const [open, setOpen] = useState({ key: partsKey, ids: unplaced(playlist, parts) });
  if (open.key !== partsKey) setOpen({ key: partsKey, ids: unplaced(playlist, parts) });

  const placed = useMemo(() => {
    if (!sound || !lib) return new Map<string, { partId: string; score: number }[]>();
    const scored = parts.map((p): Part => {
      const artists = rules[p.id] && new Set(rules[p.id]!.map((a) => a.id));
      return { id: p.id, trackIds: p.trackIds, byRule: artists && ((id) => !!lib.tracks[id]?.artists.some((a) => artists.has(a.id))) };
    });
    return placements(sound, scored, open.ids);
    // Scored once per set of parts: a song placed since then shouldn't reshuffle the rows under the pointer.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sound, lib, rules, open]);
  const rows = useMemo(() => open.ids.toSorted((a, b) => (placed.get(b)?.[0]?.score ?? -1) - (placed.get(a)?.[0]?.score ?? -1)), [open.ids, placed]);

  if (!lib) return null;
  const left = unplaced(playlist, parts).length;

  return (
    <div className="space-y-3">
      <div className="rounded-xl bg-zinc-900 px-3 py-2">
        {parts.length === 0 && (
          <p className="py-1 text-sm text-zinc-400">
            A part's songs all belong in {playlist.name} too: sorting a song into a part also adds it here.
          </p>
        )}
        <ul>
          {parts.map((p) => {
            const missing = strays(p, playlist);
            return (
              <li key={p.id} className="group flex items-center gap-2.5 py-1">
                <Dot color={colors.get(p.id)} />
                <button className="min-w-0 truncate text-left text-sm text-zinc-100 hover:underline" onClick={() => onOpen(p.id)}>
                  {p.name}
                </button>
                <span className="text-xs text-zinc-500">{p.trackIds.length}</span>
                <span className="flex-1" />
                {missing.length > 0 && (
                  <>
                    <span className="text-xs text-amber-200/80">
                      {missing.length} not in {playlist.name}
                    </span>
                    <button className="btn px-2 py-0.5 text-xs" onClick={() => addToPlaylist(playlist.id, missing)}>
                      Add {missing.length}
                    </button>
                  </>
                )}
                <button
                  aria-label={`${p.name} is not a part of ${playlist.name}`}
                  title="Not a part"
                  className="invisible px-1 text-zinc-500 hover:text-zinc-100 group-hover:visible"
                  onClick={() => setPart(p.id, playlist.id, false)}
                >
                  ×
                </button>
              </li>
            );
          })}
        </ul>
        <div className={parts.length ? "mt-1 border-t border-white/10 pt-2" : ""}>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Add a playlist as a part…"
            className="w-full rounded-lg border border-white/10 bg-transparent px-2.5 py-1 text-sm text-zinc-100 placeholder:text-zinc-500 focus:border-white/30 focus:outline-none"
          />
          <ul className="mt-1">
            {found.map((p) => (
              <li key={p.id} className="flex items-center gap-2.5 py-1">
                <Dot color={colors.get(p.id)} />
                <span className="min-w-0 truncate text-sm text-zinc-300">{p.name}</span>
                <span className="text-xs text-zinc-500">{p.trackIds.length}</span>
                {shared.has(p.id) && (
                  <span className="text-xs text-zinc-500">
                    · {shared.get(p.id) === p.trackIds.length ? "all" : shared.get(p.id)} already in {playlist.name}
                  </span>
                )}
                <span className="flex-1" />
                <button
                  className="btn px-2 py-0.5 text-xs"
                  onClick={() => {
                    setPart(p.id, playlist.id, true);
                    setQuery("");
                  }}
                >
                  Add as part
                </button>
              </li>
            ))}
          </ul>
          {q && found.length === 0 && <Empty>No playlist matches</Empty>}
        </div>
      </div>

      {parts.length > 0 && (
        <div className="rounded-xl bg-zinc-900 px-3 py-2">
          <h3 className="py-1 text-sm font-semibold text-zinc-100">
            In no part <span className="font-normal text-zinc-500">{left}</span>
          </h3>
          <ul>
            {rows.slice(0, limit).map((id) => {
              const t = lib.tracks[id];
              if (!t) return null;
              const inParts = parts.filter((p) => p.trackIds.includes(id));
              // Weakest first, so the best part sits at the row's right edge and the hover-only ones open to its left.
              const offers = (placed.get(id) ?? []).slice(0, OFFERED).toReversed();
              const best = offers.at(-1)?.score ?? 0;
              return (
                <li key={id} className="group flex items-center gap-2 py-1">
                  <span className={`flex min-w-0 flex-1 ${inParts.length ? "opacity-40" : ""}`}>
                    <SongButton track={t} />
                  </span>
                  {inParts.length > 0 ? (
                    <>
                      <span className="flex min-w-0 items-center gap-1.5 truncate text-xs text-zinc-300">
                        <Dot color={colors.get(inParts[0]!.id)} />
                        {inParts.map((p) => p.name).join(", ")}
                      </span>
                      <button className="btn w-16 px-2 py-0.5 text-xs" onClick={() => inParts.forEach((p) => removeFromPlaylist(p.id, [id]))}>
                        Undo
                      </button>
                    </>
                  ) : (
                    offers.map(({ partId, score }) => (
                      <button
                        key={partId}
                        onClick={() => addToPlaylist(partId, [id])}
                        className={`flex max-w-40 shrink-0 items-center gap-1.5 rounded-full border border-white/10 px-2 py-0.5 text-xs hover:border-white/30 hover:text-zinc-50 ${score >= LIKELY ? "text-zinc-200" : "text-zinc-500"} ${score >= best - CLOSE ? "" : "invisible group-hover:visible"}`}
                      >
                        <Dot color={colors.get(partId)} />
                        <span className="truncate">{parts.find((p) => p.id === partId)?.name}</span>
                      </button>
                    ))
                  )}
                </li>
              );
            })}
          </ul>
          {rows.length === 0 && <Empty>Every song is in a part</Empty>}
          {rows.length > limit && <ShowMore onClick={() => setLimit(limit + PAGE)} />}
        </div>
      )}
    </div>
  );
}
