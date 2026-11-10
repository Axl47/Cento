// A sonic bridge as a list: a route that travels gradually from one song to another. It lives here until you
// save it, so it can be listened to and adjusted before it becomes a playlist.
import { useEffect, useRef, useState } from "react";
import type { Track } from "../core/library.ts";
import { BRIDGE_COLORS } from "./SoundMap.tsx";
import { PlayIcon } from "./SortView.tsx";
import { openInSpotify, usePlayer } from "./player.ts";
import { useApp } from "./store.ts";
import type { Bridge } from "./useBridge.ts";

const MIN_LENGTH = 5;
const MAX_LENGTH = 40;
/** How long before a song ends the next one is started, to cover the round trip to Spotify. */
const ADVANCE_EARLY_MS = 300;

export function BridgePanel({ bridge, onMark }: { bridge: Bridge; onMark: (id: string | null) => void }) {
  const { lib, audio, vectors, saveBridge } = useApp();
  const player = usePlayer();
  const [listening, setListening] = useState(false); // playing through the list, rather than one song
  const [savedAs, setSavedAs] = useState<string | null>(null);
  const advancedTo = useRef<string | null>(null); // Spotify can report the old song for a moment after the switch
  const { ids, steps } = bridge;

  useEffect(() => setSavedAs(null), [ids]);

  // Spotify can't be handed this list as a queue from here, so the next song is started as each one ends.
  const nowAt = player.trackId ? ids.indexOf(player.trackId) : -1;
  const following = listening && nowAt >= 0 && !player.paused ? lib?.tracks[ids[nowAt + 1] ?? ""] : undefined;
  useEffect(() => {
    if (!following || advancedTo.current === following.id) return;
    const left = player.duration - player.position - (performance.now() - player.updatedAt);
    const timer = setTimeout(() => {
      advancedTo.current = following.id;
      void player.play(following.id, following.durationMs, 0);
    }, Math.max(left - ADVANCE_EARLY_MS, 0));
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [following?.id, player.position, player.updatedAt, player.duration]);

  const playAt = (track: Track) => {
    if (!player.enabled) return openInSpotify(track.id);
    setListening(true);
    advancedTo.current = track.id;
    void player.play(track.id, track.durationMs, 0);
  };

  if (!lib || !audio) return null;
  const [start, end] = [lib.tracks[bridge.from ?? ""], lib.tracks[bridge.to ?? ""]];
  const first = lib.tracks[ids[0] ?? ""];
  const name = start && end ? `${start.name} → ${end.name}` : "";

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="font-bold text-zinc-50">Bridge</h3>
        <button className="btn" onClick={bridge.close} title="Back to the map (Esc)">
          Close
        </button>
      </div>
      <div className="space-y-1 text-sm">
        <End color={BRIDGE_COLORS.start} track={start} />
        <End color={BRIDGE_COLORS.end} track={end} action={<button className="text-xs text-zinc-400 hover:text-zinc-100" onClick={bridge.changeEnd}>Change</button>} />
      </div>
      <label className="flex items-center gap-3 text-xs text-zinc-400">
        Songs
        <input type="range" min={MIN_LENGTH} max={MAX_LENGTH} value={bridge.length} onChange={(e) => bridge.setLength(Number(e.target.value))} className="min-w-0 flex-1" />
        <b className="font-semibold text-zinc-100">{bridge.length}</b>
      </label>

      {!vectors && <p className="text-sm text-zinc-500">Loading the sound vectors…</p>}

      {ids.length > 0 && (
        <>
          <p className="text-xs text-zinc-400">
            Biggest jump <b className="font-semibold text-zinc-100">{Math.round(Math.min(...steps) * 100)}%</b> alike · two random songs are about {Math.round(audio.baseline * 100)}%
          </p>
          <div className="flex gap-2">
            {first && (
              <button className="btn flex-1" onClick={() => playAt(first)}>
                Play all
              </button>
            )}
            <button
              className="btn flex-1"
              disabled={savedAs === name}
              title="Creates a private playlist, hidden from sorting suggestions"
              onClick={() => {
                saveBridge(name, ids);
                setSavedAs(name);
              }}
            >
              {savedAs === name ? "Saved" : "Save to Spotify"}
            </button>
          </div>
          <ol>
            {ids.map((id, i) => {
              const track = lib.tracks[id];
              if (!track) return null;
              const isEnd = i === 0 || i === ids.length - 1;
              return (
                <li key={id} onMouseEnter={() => onMark(id)} onMouseLeave={() => onMark(null)}>
                  {i > 0 && <p className="ml-[3.25rem] py-0.5 text-[11px] text-zinc-500">{Math.round(steps[i - 1]! * 100)}% alike</p>}
                  <div className={`flex items-center gap-3 rounded-lg px-2 py-1.5 hover:bg-white/5 ${i === nowAt ? "bg-white/10" : ""}`}>
                    {track.album.imageUrl ? <img src={track.album.imageUrl} alt="" className="size-10 shrink-0 rounded" /> : <div className="size-10 shrink-0 rounded bg-zinc-800" />}
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-semibold text-zinc-100">{track.name}</div>
                      <div className="truncate text-xs text-zinc-400">{track.artists.map((a) => a.name).join(", ")}</div>
                    </div>
                    <button className="btn px-2" aria-label={`Play ${track.name}`} title="Play" onClick={() => playAt(track)}>
                      <PlayIcon />
                    </button>
                    {!isEnd && (
                      <button className="btn px-2" aria-label={`Replace ${track.name}`} title="Take this song out and find another" onClick={() => bridge.replace(id)}>
                        ↻
                      </button>
                    )}
                  </div>
                </li>
              );
            })}
          </ol>
        </>
      )}
    </div>
  );
}

function End({ color, track, action }: { color: string; track: Track | undefined; action?: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2">
      <span className="size-2.5 shrink-0 rounded-full" style={{ background: color }} />
      <span className="min-w-0 flex-1 truncate text-zinc-100">{track?.name}</span>
      {action}
    </div>
  );
}
