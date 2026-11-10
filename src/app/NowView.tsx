// What's playing right now: the song, where it sits in your library, and what it's about. The app shows
// it as a tab, and Screen.tsx shows it alone at /now, fed by the host instead of this tab's own Spotify login.
import { useEffect, useMemo, useState } from "react";
import type { AudioIndex } from "../core/audio.ts";
import type { Library } from "../core/library.ts";
import { LINE_BREAK } from "../core/lyrics.ts";
import { nowPanels, type NowState } from "../core/now.ts";
import { SoundMap } from "./SoundMap.tsx";
import { PauseIcon, PlayIcon, fmt } from "./SortView.tsx";
import { usePlayer } from "./player.ts";
import { useApp } from "./store.ts";

export type NowControls = { toggle: () => void; next: () => void; previous: () => void; seekTo: (ms: number) => void };

const PANELS = { map: "Sound map", themes: "Lyrics", history: "History", similar: "Sounds like" };
type Panel = keyof typeof PANELS;
const PANELS_KEY = "now-panels";

/** Which panels this screen shows. Kept per browser, since a TV and a monitor may want different ones. */
function readHidden(): Panel[] {
  try {
    return JSON.parse(localStorage.getItem(PANELS_KEY) ?? "[]") as Panel[];
  } catch {
    return [];
  }
}

/** The app's tab: the same screen, built from this tab's own playback state and library. */
export function NowTab({ colors }: { colors: Map<string, string> }) {
  const { lib, audio, neighbors, themes } = useApp();
  const { trackId, paused, position, duration, current, updatedAt, error, toggle, next, previous, seekTo } = usePlayer();
  const panels = useMemo(() => (lib && trackId ? nowPanels(lib, audio, neighbors, themes, trackId) : null), [lib, audio, neighbors, themes, trackId]);
  return (
    <NowView
      state={{ trackId, paused, position, duration, current, updatedAt, error, panels }}
      controls={{ toggle, next, previous, seekTo }}
      colors={colors}
      standalone={false}
      map={lib && audio ? { audio, lib } : null}
    />
  );
}

