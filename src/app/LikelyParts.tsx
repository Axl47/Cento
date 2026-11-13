// The Playlists tab's library-wide look at which playlists sit inside which: every playlist that isn't a part yet
// but is mostly held by a bigger one, grouped under that one.
import type { likelyFamilies } from "../core/family.ts";
import type { Playlist } from "../core/library.ts";
import { Dot, Empty } from "./rows.tsx";
import { useApp } from "./store.ts";

export function LikelyParts({
  families,
  playlists,
  colors,
  onOpen,
}: {
  families: ReturnType<typeof likelyFamilies>;
  playlists: Playlist[];
  colors: Map<string, string>;
  /** Opens a playlist in the tab. */
  onOpen: (playlistId: string) => void;
}) {
  const name = (id: string) => playlists.find((p) => p.id === id)?.name;
  if (families.length === 0) return <Empty>No likely parts</Empty>;
  return (
    <div className="max-w-3xl divide-y divide-white/5 rounded-xl bg-zinc-900 px-3">
      {families.map(({ whole, parts }) => (
        <section key={whole} className="py-2">
          <h3 className="flex items-center gap-2.5 py-1 text-sm font-semibold text-zinc-100">
            <Dot color={colors.get(whole)} />
            <button className="min-w-0 truncate hover:underline" onClick={() => onOpen(whole)}>
              {name(whole)}
            </button>
            <span className="font-normal text-zinc-500">{playlists.find((p) => p.id === whole)?.trackIds.length}</span>
          </h3>
          <ul>
            {parts.map((c) => (
              <li key={c.id} className="flex items-center gap-3 py-1">
                <button className="w-44 shrink-0 truncate text-left text-sm text-zinc-300 hover:text-zinc-50 hover:underline" onClick={() => onOpen(c.id)}>
                  {name(c.id)}
                </button>
                <span title={`${c.shared} of ${c.size} songs are in ${name(whole)}`} className="h-1.5 w-40 shrink overflow-hidden rounded-full bg-white/10">
                  <span className="block h-full rounded-full" style={{ width: `${(100 * c.shared) / c.size}%`, background: colors.get(whole) }} />
                </span>
                {c.shared < c.size && (
                  <span title={`${c.size - c.shared} of its songs aren't in ${name(whole)}`} className="text-xs text-amber-200/80">
                    +{c.size - c.shared}
                  </span>
                )}
                <span className="flex-1" />
                <button className="btn shrink-0 px-2 py-0.5 text-xs" onClick={() => useApp.getState().setPart(c.id, whole, true)}>
                  Make it a part
                </button>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
