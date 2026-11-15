// Small pieces the Playlists tab's panes share: a song you can click to hear, and the ends of a list.
import type { Track } from "../core/library.ts";
import { usePlayer } from "./player.ts";
import { useTitle } from "./useTitle.ts";

/** How many rows a list shows at first, and adds per Show more. */
export const PAGE = 40;

/** Title with plays, and artists; clicking plays it. */
export function SongButton({ track }: { track: Track }) {
  const title = useTitle();
  return (
    <button className="min-w-0 flex-1 truncate text-left text-sm text-zinc-100" onClick={() => void usePlayer.getState().play(track.id, track.durationMs)}>
      {title(track.id, track.name)} <span className="text-xs text-zinc-400">{track.artists.map((a) => a.name).join(", ")}</span>
    </button>
  );
}

export const Dot = ({ color }: { color: string | undefined }) => <span className="size-2 shrink-0 rounded-full" style={{ background: color }} />;

export const Empty = ({ children }: { children: string }) => <p className="py-1 text-sm text-zinc-500">{children}</p>;

export const ShowMore = ({ onClick }: { onClick: () => void }) => (
  <button className="mt-1 text-xs text-zinc-400 hover:text-zinc-100" onClick={onClick}>
    Show more
  </button>
);
