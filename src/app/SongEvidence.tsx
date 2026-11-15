// How a song compares to the library: the artist's sorted songs, its nearest songs by sound, and the closest few
// by name. With a playlist it's narrowed to what's in that playlist; without one, each song wears its own
// playlist's color, matching the map. Hovering a song points it out on the map.
import { useMemo } from "react";
import { closestAmong, nearestSorted } from "../core/audio.ts";
import { primaryPlaylists, sortTargets, type Track } from "../core/library.ts";
import { knownArtistSongs } from "../core/suggest.ts";
import { usePlayer } from "./player.ts";
import { useApp } from "./store.ts";
import { useTitle } from "./useTitle.ts";

const ARTIST_COVERS = 14;
const CLOSEST = 5;
const NO_PLAYLIST = "var(--color-zinc-700)";

export function SongEvidence({
  track,
  playlistId,
  colors,
  mark,
  onMark,
}: {
  track: Track;
  playlistId: string | null;
  colors: Map<string, string>;
  mark: string | null;
  onMark: (trackId: string | null) => void;
}) {
  const { lib, model, audio, neighbors, vectors, hidden } = useApp();
  const play = usePlayer((s) => s.play);
  const playlist = playlistId ? lib?.playlists.find((p) => p.id === playlistId) : undefined;
  const primary = useMemo(() => (lib ? primaryPlaylists(sortTargets(lib, hidden)) : new Map<string, string>()), [lib, hidden]);

  const evidence = useMemo(() => {
    if (!lib || !model) return null;
    // Playlist trackIds rather than model.membership, so hidden playlists work too.
    const members = playlist && new Set(playlist.trackIds);
    const inScope = (id: string) => !members || members.has(id);
    const artist = [...knownArtistSongs(model, track)].map((id) => ({ id, inside: inScope(id) })).sort((a, b) => +b.inside - +a.inside);
    const hasAudio = !!audio?.ids.includes(track.id);
    const nearest = hasAudio && neighbors ? nearestSorted(neighbors, primary, track.id) : [];
    const closest = !hasAudio || !audio
      ? []
      : !members
        ? nearest.slice(0, CLOSEST)
        : vectors
          ? closestAmong(audio, vectors, track.id, members, CLOSEST)
          : (neighbors?.(track.id) ?? []).filter((n) => members.has(n.id)).slice(0, CLOSEST);
    // Bars run from the random-pair baseline (nothing in common) to the song's nearest neighbor anywhere.
    const floor = audio?.baseline ?? 0;
    const ceiling = Math.max((neighbors?.(track.id) ?? [])[0]?.sim ?? 1, ...closest.map((n) => n.sim));
    const artistNames = track.artists.filter((a) => model.artistSongs.has(a.id)).map((a) => a.name).join(", ");
    return { artist, artistNames, nearest: nearest.map((n) => ({ id: n.id, inside: inScope(n.id) })), closest, hasAudio, floor, ceiling };
  }, [lib, model, audio, neighbors, vectors, playlist, track, primary]);
  const title = useTitle();

  if (!lib || !evidence) return null;
  const colorOf = (id: string) => colors.get(playlist?.id ?? primary.get(id) ?? "") ?? NO_PLAYLIST;
  const countOf = (items: { inside: boolean }[]) => (playlist ? `${items.filter((a) => a.inside).length}/${items.length}` : `${items.length}`);
  const hoverProps = (id: string) => ({ onMouseEnter: () => onMark(id), onMouseLeave: () => onMark(null) });
  const playSong = (id: string) => {
    const t = lib.tracks[id];
    if (t) void play(t.id, t.durationMs);
  };

  return (
    <>
      {evidence.artist.length > 0 && (
        <Evidence label={evidence.artistNames} count={countOf(evidence.artist)}>
          <div className="flex flex-wrap gap-1.5">
            {evidence.artist.slice(0, ARTIST_COVERS).map(({ id, inside }) => {
              const t = lib.tracks[id];
              return (
                <button
                  key={id}
                  {...hoverProps(id)}
                  onClick={() => playSong(id)}
                  title={t && title(id, t.name)}
                  className={`size-7 rounded-[3px] bg-zinc-800 bg-cover bg-center transition ${inside ? "" : "opacity-30 grayscale"}`}
                  style={{ backgroundImage: t?.album.imageUrl ? `url(${t.album.imageUrl})` : undefined, boxShadow: inside ? `0 0 0 2px ${colorOf(id)}` : undefined }}
                />
              );
            })}
            {evidence.artist.length > ARTIST_COVERS && (
              <span className="grid h-7 place-items-center px-1 text-xs text-zinc-500">+{evidence.artist.length - ARTIST_COVERS}</span>
            )}
          </div>
        </Evidence>
      )}

      {evidence.nearest.length > 0 && (
        <Evidence label="Nearest by sound" count={countOf(evidence.nearest)}>
          <div className="flex gap-0.5">
            {evidence.nearest.map(({ id, inside }) => {
              const t = lib.tracks[id];
              return (
                <button
                  key={id}
                  {...hoverProps(id)}
                  onClick={() => playSong(id)}
                  title={t ? `${title(id, t.name)} · ${t.artists[0]?.name}` : undefined}
                  className={`h-4 flex-1 rounded-[2px] transition-transform hover:scale-y-150 ${id === mark ? "scale-y-150" : ""}`}
                  style={{ background: inside ? colorOf(id) : NO_PLAYLIST }}
                />
              );
            })}
          </div>
        </Evidence>
      )}

      {!evidence.hasAudio && audio && <p className="text-xs text-zinc-500">No audio for this song, so there's nothing to compare it to.</p>}
      {!audio && <p className="text-xs text-zinc-500">Run <code>pnpm audio</code> and reload to compare songs by sound.</p>}

      {evidence.closest.length > 0 && (
        <div className="space-y-1">
          {evidence.closest.map((n) => {
            const t = lib.tracks[n.id];
            if (!t) return null;
            const pct = Math.max(0, (n.sim - evidence.floor) / (evidence.ceiling - evidence.floor || 1)) * 100;
            return (
              <button
                key={n.id}
                {...hoverProps(n.id)}
                onClick={() => playSong(n.id)}
                className="relative flex w-full items-center gap-2.5 overflow-hidden rounded-md p-1 pr-2 text-left text-xs hover:bg-white/5"
                title="Play"
              >
                <span className="absolute inset-y-0 left-0 opacity-20" style={{ width: `${pct}%`, background: colorOf(n.id) }} />
                <span
                  className="relative size-8 shrink-0 rounded-[3px] bg-zinc-800 bg-cover bg-center"
                  style={{ backgroundImage: t.album.imageUrl ? `url(${t.album.imageUrl})` : undefined }}
                />
                <span className="relative min-w-0 flex-1">
                  <span className="block truncate text-zinc-100">{title(n.id, t.name)}</span>
                  <span className="block truncate text-zinc-500">{t.artists[0]?.name}</span>
                </span>
                <span className="relative text-zinc-400">{Math.round(n.sim * 100)}%</span>
              </button>
            );
          })}
        </div>
      )}
      {playlist && evidence.hasAudio && evidence.closest.length === 0 && <p className="text-xs text-zinc-500">Nothing in {playlist.name} sounds similar.</p>}
    </>
  );
}

function Evidence({ label, count, children }: { label: string; count: string; children: React.ReactNode }) {
  return (
    <div className="space-y-2">
      <div className="flex justify-between text-xs">
        <span className="text-zinc-400">{label}</span>
        <span className="font-semibold text-zinc-200">{count}</span>
      </div>
      {children}
    </div>
  );
}
