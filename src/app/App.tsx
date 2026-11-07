// App shell: login, loading the shared library/audio files, syncing from Spotify, tabs.
import { useEffect, useMemo, useState } from "react";
import { decodeVectors, type AudioIndex } from "../core/audio.ts";
import type { ArtistRules } from "../core/suggest.ts";
import type { LedgerEntry } from "../core/ledger.ts";
import { sortTargets, syncLibrary, type Library } from "../core/library.ts";
import { client, completeLogin, logout, startLogin } from "./auth.ts";
import { usePlaylistColors } from "./colors.ts";
import { MapView } from "./MapView.tsx";
import { usePlayer } from "./player.ts";
import { SortView } from "./SortView.tsx";
import { useApp } from "./store.ts";

type Phase = { kind: "starting" } | { kind: "login" } | { kind: "needs-sync" } | { kind: "ready" } | { kind: "error"; message: string };

const getJson = async <T,>(url: string): Promise<T | null> => {
  const res = await fetch(url);
  return res.ok ? ((await res.json()) as T) : null;
};

/** Fetches the sound vectors in the background (large, and only needed for hover details). */
async function loadVectors(audio: AudioIndex) {
  try {
    const res = await fetch("/api/vectors");
    if (!res.ok) return;
    const vectors = decodeVectors(await res.arrayBuffer());
    // Written alongside audio.json; a mismatch means a half-finished `pnpm audio`.
    if (vectors.scale.length === audio.ids.length) useApp.getState().setVectors(vectors);
  } catch {
    // Optional: hover falls back to the stored nearest neighbors.
  }
}

export function App() {
  const [phase, setPhase] = useState<Phase>({ kind: "starting" });
  const [tab, setTab] = useState<"sort" | "map">("sort");
  const [syncing, setSyncing] = useState<string | null>(null);
  const { lib, load, replaceLibrary, status, pendingWrites, queue, jumpTo } = useApp();
  const initPlayer = usePlayer((s) => s.init);

  useEffect(() => {
    void (async () => {
      try {
        if (!(await completeLogin())) return setPhase({ kind: "login" });
        initPlayer();
        const [library, audio, rules, hidden, ledger] = await Promise.all([
          getJson<Library>("/api/library"),
          getJson<AudioIndex>("/api/audio"),
          getJson<ArtistRules>("/api/rules"),
          getJson<string[]>("/api/hidden"),
          getJson<LedgerEntry[]>("/api/ledger"),
        ]);
        if (!library) return setPhase({ kind: "needs-sync" });
        load(library, audio, rules ?? {}, hidden ?? [], ledger ?? []);
        setPhase({ kind: "ready" });
        if (audio) void loadVectors(audio);
      } catch (e) {
        setPhase({ kind: "error", message: e instanceof Error ? e.message : String(e) });
      }
    })();
  }, [initPlayer, load]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.metaKey || e.ctrlKey) return;
      if (e.key.toLowerCase() === "m") setTab((t) => (t === "map" ? "sort" : "map"));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Don't lose queued Spotify writes by closing the tab.
  useEffect(() => {
    const onUnload = (e: BeforeUnloadEvent) => {
      if (useApp.getState().pendingWrites > 0) e.preventDefault();
    };
    window.addEventListener("beforeunload", onUnload);
    return () => window.removeEventListener("beforeunload", onUnload);
  }, []);

  const resync = async () => {
    setSyncing("Starting…");
    try {
      const fresh = await syncLibrary(client, setSyncing);
      await fetch("/api/library", { method: "PUT", body: JSON.stringify(fresh) });
      if (phase.kind === "ready") replaceLibrary(fresh);
      else {
        const audio = await getJson<AudioIndex>("/api/audio");
        load(
          fresh,
          audio,
          (await getJson<ArtistRules>("/api/rules")) ?? {},
          (await getJson<string[]>("/api/hidden")) ?? [],
          (await getJson<LedgerEntry[]>("/api/ledger")) ?? [],
        );
        if (audio) void loadVectors(audio);


        setPhase({ kind: "ready" });
      }
    } catch (e) {
      setPhase({ kind: "error", message: e instanceof Error ? e.message : String(e) });
    } finally {
      setSyncing(null);
    }
  };

  const targets = useMemo(() => (lib ? sortTargets(lib) : []), [lib]);
  const colors = usePlaylistColors(targets);

  if (phase.kind === "starting") return <Center>Loading…</Center>;
  if (phase.kind === "login")
    return (
      <Center>
        <button className="btn bg-emerald-500 px-6 py-3 text-base font-semibold text-emerald-950 hover:bg-emerald-400" onClick={() => void startLogin()}>
          Log in with Spotify
        </button>
      </Center>
    );
  if (phase.kind === "error")
    return (
      <Center>
        <div className="space-y-3 text-center">
          <p className="text-rose-400">{phase.message}</p>
          <button className="btn" onClick={logout}>Log out</button>
        </div>
      </Center>
    );
  if (phase.kind === "needs-sync")
    return (
      <Center>
        <div className="space-y-3 text-center">
          <p className="text-zinc-300">No local library yet.</p>
          <button className="btn bg-zinc-100 px-5 py-2.5 font-semibold text-zinc-950" disabled={!!syncing} onClick={() => void resync()}>
            {syncing ?? "Sync from Spotify (~1.5 min)"}
          </button>
        </div>
      </Center>
    );

  return (
    <div className="mx-auto max-w-[1600px] px-4 py-4 sm:px-6">
      <header className="mb-5 flex flex-wrap items-center gap-4">
        <h1 className="text-lg font-black tracking-tight text-zinc-50">
          playlist<span className="text-commit">/</span>sorter
        </h1>
        <nav className="flex rounded-lg border border-white/10 bg-zinc-900 p-0.5 text-sm">
          {(["sort", "map"] as const).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              title="Switch with M"
              className={`rounded-md px-3 py-1 ${tab === t ? "bg-white/10 text-zinc-50" : "text-zinc-400 hover:text-zinc-200"}`}
            >
              {t === "sort" ? "Sort" : "Sound map"}
            </button>
          ))}
        </nav>
        <div className="ml-auto flex items-center gap-3 text-xs">
          <span
            className={
              status.kind === "error" ? "text-rose-400" : status.kind === "saving" ? "text-amber-300" : "text-zinc-500"
            }
            title={status.message}
          >
            {status.kind === "error" ? `⚠ ${status.message}` : pendingWrites > 0 ? `Saving to Spotify… (${pendingWrites})` : "All changes saved"}
          </span>
          <button className="btn" disabled={!!syncing} onClick={() => void resync()} title="Refetch everything from Spotify">
            {syncing ?? "Resync"}
          </button>
          <button className="btn" onClick={logout} title="Forget the Spotify login and sign in again">
            Log out
          </button>
        </div>
      </header>

      {tab === "sort" ? (
        <SortView colors={colors} />
      ) : (
        <MapView
          colors={colors}
          onSortSong={(id) => {
            if (queue.includes(id)) jumpTo(id);
            setTab("sort");
          }}
        />
      )}
    </div>
  );
}

function Center({ children }: { children: React.ReactNode }) {
  return <div className="grid min-h-screen place-items-center p-6 text-zinc-300">{children}</div>;
}
