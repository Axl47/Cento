// What a playlist is, for deciding whether a song belongs in it: its size, languages, lyric themes and how well
// sound predicts it, along with the playlist's own settings.
import { useMemo } from "react";
import { playlistLanguages } from "../core/languages.ts";
import type { Track } from "../core/library.ts";
import { readPlaylist, sharedThemes } from "../core/themes.ts";
import { useApp } from "./store.ts";

const LANGUAGES_SHOWN = 4;
/** Below this, a language is as likely to be a misdetection as a real part of the playlist. */
const MIN_LANGUAGE_SHARE = 0.03;

const percent = (share: number) => `${Math.round(Math.min(Math.max(share, 0), 1) * 100)}%`;

export function PlaylistInfo({ playlistId, track, colors, onEditRule }: { playlistId: string; track: Track; colors: Map<string, string>; onEditRule: () => void }) {
  const { lib, themes, languages, rules, hidden, setHidden, classifier } = useApp();
  const playlist = lib?.playlists.find((p) => p.id === playlistId);
  const color = colors.get(playlistId) ?? "#a092ab";

  const spoken = useMemo(() => {
    if (!lib || !playlist || !languages) return null;
    const { detected, shares } = playlistLanguages(languages, lib, playlist);
    const shown = shares.filter((s) => s.share >= MIN_LANGUAGE_SHARE).slice(0, LANGUAGES_SHOWN);
    return { detected, shown, other: 1 - shown.reduce((sum, s) => sum + s.share, 0) };
  }, [lib, playlist, languages]);

  const about = useMemo(() => {
    if (!lib || !playlist || !themes) return null;
    const reading = readPlaylist(themes, lib, playlist);
    return { clear: reading.clear, shared: new Set(sharedThemes(reading, themes, track).map((t) => t.theme)) };
  }, [lib, playlist, themes, track]);

  if (!playlist) return null;
  const rule = rules[playlistId];
  const isHidden = hidden.includes(playlistId);
  const soundScore = classifier?.score(track.id, playlistId);
  const fit = classifier?.fit(playlistId);

  return (
    <section className="mt-5 min-h-32 border-t border-white/10 pt-4 text-xs text-zinc-400">
      <div className="flex items-center gap-2">
        <span className="size-2.5 shrink-0 rounded-full" style={{ background: color }} />
        <h3 className="min-w-0 flex-1 truncate text-sm font-bold text-zinc-50">{playlist.name}</h3>
        <button
          onClick={onEditRule}
          className={`rounded px-1.5 py-0.5 hover:bg-white/10 hover:text-zinc-100 ${rule ? "text-zinc-200" : "text-zinc-500"}`}
          title="Only suggest this playlist for certain artists"
        >
          {rule ? `Only ${rule.map((a) => a.name).join(", ")}` : "Artists…"}
        </button>
        <button
          onClick={() => setHidden(playlistId, !isHidden)}
          className="rounded px-1.5 py-0.5 text-zinc-500 hover:bg-white/10 hover:text-zinc-100"
          title={isHidden ? "Suggest this playlist again" : "Never suggest this playlist (e.g. a Best of)"}
        >
          {isHidden ? "Unhide" : "Hide"}
        </button>
      </div>

      <dl className="mt-2.5 grid grid-cols-[max-content_minmax(0,1fr)] gap-x-4 gap-y-1.5">
        <dt className="text-zinc-500">Songs</dt>
        <dd className="font-semibold text-zinc-100">{playlist.trackIds.length.toLocaleString()}</dd>

        {spoken && (
          <>
            <dt className="text-zinc-500">Languages</dt>
            <dd className="text-zinc-200">
              {spoken.detected === 0
                ? "None detected"
                : [...spoken.shown.map((s) => `${s.name} ${percent(s.share)}`), ...(spoken.other >= 0.005 ? [`Other ${percent(spoken.other)}`] : [])].join(" · ")}
              {spoken.detected > 0 && spoken.detected < playlist.trackIds.length && <span className="text-zinc-500"> of {spoken.detected.toLocaleString()} with lyrics</span>}
            </dd>
          </>
        )}

        {about && (
          <>
            <dt className="text-zinc-500">Themes</dt>
            <dd>
              {about.clear.length === 0 && <span className="text-zinc-500">None stand out</span>}
              <span className="flex flex-wrap gap-1">
                {about.clear.map((t) => (
                  <span
                    key={t.theme}
                    title={about.shared.has(t.theme) ? "This song carries this theme too" : undefined}
                    className={`rounded-full border px-2 py-px ${about.shared.has(t.theme) ? "font-semibold text-zinc-50" : "border-white/10 text-zinc-300"}`}
                    style={about.shared.has(t.theme) ? { borderColor: color } : undefined}
                  >
                    {t.name}
                  </span>
                ))}
              </span>
            </dd>
          </>
        )}

        {soundScore !== undefined && (
          <>
            <dt className="text-zinc-500">Sound model</dt>
            <dd className="text-zinc-300">
              <b className="font-semibold text-zinc-100">{percent(soundScore)}</b> fit for this song
              {fit?.auc != null && ` · ${fit.auc.toFixed(2)} on new artists`}
              {fit && (fit.cutoff != null ? ` · auto-checks at ${percent(fit.cutoff)}` : " · too unreliable to auto-check")}
            </dd>
          </>
        )}
      </dl>
    </section>
  );
}
