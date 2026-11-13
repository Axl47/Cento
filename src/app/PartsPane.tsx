// The Parts pane of the Playlists tab: which playlists are parts of this one, their songs it's still missing,
// playlists that look like parts, its own songs that are in no part yet, each with the parts it most likely
// belongs in, and the playlists it's part of or looks like a part of.
import { useMemo, useState } from "react";
import { ancestors, likelyParts, likelyWholes, strays, unplaced } from "../core/family.ts";
import { isArtistPlaylist, type Playlist } from "../core/library.ts";
import { suggest } from "../core/suggest.ts";
import { Empty, PAGE, ShowMore, SongButton } from "./rows.tsx";
import { useApp, type Added } from "./store.ts";

/** Parts offered on each song that's in none. */
const OFFERED = 3;
/**
 * From this score up, a song most likely belongs in a part. Below it the part is offered dimmed, and only while the
 * row is pointed at unless it's the song's best. On songs held out
 * of their own part, the best-scoring part was the right one for 97% from here up, and for two in three below.
 */
const LIKELY = 0.1;
/** Playlists listed when searching for one to add as a part. */
const FOUND = 6;

type Offer = { partId: string; score: number };

const Dot = ({ color }: { color: string | undefined }) => <span className="size-2 shrink-0 rounded-full" style={{ background: color }} />;