export function NowView({
  state,
  controls,
  colors,
  standalone,
  map,
  onNeedMap,
}: {
  state: NowState & { updatedAt: number };
  controls: NowControls;
  colors: Map<string, string>;
  standalone: boolean;
  map: { audio: AudioIndex; lib: Library } | null;
  /** Fetches `map` the first time it's shown, since it's large and a screen may keep it off. */
  onNeedMap?: () => void;
}) {
  const { current, trackId, paused, panels: info } = state;
  const [hiddenPanels, setHiddenPanels] = useState(readHidden);
  const [settings, setSettings] = useState(false);
  const show = (panel: Panel) => !hiddenPanels.includes(panel);
  const togglePanel = (panel: Panel) => {
    const next = show(panel) ? [...hiddenPanels, panel] : hiddenPanels.filter((p) => p !== panel);
    setHiddenPanels(next);
    try {
      localStorage.setItem(PANELS_KEY, JSON.stringify(next));
    } catch {
      // Blocked storage only means the choice resets on reload.
    }
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.metaKey || e.ctrlKey) return;
      if (e.key === " ") (e.preventDefault(), controls.toggle());
      else if (e.key === "ArrowRight") controls.next();
      else if (e.key === "ArrowLeft") controls.previous();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [controls]);

  const wantsMap = show("map") && !map;
  useEffect(() => {
    if (wantsMap) onNeedMap?.();
  }, [wantsMap, onNeedMap]);

  const panels = (Object.keys(PANELS) as Panel[]).filter(show);

  return (
    <div className={`relative overflow-hidden ${standalone ? "min-h-screen p-[3vw]" : "rounded-xl p-6"}`}>
      {current?.imageUrl && (
        <div className="pointer-events-none absolute inset-0 scale-125 bg-cover bg-center opacity-25 blur-3xl" style={{ backgroundImage: `url(${current.imageUrl})` }} />
      )}

      <div className="absolute right-4 top-4 z-20">
        <button className="btn" onClick={() => setSettings((s) => !s)} aria-expanded={settings}>
          Settings
        </button>
        {settings && (
          <div className="mt-2 w-64 space-y-2 rounded-lg border border-white/10 bg-zinc-900 p-3 text-sm text-zinc-200 shadow-xl">
            {(Object.keys(PANELS) as Panel[]).map((panel) => (
              <label key={panel} className="flex items-center gap-2">
                <input type="checkbox" checked={show(panel)} onChange={() => togglePanel(panel)} />
                {PANELS[panel]}
              </label>
            ))}
            <button className="btn w-full" onClick={() => void (document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen())}>
              Full screen
            </button>
            {!standalone && (
              <a className="btn block w-full text-center" href="/now" target="_blank" rel="noreferrer">
                Open by itself
              </a>
            )}
            <HostAccess />
          </div>
        )}
      </div>

      {!current ? (
        <div className="relative grid min-h-[70vh] place-items-center text-center">
          <div>
            <div className="text-4xl font-extrabold text-zinc-50">Nothing playing</div>
            <div className="mt-2 text-sm text-zinc-400">{state.error ?? "Play something on Spotify and it'll show up here."}</div>
          </div>
        </div>
      ) : (
        <div className={`relative grid items-center gap-[4vw] ${panels.length > 0 && info ? "lg:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)]" : "mx-auto max-w-5xl"}`}>
          <section className="min-w-0">
            {current.imageUrl ? (
              <img src={current.imageUrl} alt="" className="aspect-square w-full max-w-[56vh] rounded-lg object-cover shadow-2xl shadow-black/60" />
            ) : (
              <div className="aspect-square w-full max-w-[56vh] rounded-lg bg-zinc-900" />
            )}
            <h1 className="mt-[3vh] text-[clamp(2.25rem,5vw,6rem)] font-extrabold leading-[0.95] tracking-tight text-balance text-zinc-50">{current.name}</h1>
            <p className="mt-2 text-[clamp(1.1rem,2vw,2.25rem)] font-medium text-zinc-100">{current.artists.join(", ")}</p>
            <p className="truncate text-[clamp(0.8rem,1.1vw,1.25rem)] text-zinc-400">{current.album}</p>
            <div className="mt-[3vh] flex max-w-3xl items-center gap-3">
              <button className="btn" onClick={controls.previous} aria-label="Previous song">
                ‹‹
              </button>
              <button onClick={controls.toggle} className="grid size-11 shrink-0 place-items-center rounded-full bg-zinc-100 text-zinc-950 hover:bg-white" aria-label={paused ? "Play" : "Pause"}>
                {paused ? <PlayIcon /> : <PauseIcon />}
              </button>
              <button className="btn" onClick={controls.next} aria-label="Next song">
                ››
              </button>
              <NowProgress state={state} onSeek={controls.seekTo} />
            </div>
            {state.error && <p className="mt-2 text-xs text-rose-400">{state.error}</p>}
          </section>

          {info && trackId && (
            <aside className="min-w-0 space-y-[2.5vh] text-[clamp(0.85rem,1.1vw,1.35rem)]">
              {show("map") && map && info.mapped && (
                <SoundMap audio={map.audio} lib={map.lib} colors={colors} height={Math.round(window.innerHeight * 0.38)} scene={{ kind: "song", id: trackId }} />
              )}
              {show("history") && (info.added || info.playlists.length > 0) && (
                <div>
                  {info.added && (
                    <p className="text-zinc-300">
                      In your library since <b className="font-semibold text-zinc-50">{new Date(info.added).toLocaleDateString(undefined, { month: "long", year: "numeric" })}</b>
                    </p>
                  )}
                  <p className="mt-1 flex flex-wrap gap-x-3 text-zinc-400">
                    {info.playlists.map((p) => (
                      <span key={p.id} className="inline-flex items-center gap-1.5">
                        <span className="size-2 rounded-full" style={{ background: colors.get(p.id) }} />
                        {p.name}
                      </span>
                    ))}
                  </p>
                </div>
              )}
              {show("themes") && info.about && (
                <div>
                  <p className="text-zinc-300">
                    Lyrics lean toward <b className="font-semibold text-zinc-50">{info.about.names.join(" and ")}</b>
                  </p>
                  <p className="mt-1 line-clamp-4 whitespace-pre-line leading-snug text-zinc-400">{info.about.passage.split(LINE_BREAK).join("\n")}</p>
                </div>
              )}
              {show("similar") && info.similar.length > 0 && (
                <div>
                  <p className="text-zinc-300">Sounds like</p>
                  <ul className="mt-1 space-y-0.5">
                    {info.similar.map((n) => (
                      <li key={`${n.name}|${n.artist}`} className="truncate text-zinc-400">
                        <span className="text-zinc-200">{n.name}</span> · {n.artist}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </aside>
          )}
        </div>
      )}
    </div>
  );
}

/** Smooth progress bar between the host's updates; click to seek. */
function NowProgress({ state, onSeek }: { state: Pick<NowState, "position" | "duration" | "paused"> & { updatedAt: number }; onSeek: (ms: number) => void }) {
  const { position, duration, paused, updatedAt } = state;
  const [, tick] = useState(0);
  useEffect(() => {
    if (paused) return;
    const id = setInterval(() => tick((t) => t + 1), 250);
    return () => clearInterval(id);
  }, [paused]);
  const now = Math.min(paused ? position : position + (performance.now() - updatedAt), duration);
  return (
    <div className="flex min-w-0 flex-1 items-center gap-2.5 text-[11px] text-zinc-400">
      <span>{fmt(now)}</span>
      <div
        className="h-1 flex-1 cursor-pointer rounded-full bg-zinc-800"
        onClick={(e) => {
          const rect = e.currentTarget.getBoundingClientRect();
          onSeek(((e.clientX - rect.left) / rect.width) * duration);
        }}
      >
        <div className="h-full rounded-full bg-zinc-100" style={{ width: `${(now / (duration || 1)) * 100}%` }} />
      </div>
      <span>{fmt(duration)}</span>
    </div>
  );
}

type HostStatus = { addresses: string[]; passwordSet: boolean };

/** Only on the Mac itself: where other devices find this screen, and the password they need. */
function HostAccess() {
  const [status, setStatus] = useState<HostStatus | "off" | "elsewhere" | null>(null);
  const [password, setPassword] = useState("");
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    fetch("/host/status")
      .then(async (res) => setStatus(res.status === 403 ? "elsewhere" : res.ok ? ((await res.json()) as HostStatus) : "off"))
      .catch(() => setStatus("off"));
  }, [saved]);

  if (status === null || status === "elsewhere") return null;
  if (status === "off") return <p className="text-xs text-zinc-500">Run `pnpm host` to open this on other screens without a tab here.</p>;
  return (
    <form
      className="space-y-1.5 border-t border-white/10 pt-2 text-xs text-zinc-400"
      onSubmit={(e) => {
        e.preventDefault();
        void fetch("/host/password", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password }) }).then((res) => {
          if (!res.ok) return;
          setPassword("");
          setSaved(true);
        });
      }}
    >
      {status.addresses.map((a) => (
        <p key={a} className="select-all break-all text-zinc-200">
          {a}
        </p>
      ))}
      <label className="block">
        {status.passwordSet ? "Change the password (signs other devices out)" : "Password for other devices"}
        <input
          type="password"
          minLength={4}
          value={password}
          onChange={(e) => {
            setPassword(e.target.value);
            setSaved(false);
          }}
          className="mt-1 block w-full rounded border border-white/10 bg-zinc-800 p-1 text-sm text-zinc-100"
        />
      </label>
      <button className="btn w-full" disabled={password.length < 4}>
        {saved ? "Saved" : "Set password"}
      </button>
    </form>
  );
}
