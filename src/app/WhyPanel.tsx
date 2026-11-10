// Evidence for one playlist (the focused tile) and the current song: the sound map narrowed
// to that playlist, which of the artist's sorted songs are in it, how many of the nearest
// sorted songs are in it, and its closest-sounding songs. Hovering any of those songs (or one
// passed in as `mark`, e.g. from the run strip) points it out on the map.
import { useMemo } from "react";
import { closestAmong } from "../core/audio.ts";
import type { Track } from "../core/library.ts";
import { knownArtistSongs } from "../core/suggest.ts";
import { readPlaylist, sharedThemes, songThemes } from "../core/themes.ts";
import { SoundMap } from "./SoundMap.tsx";
import { usePlayer } from "./player.ts";
import { useApp } from "./store.ts";

const NEAREST = 15;
const ARTIST_COVERS = 14;
const CLOSEST = 5;
const THEMES_NAMED = 3;

const listOf = (names: string[]) => new Intl.ListFormat("en").format(names);

export function WhyPanel({
  track,
  playlistId,
  colors,
  mark,
  onMark,
  onEditRule,
}: {
  track: Track;
  playlistId: string;
  colors: Map<string, string>;
  mark: string | null;
  onMark: (trackId: string | null) => void;
  onEditRule: () => void;
}) {
  const { lib, model, audio, neighbors, vectors, rules, hidden, setHidden, classifier, themes } = useApp();
  const play = usePlayer((s) => s.play);
  const color = colors.get(playlistId) ?? "#a092ab";
  const playlist = lib?.playlists.find((p) => p.id === playlistId);
  const soundScore = classifier?.score(track.id, playlistId);
  const fit = classifier?.fit(playlistId);

  const evidence = useMemo(() => {
    if (!lib || !model || !playlist) return null;
    // Playlist trackIds rather than model.membership, so hidden playlists work too.
    const members = new Set(playlist.trackIds);
    const artist = [...knownArtistSongs(model, track)].map((id) => ({ id, inside: members.has(id) })).sort((a, b) => +b.inside - +a.inside);
    const hasAudio = !!audio?.ids.includes(track.id);
    const nearest = hasAudio && neighbors ? neighbors(track.id).filter((n) => model.membership.has(n.id)).slice(0, NEAREST) : [];
    const closest = !hasAudio || !audio
      ? []
      : vectors
        ? closestAmong(audio, vectors, track.id, members, CLOSEST)
        : (neighbors?.(track.id) ?? []).filter((n) => members.has(n.id)).slice(0, CLOSEST);
    // Bars run from the random-pair baseline (nothing in common) to the song's nearest neighbor anywhere.
    const floor = audio?.baseline ?? 0;
    const ceiling = Math.max((neighbors?.(track.id) ?? [])[0]?.sim ?? 1, ...closest.map((n) => n.sim));
    const artistNames = track.artists.filter((a) => model.artistSongs.has(a.id)).map((a) => a.name).join(", ");
    return { artist, artistNames, nearest: nearest.map((n) => ({ id: n.id, inside: members.has(n.id) })), closest, hasAudio, floor, ceiling };
  }, [lib, model, audio, neighbors, vectors, playlist, track]);

  const lyricNote = useMemo(() => {
    if (!lib || !playlist || !themes) return null;
    const reading = readPlaylist(themes, lib, playlist);
    if (reading.clear.length === 0) return null;
    const shared = sharedThemes(reading, themes, track);
    const own = songThemes(themes, track);
    return {
      playlist: listOf(reading.clear.slice(0, THEMES_NAMED).map((t) => t.name)),
      song: shared.length > 0 ? `This song shares ${listOf(shared.map((t) => t.name))}.` : own[0] ? `This song leans toward ${own[0].name} instead.` : null,
    };
  }, [lib, playlist, themes, track]);

  if (!lib || !playlist || !evidence) return null;
  const rule = rules[playlistId];
  const isHidden = hidden.includes(playlistId);
  const artistIn = evidence.artist.filter((a) => a.inside).length;
  const nearIn = evidence.nearest.filter((n) => n.inside).length;
  const hoverProps = (id: string) => ({ onMouseEnter: () => onMark(id), onMouseLeave: () => onMark(null) });

  return (
    <div className="space-y-5">
      <div className="flex items-center gap-2">
        <span className="size-2.5 shrink-0 rounded-full" style={{ background: color }} />
        <h3 className="min-w-0 flex-1 truncate font-bold text-zinc-50">{playlist.name}</h3>
        <button
          onClick={onEditRule}
          className={`rounded px-1.5 py-0.5 text-xs hover:bg-white/10 hover:text-zinc-100 ${rule ? "text-zinc-200" : "text-zinc-500"}`}
          title="Only suggest this playlist for certain artists"
        >
          {rule ? `Only ${rule.map((a) => a.name).join(", ")}` : "Artists…"}
        </button>
        <button
          onClick={() => setHidden(playlistId, !isHidden)}
          className="rounded px-1.5 py-0.5 text-xs text-zinc-500 hover:bg-white/10 hover:text-zinc-100"
          title={isHidden ? "Suggest this playlist again" : "Never suggest this playlist (e.g. a Best of)"}
        >
          {isHidden ? "Unhide" : "Hide"}
        </button>
      </div>

      {audio && (
        <SoundMap
          audio={audio}
          lib={lib}
          colors={colors}
          height={400}
          scene={{ kind: "song", id: track.id }}
          highlight={[playlistId]}
          mark={mark}
          onSelect={(id) => {
            const t = lib.tracks[id];
            if (t) void play(t.id, t.durationMs);
          }}
        />
      )}

      {evidence.artist.length > 0 && (
        <Evidence label={evidence.artistNames} count={`${artistIn}/${evidence.artist.length}`}>
          <div className="flex flex-wrap gap-1.5">
            {evidence.artist.slice(0, ARTIST_COVERS).map(({ id, inside }) => {
              const t = lib.tracks[id];
              return (
                <button
                  key={id}
                  {...hoverProps(id)}
                  onClick={() => t && void play(t.id, t.durationMs)}
                  title={t?.name}
                  className={`size-7 rounded-[3px] bg-zinc-800 bg-cover bg-center transition ${inside ? "" : "opacity-30 grayscale"}`}
                  style={{ backgroundImage: t?.album.imageUrl ? `url(${t.album.imageUrl})` : undefined, boxShadow: inside ? `0 0 0 2px ${color}` : undefined }}
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
        <Evidence label="Nearest by sound" count={`${nearIn}/${evidence.nearest.length}`}>
          <div className="flex gap-0.5">
            {evidence.nearest.map(({ id, inside }) => {
              const t = lib.tracks[id];
              return (
                <button
                  key={id}
                  {...hoverProps(id)}
                  onClick={() => t && void play(t.id, t.durationMs)}
                  title={t ? `${t.name} · ${t.artists[0]?.name}` : undefined}
                  className={`h-4 flex-1 rounded-[2px] transition-transform hover:scale-y-150 ${id === mark ? "scale-y-150" : ""}`}
                  style={{ background: inside ? color : "var(--color-zinc-700)" }}
                />
              );
            })}
          </div>
        </Evidence>
      )}

      {soundScore !== undefined && (
        <p className="text-xs text-zinc-400">
          Sound model: <b className="font-semibold text-zinc-200">{Math.round(Math.min(Math.max(soundScore, 0), 1) * 100)}%</b> fit
          {fit?.auc != null && ` · ${fit.auc.toFixed(2)} on new artists`}
          {fit && (fit.cutoff != null ? ` · auto-checks at ${Math.round(Math.min(Math.max(fit.cutoff, 0), 1) * 100)}%` : " · too unreliable to auto-check")}
        </p>
      )}

      {lyricNote && (
        <p className="text-xs text-zinc-400">
          Lyrics here lean toward <b className="font-semibold text-zinc-200">{lyricNote.playlist}</b>. {lyricNote.song}
        </p>
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
                onClick={() => void play(t.id, t.durationMs)}
                className="relative flex w-full items-center gap-2.5 overflow-hidden rounded-md p-1 pr-2 text-left text-xs hover:bg-white/5"
                title="Play"
              >
                <span className="absolute inset-y-0 left-0 opacity-20" style={{ width: `${pct}%`, background: color }} />
                <span
                  className="relative size-8 shrink-0 rounded-[3px] bg-zinc-800 bg-cover bg-center"
                  style={{ backgroundImage: t.album.imageUrl ? `url(${t.album.imageUrl})` : undefined }}
                />
                <span className="relative min-w-0 flex-1">
                  <span className="block truncate text-zinc-100">{t.name}</span>
                  <span className="block truncate text-zinc-500">{t.artists[0]?.name}</span>
                </span>
                <span className="relative text-zinc-400">{Math.round(n.sim * 100)}%</span>
              </button>
            );
          })}
        </div>
      )}
      {evidence.hasAudio && evidence.closest.length === 0 && <p className="text-xs text-zinc-500">Nothing in {playlist.name} sounds similar.</p>}
    </div>
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