export function PartsPane({
  playlist,
  playlists,
  colors,
  onOpen,
}: {
  playlist: Playlist;
  /** Every playlist that could be a part, biggest first. */
  playlists: Playlist[];
  colors: Map<string, string>;
  /** Opens another playlist in the tab. */
  onOpen: (playlistId: string) => void;
}) {
  const { lib, model, neighbors, parents, rules, hidden, uncounted } = useApp();
  const { setPart, addToPlaylist, removeFromPlaylist } = useApp.getState();
  const [query, setQuery] = useState("");
  const [limit, setLimit] = useState(PAGE);

  const parts = useMemo(() => playlists.filter((p) => parents[p.id]?.includes(playlist.id)), [playlists, parents, playlist.id]);
  const likely = useMemo(() => likelyParts(parents, playlist, playlists), [parents, playlist, playlists]);
  const q = query.trim().toLowerCase();
  const above = ancestors(parents, playlist.id);
  const found = q
    ? playlists.filter((p) => p.id !== playlist.id && !parts.includes(p) && !above.includes(p.id) && p.name.toLowerCase().includes(q)).slice(0, FOUND)
    : likely.flatMap((c) => playlists.find((p) => p.id === c.id && !hidden.includes(p.id)) ?? []);
  const shared = new Map(likely.map((c) => [c.id, c.shared]));
  const wholes = playlists.filter((p) => parents[playlist.id]?.includes(p.id));
  // An artist's catch-all, or a playlist left out of sorting, isn't something to be a part of.
  const likelyOf = useMemo(() => {
    const whole = (id: string) => {
      const p = playlists.find((x) => x.id === id);
      return !!lib && !!p && !hidden.includes(id) && !uncounted.includes(id) && !rules[id] && !isArtistPlaylist(lib, p);
    };
    return likelyWholes(parents, playlist, playlists).filter((c) => whole(c.id));
  }, [lib, parents, playlist, playlists, hidden, uncounted, rules]);

  // The songs in no part and the parts offered for each, likeliest song first, as they stood when the set of parts
  // last changed: a placed song keeps its row (with Undo), and placing one doesn't reshuffle the rows under the pointer.
  // The parts are ranked as the sort screen ranks them; ones the model leaves out (hidden, not counted) come last.
  const snapshotKey = `${parts.map((p) => p.id).join()}/${model ? "model" : ""}`;
  const snapshot = () => {
    const mine = new Set(parts.map((p) => p.id));
    const unscored = parts.filter((p) => !model?.playlistIds.includes(p.id)).map((p): Offer => ({ partId: p.id, score: 0 }));
    const offers = new Map(
      unplaced(playlist, parts).map((id) => {
        const track = lib?.tracks[id];
        const ranked = model && track ? suggest(model, track, [], neighbors).filter((s) => mine.has(s.playlistId)) : [];
        return [id, [...ranked.map((s): Offer => ({ partId: s.playlistId, score: s.score })), ...unscored]] as const;
      }),
    );
    const best = (id: string) => offers.get(id)?.[0]?.score ?? -1;
    return { key: snapshotKey, offers, ids: [...offers.keys()].sort((a, b) => best(b) - best(a)) };
  };
  const [open, setOpen] = useState(snapshot);
  if (open.key !== snapshotKey) setOpen(snapshot());
  /** songId -> what placing it from here added where, for Undo. */
  const [placedHere, setPlacedHere] = useState<Record<string, Added>>({});

  const rows = open.ids;
  const members = useMemo(() => new Set(playlist.trackIds), [playlist.trackIds]);

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
                      Add
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
              const added = placedHere[id];
              // A song that has left the playlist since (a resync, or Doesn't fit) has no business in a part of it.
              if (!t || (!members.has(id) && !added)) return null;
              const inParts = parts.filter((p) => p.trackIds.includes(id));
              // Weakest first, so the best part sits at the row's right edge and the hover-only ones open to its left.
              const offers = (open.offers.get(id) ?? []).slice(0, OFFERED).toReversed();
              const best = offers.at(-1)?.partId;
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
                      {added && (
                        <button
                          className="btn w-16 px-2 py-0.5 text-xs"
                          onClick={() => {
                            for (const step of added) removeFromPlaylist(step.playlistId, step.trackIds);
                            setPlacedHere(({ [id]: _, ...rest }) => rest);
                          }}
                        >
                          Undo
                        </button>
                      )}
                    </>
                  ) : (
                    offers.map(({ partId, score }) => (
                      <button
                        key={partId}
                        onClick={() => {
                          const went = addToPlaylist(partId, [id]);
                          setPlacedHere((was) => ({ ...was, [id]: went }));
                        }}
                        className={`flex max-w-40 shrink-0 items-center gap-1.5 rounded-full border border-white/10 px-2 py-0.5 text-xs hover:border-white/30 hover:text-zinc-50 ${score >= LIKELY ? "text-zinc-200" : "text-zinc-500"} ${partId === best || score >= LIKELY ? "" : "invisible group-hover:visible"}`}
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

      {(wholes.length > 0 || likelyOf.length > 0) && (
        <div className="rounded-xl bg-zinc-900 px-3 py-2">
          <h3 className="py-1 text-sm font-semibold text-zinc-100">Part of</h3>
          <ul>
            {wholes.map((p) => {
              const missing = strays(playlist, p);
              return (
                <li key={p.id} className="group flex items-center gap-2.5 py-1">
                  <Dot color={colors.get(p.id)} />
                  <button className="min-w-0 truncate text-left text-sm text-zinc-100 hover:underline" onClick={() => onOpen(p.id)}>
                    {p.name}
                  </button>
                  <span className="flex-1" />
                  {missing.length > 0 && (
                    <>
                      <span className="text-xs text-amber-200/80">{missing.length} not in it</span>
                      <button className="btn px-2 py-0.5 text-xs" onClick={() => addToPlaylist(p.id, missing)}>
                        Add
                      </button>
                    </>
                  )}
                  <button
                    aria-label={`${playlist.name} is not a part of ${p.name}`}
                    title="Not a part"
                    className="invisible px-1 text-zinc-500 hover:text-zinc-100 group-hover:visible"
                    onClick={() => setPart(playlist.id, p.id, false)}
                  >
                    ×
                  </button>
                </li>
              );
            })}
            {likelyOf.map((c) => {
              const p = playlists.find((x) => x.id === c.id);
              return p ? (
                <li key={p.id} className="flex items-center gap-2.5 py-1">
                  <Dot color={colors.get(p.id)} />
                  <span className="min-w-0 truncate text-sm text-zinc-300">{p.name}</span>
                  <span className="text-xs text-zinc-500">
                    · has {c.shared === c.size ? "all" : c.shared} of {playlist.name}'s {c.size}
                  </span>
                  <span className="flex-1" />
                  <button className="btn px-2 py-0.5 text-xs" onClick={() => setPart(playlist.id, p.id, true)}>
                    Make it a part
                  </button>
                </li>
              ) : null;
            })}
          </ul>
        </div>
      )}
    </div>
  );
}
