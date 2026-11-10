// The state of one sonic bridge: its two ends, its length, and the route built between them. The map draws
// the route and BridgePanel lists it, so it lives above both.
import { useMemo, useState } from "react";
import { buildBridge, hops, type Candidate } from "../core/bridge.ts";
import type { Track } from "../core/library.ts";
import { useApp } from "./store.ts";

/** Different releases of one song share this. */
const songKey = (t: Track) => `${t.name}|${t.artists[0]?.id}`;
const candidateOf = (t: Track): Candidate => ({ id: t.id, artist: t.artists[0]?.id });

export function useBridge() {
  const { lib, audio, vectors } = useApp();
  const [ends, setEnds] = useState<{ from: string; to: string | null } | null>(null);
  const [length, setLength] = useState(12);
  const [replaced, setReplaced] = useState<string[]>([]); // songs taken out of this bridge

  // One release per song, and only songs with sound vectors.
  const candidates = useMemo(() => {
    const seen = new Set<string>();
    return (audio?.ids ?? []).flatMap((id) => {
      const track = lib?.tracks[id];
      if (!track || seen.has(songKey(track))) return [];
      seen.add(songKey(track));
      return [track];
    });
  }, [audio, lib]);

  const from = ends?.from ?? null;
  const to = ends?.to ?? null;
  const ids = useMemo(() => {
    const [start, end] = [lib?.tracks[from ?? ""], lib?.tracks[to ?? ""]];
    if (!start || !end || !audio || !vectors) return [];
    const endSongs = new Set([songKey(start), songKey(end)]);
    const pool = candidates.filter((t) => !replaced.includes(t.id) && !endSongs.has(songKey(t))).map(candidateOf);
    return buildBridge(audio, vectors, candidateOf(start), candidateOf(end), length, pool);
  }, [from, to, lib, audio, vectors, length, candidates, replaced]);
  const steps = useMemo(() => (audio && vectors ? hops(audio, vectors, ids) : []), [audio, vectors, ids]);

  return {
    from,
    to,
    ids,
    steps,
    length,
    setLength,
    /** A start has been chosen, and the next song chosen is the end. */
    picking: from !== null && to === null,
    start: (id: string) => {
      setEnds({ from: id, to: null });
      setReplaced([]);
    },
    finish: (id: string) => {
      if (id !== from) setEnds((e) => e && { ...e, to: id });
    },
    changeEnd: () => {
      setEnds((e) => e && { ...e, to: null });
      setReplaced([]);
    },
    close: () => {
      setEnds(null);
      setReplaced([]);
    },
    replace: (id: string) => setReplaced((r) => [...r, id]),
  };
}

export type Bridge = ReturnType<typeof useBridge>;
