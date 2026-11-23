// The Now Playing screen on its own (/now): for a TV or spare monitor. Everything comes from the host,
// so it needs no Spotify login of its own, only the password when it isn't on the Mac.
import { useCallback, useEffect, useMemo, useState } from "react";
import type { AudioIndex } from "../core/audio.ts";
import type { Library, Playlist } from "../core/library.ts";
import { NOTHING_PLAYING, type NowState } from "../core/now.ts";
import { usePlaylistColors } from "./colors.ts";
import { NowView, type NowControls } from "./NowView.tsx";

type Phase = { kind: "checking" } | { kind: "offline" } | { kind: "locked"; passwordSet: boolean } | { kind: "ready"; playlists: Playlist[] };

const send = (path: string, body: unknown = {}) => fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

const command = (name: string, body?: unknown) => void send(`/host/player/${name}`, body).catch(console.error);
const controls: NowControls = {
  toggle: () => command("toggle"),
  next: () => command("next"),
  previous: () => command("previous"),
  seekTo: (ms) => command("seek", { ms }),
  mark: (rating) => send("/host/player/mark", { rating }).then((res) => res.ok, () => false),
};

export function Screen() {
  const [phase, setPhase] = useState<Phase>({ kind: "checking" });

  const check = useCallback(async () => {
    try {
      const res = await fetch("/host/session");
      const body = (await res.json()) as { playlists: Playlist[] } & { passwordSet: boolean };
      if (res.status === 401) setPhase({ kind: "locked", passwordSet: body.passwordSet });
      else if (res.ok) setPhase({ kind: "ready", playlists: body.playlists });
      else setPhase({ kind: "offline" });
    } catch {
      setPhase({ kind: "offline" });
    }
  }, []);
  useEffect(() => void check(), [check]);

  if (phase.kind === "checking") return <Center>Loading…</Center>;
  if (phase.kind === "offline") return <Center>Can't reach the host. Run `pnpm host` on the Mac, then reload.</Center>;
  if (phase.kind === "locked")
    return phase.passwordSet ? <PasswordForm onDone={() => void check()} /> : <Center>Set a password from Now Playing's settings on the Mac, then reload this page.</Center>;
  return <Connected playlists={phase.playlists} onLost={() => void check()} />;
}

function Connected({ playlists, onLost }: { playlists: Playlist[]; onLost: () => void }) {
  const [state, setState] = useState<NowState & { updatedAt: number }>({ ...NOTHING_PLAYING, source: null, segue: null, previous: null, panels: null, error: null, updatedAt: 0 });
  const [map, setMap] = useState<{ audio: AudioIndex; lib: Library } | null>(null);
  const colors = usePlaylistColors(useMemo(() => playlists, [playlists]));

  useEffect(() => {
    const events = new EventSource("/host/events");
    events.onmessage = (e) => setState({ ...(JSON.parse(e.data as string) as NowState), updatedAt: performance.now() });
    // It retries by itself through a dropped connection, and gives up only when turned away.
    events.onerror = () => events.readyState === EventSource.CLOSED && onLost();
    return () => events.close();
  }, [onLost]);

  const loadMap = useCallback(() => {
    void fetch("/host/map")
      .then((res) => (res.ok ? (res.json() as Promise<{ audio: AudioIndex; lib: Library }>) : null))
      .then(setMap)
      .catch(console.error);
  }, []);

  return <NowView state={state} controls={controls} colors={colors} standalone map={map} onNeedMap={loadMap} />;
}

function PasswordForm({ onDone }: { onDone: () => void }) {
  const [password, setPassword] = useState("");
  const [wrong, setWrong] = useState(false);
  return (
    <Center>
      <form
        className="w-72 space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          void send("/host/login", { password }).then((res) => (res.ok ? onDone() : setWrong(true)));
        }}
      >
        <label className="block text-sm text-zinc-300">
          Password for this screen
          <input
            autoFocus
            type="password"
            value={password}
            onChange={(e) => {
              setPassword(e.target.value);
              setWrong(false);
            }}
            className="mt-1 block w-full rounded-lg border border-white/10 bg-zinc-900 px-3 py-2 text-zinc-50"
          />
        </label>
        {wrong && <p className="text-xs text-rose-400">That's not it. Try again in a moment.</p>}
        <button className="btn w-full">Open</button>
      </form>
    </Center>
  );
}

function Center({ children }: { children: React.ReactNode }) {
  return <div className="grid min-h-screen place-items-center p-6 text-center text-zinc-300">{children}</div>;
}
