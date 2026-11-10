// What's playing right now, for a second screen: the song, where it sits in your library, and what it's about.
// Also opens on its own at /now, without the rest of the app around it.
import { useEffect, useMemo, useState } from "react";
import { firstAdded, sortTargets } from "../core/library.ts";
import { LINE_BREAK } from "../core/lyrics.ts";
import { songThemes } from "../core/themes.ts";
import { SoundMap } from "./SoundMap.tsx";
import { PauseIcon, PlayIcon, Progress } from "./SortView.tsx";
import { usePlayer } from "./player.ts";
import { useApp } from "./store.ts";

const PANELS = { map: "Sound map", themes: "Lyrics", history: "History", similar: "Sounds like" };
type Panel = keyof typeof PANELS;
const PANELS_KEY = "now-panels";
const SIMILAR = 5;

/** Which panels this screen shows. Kept per browser, since a TV and a monitor may want different ones. */
function readHidden(): Panel[] {
  try {
    return JSON.parse(localStorage.getItem(PANELS_KEY) ?? "[]") as Panel[];
  } catch {
    return [];
  }
}

export function NowView({ colors, standalone }: { colors: Map<string, string>; standalone: boolean }) {
  const { lib, audio, neighbors, themes } = useApp();
  const player = usePlayer();
  const { current, trackId, paused, duration } = player;
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
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement || e.metaKey || e.ctrlKey) return;
      if (e.key === " ") (e.preventDefault(), player.toggle());
      else if (e.key === "ArrowRight") player.next();
      else if (e.key === "ArrowLeft") player.previous();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [player]);

  const track = trackId ? lib?.tracks[trackId] : undefined;
  const dates = useMemo(() => (lib ? firstAdded(lib) : new Map<string, string>()), [lib]);
  const about = useMemo(() => (themes && track ? songThemes(themes, track) : []), [themes, track]);
  const playlists = useMemo(() => (lib && track ? sortTargets(lib).filter((p) => p.trackIds.includes(track.id)) : []), [lib, track]);
  const similar = track && neighbors ? neighbors(track.id).slice(0, SIMILAR) : [];
  const added = track ? dates.get(track.id) : undefined;
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
            {player.devices.length > 0 && (
              <label className="block text-xs text-zinc-400">
                Controls
                <select
                  value={player.deviceId ?? ""}
                  onChange={(e) => player.setDevice(e.target.value)}
                  className="mt-1 block w-full rounded border border-white/10 bg-zinc-800 p-1 text-sm text-zinc-100"
                >
                  {player.devices.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.name}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <button className="btn w-full" onClick={() => void (document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen())}>
              Full screen
            </button>
            {standalone ? (
              <a className="btn block w-full text-center" href="/">
                Open the full app
              </a>
            ) : (
              <a className="btn block w-full text-center" href="/now" target="_blank" rel="noreferrer">
                Open by itself
              </a>
            )}
          </div>
        )}
      </div>

      {!current ? (
        <div className="relative grid min-h-[70vh] place-items-center text-center">
          <div>
            <div className="text-4xl font-extrabold text-zinc-50">Nothing playing</div>
            <div className="mt-2 text-sm text-zinc-400">{player.error ?? "Play something on Spotify and it'll show up here."}</div>
          </div>
        </div>
      ) : (
        <div className={`relative grid items-center gap-[4vw] ${panels.length > 0 && track ? "lg:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)]" : "mx-auto max-w-5xl"}`}>
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
              <button className="btn" onClick={player.previous} aria-label="Previous song">
                ‹‹
              </button>
              <button onClick={player.toggle} className="grid size-11 shrink-0 place-items-center rounded-full bg-zinc-100 text-zinc-950 hover:bg-white" aria-label={paused ? "Play" : "Pause"}>
                {paused ? <PlayIcon /> : <PauseIcon />}
              </button>
              <button className="btn" onClick={player.next} aria-label="Next song">
                ››
              </button>
              <Progress playing duration={duration || 1} />
            </div>
            {player.error && <p className="mt-2 text-xs text-rose-400">{player.error}</p>}
          </section>

          {track && (
            <aside className="min-w-0 space-y-[2.5vh] text-[clamp(0.85rem,1.1vw,1.35rem)]">
              {show("map") && audio && lib && audio.ids.includes(track.id) && (
                <div className="overflow-hidden rounded-lg bg-black/30">
                  <SoundMap audio={audio} lib={lib} colors={colors} height={Math.round(window.innerHeight * 0.38)} focusId={track.id} focusZoom={5} />
                </div>
              )}
              {show("history") && (added || playlists.length > 0) && (
                <div>
                  {added && (
                    <p className="text-zinc-300">
                      In your library since <b className="font-semibold text-zinc-50">{new Date(added).toLocaleDateString(undefined, { month: "long", year: "numeric" })}</b>
                    </p>
                  )}
                  <p className="mt-1 flex flex-wrap gap-x-3 text-zinc-400">
                    {playlists.map((p) => (
                      <span key={p.id} className="inline-flex items-center gap-1.5">
                        <span className="size-2 rounded-full" style={{ background: colors.get(p.id) }} />
                        {p.name}
                      </span>
                    ))}
                  </p>
                </div>
              )}
              {show("themes") && about[0] && (
                <div>
                  <p className="text-zinc-300">
                    Lyrics lean toward <b className="font-semibold text-zinc-50">{about.map((m) => m.name).join(" and ")}</b>
                  </p>
                  <p className="mt-1 line-clamp-4 whitespace-pre-line leading-snug text-zinc-400">{about[0].passage.split(LINE_BREAK).join("\n")}</p>
                </div>
              )}
              {show("similar") && similar.length > 0 && (
                <div>
                  <p className="text-zinc-300">Sounds like</p>
                  <ul className="mt-1 space-y-0.5">
                    {similar.map((n) => {
                      const t = lib?.tracks[n.id];
                      return (
                        t && (
                          <li key={n.id} className="truncate text-zinc-400">
                            <span className="text-zinc-200">{t.name}</span> · {t.artists[0]?.name}
                          </li>
                        )
                      );
                    })}
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
