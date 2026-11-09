// ⌘K palette: the one place for everything that isn't sorting the current song. Typing finds
// playlists (Enter checks one; Hide/Artists… on the row) or creates one; settings and hidden
// playlists are listed too, filtered by the same query.
import { useEffect, useMemo, useRef, useState } from "react";
import { sortTargets } from "../core/library.ts";
import { usePlayer } from "./player.ts";
import { useApp, type Order } from "./store.ts";

type Item = {
  key: string;
  label: string;
  hint?: string;
  color?: string;
  run: () => void;
  /** Secondary buttons shown on the row. */
  extra?: { label: string; run: () => void }[];
};

const ORDERS: Record<Order, string> = {
  similar: "Order: similar songs together",
  confident: "Order: most confident first",
  newest: "Order: newest liked first",
};

export function CommandPalette({
  colors,
  onClose,
  onEditRule,
}: {
  colors: Map<string, string>;
  onClose: () => void;
  onEditRule: (playlistId: string) => void;
}) {
  const { lib, audio, picked, hidden, uncounted, rules, order, removeFromLikes } = useApp();
  const { togglePick, setHidden, setUncounted, createPlaylist, setOrder, setRemoveFromLikes } = useApp.getState();
  const { enabled: playerOn, setEnabled: setPlayerOn, devices, deviceId, setDevice } = usePlayer();
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => inputRef.current?.focus(), []);

  const groups = useMemo(() => {
    if (!lib) return [];
    const q = query.trim().toLowerCase();
    const matches = (label: string) => label.toLowerCase().includes(q);
    const targets = sortTargets(lib);
    const name = (id: string) => targets.find((p) => p.id === id)?.name ?? "Deleted playlist";

    const playlists: Item[] = q
      ? targets
          .filter((p) => matches(p.name))
          .slice(0, 8)
          .map((p) => ({
            key: p.id,
            label: p.name,
            color: colors.get(p.id),
            hint: [picked.includes(p.id) && "checked", hidden.includes(p.id) && "hidden", uncounted.includes(p.id) && "not counted", rules[p.id] && "artist rule"].filter(Boolean).join(", "),
            run: () => togglePick(p.id),
            extra: [
              { label: hidden.includes(p.id) ? "Unhide" : "Hide", run: () => setHidden(p.id, !hidden.includes(p.id)) },
              { label: uncounted.includes(p.id) ? "Count as sorted" : "Don't count", run: () => setUncounted(p.id, !uncounted.includes(p.id)) },
              { label: "Artists…", run: () => onEditRule(p.id) },
            ],
          }))
      : [];
    if (q && !targets.some((p) => p.name.toLowerCase() === q))
      playlists.push({ key: "create", label: `Create “${query.trim()}”`, hint: "private, checked", run: () => void createPlaylist(query.trim()) });

    const settings: Item[] = [
      ...(Object.entries(ORDERS) as [Order, string][])
        .filter(([o]) => o !== "similar" || audio)
        .map(([o, label]) => ({ key: o, label, hint: o === order ? "current" : "", run: () => setOrder(o) })),
      {
        key: "likes",
        label: "Remove from Liked Songs after sorting",
        hint: removeFromLikes ? "on" : "off",
        run: () => setRemoveFromLikes(!removeFromLikes),
      },
      { key: "player", label: "Player controls (off: covers and Space open songs in Spotify)", hint: playerOn ? "on" : "off", run: () => setPlayerOn(!playerOn) },
      ...(playerOn ? devices : []).map((d) => ({ key: d.id, label: `Play on ${d.name}`, hint: d.id === deviceId ? "current" : "", run: () => setDevice(d.id) })),
    ].filter((i) => matches(i.label));

    const unhide: Item[] = hidden
      .filter((id) => matches(name(id)))
      .map((id) => ({ key: `hidden-${id}`, label: `Unhide ${name(id)}`, color: colors.get(id), run: () => setHidden(id, false) }));

    return ([["Playlists", playlists], ["Settings", settings], ["Hidden", unhide]] as const).filter(([, items]) => items.length > 0);
  }, [lib, audio, query, picked, hidden, uncounted, rules, order, removeFromLikes, playerOn, setPlayerOn, devices, deviceId, colors, togglePick, setHidden, setUncounted, createPlaylist, setOrder, setRemoveFromLikes, setDevice, onEditRule]);

  const items = groups.flatMap(([, xs]) => xs);
  const choose = (item: Item | undefined) => {
    if (!item) return;
    item.run();
    onClose();
  };
  let index = 0;

  return (
    <div className="fixed inset-0 z-40 grid place-items-start justify-center bg-black/50 px-4 pt-[12vh]" onMouseDown={onClose}>
      <div
        className="w-full max-w-lg overflow-hidden rounded-xl border border-white/10 bg-zinc-900 shadow-2xl shadow-black/60"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => (setQuery(e.target.value), setCursor(0))}
          onKeyDown={(e) => {
            if (e.key === "Escape") onClose();
            else if (e.key === "ArrowDown") (e.preventDefault(), setCursor((c) => Math.min(c + 1, items.length - 1)));
            else if (e.key === "ArrowUp") (e.preventDefault(), setCursor((c) => Math.max(c - 1, 0)));
            else if (e.key === "Enter") (e.preventDefault(), choose(items[cursor]));
          }}
          placeholder="Find or create a playlist, change a setting…"
          className="w-full border-b border-white/10 bg-transparent px-4 py-3.5 text-[15px] text-zinc-50 placeholder:text-zinc-500 focus:outline-none"
        />
        <div className="max-h-[50vh] overflow-y-auto p-1.5">
          {groups.map(([title, xs]) => (
            <div key={title}>
              <div className="px-2.5 pb-1 pt-2 text-[11px] text-zinc-500">{title}</div>
              {xs.map((item) => {
                const i = index++;
                return (
                  <div
                    key={item.key}
                    onMouseEnter={() => setCursor(i)}
                    className={`group flex items-center gap-2.5 rounded-md px-2.5 py-2 text-sm ${i === cursor ? "bg-white/10" : ""}`}
                  >
                    <button className="flex min-w-0 flex-1 items-center gap-2.5 text-left" onClick={() => choose(item)}>
                      {item.color && <span className="size-2 shrink-0 rounded-full" style={{ background: item.color }} />}
                      <span className="truncate text-zinc-100">{item.label}</span>
                      <span className="ml-auto shrink-0 text-xs text-zinc-500">{item.hint}</span>
                    </button>
                    {item.extra?.map((x) => (
                      <button
                        key={x.label}
                        onClick={() => choose({ ...item, run: x.run })}
                        className={`rounded px-1.5 py-0.5 text-xs text-zinc-400 hover:bg-white/10 hover:text-zinc-100 ${i === cursor ? "" : "invisible group-hover:visible"}`}
                      >
                        {x.label}
                      </button>
                    ))}
                  </div>
                );
              })}
            </div>
          ))}
          {groups.length === 0 && <div className="px-2.5 py-3 text-sm text-zinc-500">Nothing matches.</div>}
        </div>
      </div>
    </div>
  );
}
