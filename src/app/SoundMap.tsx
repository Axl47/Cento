// Canvas map of every song placed by how it sounds (2D layout of audio embeddings).
// Zoomed out, playlists show as bubbles at the center of their songs; zooming in fades
// the bubbles into individual songs, colored by their most specific playlist, and
// eventually song names. A focused song shows lines to its nearest neighbors.
// Highlighting playlists grays out every other song and keeps only their bubbles. A marked
// song (hovered elsewhere on the page) gets a ring, a line from the focused song, and its name.
import { useEffect, useMemo, useRef, useState } from "react";
import { closestAmong, neighborsFrom, type AudioIndex } from "../core/audio.ts";
import { sortTargets, type Library } from "../core/library.ts";
import { useApp } from "./store.ts";

type Props = {
  audio: AudioIndex;
  lib: Library;
  colors: Map<string, string>;
  height: number;
  /** Song to mark, with lines to its nearest neighbors. */
  focusId?: string | null;
  /** When set, the view glides to the focused song at this zoom. */
  focusZoom?: number;
  /** Playlists to emphasize; every other song turns gray, and focus lines only go to their songs. */
  highlight?: readonly string[];
  /** Song to point out, e.g. one hovered in a list next to the map. */
  mark?: string | null;
  onSelect?: (trackId: string) => void;
};

type Box = [x: number, y: number, w: number, h: number];
const overlaps = (taken: Box[], b: Box) => taken.some(([x, y, w, h]) => b[0] < x + w && b[0] + b[2] > x && b[1] < y + h && b[1] + b[3] > y);
const LABEL_CHARS = 30;
const MAX_LABELS = 70;
const clip = (name: string) => (name.length > LABEL_CHARS ? `${name.slice(0, LABEL_CHARS - 1)}…` : name);

type View = { k: number; cx: number; cy: number };

const GROUP_FADE_END = 2.6; // zoom where playlist bubbles have fully faded out
const LABEL_ZOOM = 7; // zoom where song names start to show
const UNSORTED = "#71717a";
const FOCUS_NEIGHBORS = 15;

export function SoundMap({ audio, lib, colors, height, focusId, focusZoom, highlight = [], mark, onSelect }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const view = useRef<View>({ k: 1, cx: 0, cy: 0 });
  const [width, setWidth] = useState(600);
  const [hover, setHover] = useState<{ i: number; x: number; y: number } | null>(null);
  const redraw = useRef<() => void>(() => {});

  const hidden = useApp((s) => s.hidden);
  const vectors = useApp((s) => s.vectors);
  // Per-point data, parallel to audio.ids. Hidden playlists get no bubble and don't color songs.
  const data = useMemo(() => {
    const targets = sortTargets(lib, hidden);

    const memberOf = new Map<string, string[]>();
    for (const p of targets) for (const id of p.trackIds) memberOf.set(id, [...(memberOf.get(id) ?? []), p.id]);
    const size = new Map(targets.map((p) => [p.id, p.trackIds.length]));
    const names = new Map(targets.map((p) => [p.id, p.name]));

    const playlistsOf = audio.ids.map((id) => memberOf.get(id) ?? []);
    // Most specific (smallest) playlist decides a song's color.
    const primary = playlistsOf.map((ps) => ps.toSorted((a, b) => size.get(a)! - size.get(b)!)[0] ?? null);

    const sums = new Map<string, { x: number; y: number; n: number }>();
    playlistsOf.forEach((ps, i) => {
      const [x, y] = audio.xy[i]!;
      for (const p of ps) {
        const s = sums.get(p) ?? { x: 0, y: 0, n: 0 };
        s.x += x;
        s.y += y;
        s.n++;
        sums.set(p, s);
      }
    });
    const groups = [...sums]
      .filter(([, s]) => s.n >= 3)
      .map(([id, s]) => ({ id, name: names.get(id) ?? "", x: s.x / s.n, y: s.y / s.n, n: s.n }))
      .sort((a, b) => b.n - a.n);

    return { playlistsOf, primary, groups, names, pos: new Map(audio.ids.map((id, i) => [id, i])) };
  }, [audio, lib, hidden]);


  // Song -> the first highlighted playlist it's in. Built from all playlists, so a hidden one still lights up.
  const lit = useMemo(() => {
    const m = new Map<string, string>();
    for (const id of highlight.toReversed())
      for (const t of lib.playlists.find((p) => p.id === id)?.trackIds ?? []) m.set(t, id);
    return m;
  }, [lib, highlight.join()]); // by content: callers pass fresh arrays

  const neighbors = useMemo(() => neighborsFrom(audio), [audio]);
  // Songs the focus lines go to; while highlighting, the closest highlighted ones (exact once vectors load).
  const focusNear = useMemo(() => {
    if (!focusId) return [];
    if (lit.size === 0) return neighbors(focusId).slice(0, FOCUS_NEIGHBORS);
    if (vectors) return closestAmong(audio, vectors, focusId, lit.keys(), FOCUS_NEIGHBORS);
    return neighbors(focusId).filter((n) => lit.has(n.id)).slice(0, FOCUS_NEIGHBORS);
  }, [focusId, lit, neighbors, vectors, audio]);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setWidth(Math.max(200, Math.floor(e!.contentRect.width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const base = Math.min(width, height) / 2 * 0.9;
  const toScreen = (x: number, y: number): [number, number] => {
    const { k, cx, cy } = view.current;
    return [(x - cx) * base * k + width / 2, (y - cy) * base * k + height / 2];
  };
  const toData = (sx: number, sy: number): [number, number] => {
    const { k, cx, cy } = view.current;
    return [(sx - width / 2) / (base * k) + cx, (sy - height / 2) / (base * k) + cy];
  };

  // ---- drawing ----
  redraw.current = () => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    const dpr = window.devicePixelRatio || 1;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);

    const { k } = view.current;
    const groupAlpha = Math.min(Math.max((GROUP_FADE_END - k) / (GROUP_FADE_END - 1), 0), 1);
    const r = Math.min(Math.max(1.4 * Math.sqrt(k), 1.6), 5);
    const highlighting = lit.size > 0;
    // Highlighting colors songs by their highlighted playlist and grays the rest.
    const colorOf = (i: number) => {
      const p = highlighting ? lit.get(audio.ids[i]!) : data.primary[i];
      return p ? (colors.get(p) ?? UNSORTED) : UNSORTED;
    };

    // Songs: gray ones first so highlighted songs draw on top.
    const dotAlpha = 0.3 + 0.6 * (1 - groupAlpha);
    for (const pass of highlighting ? [false, true] : [true]) {
      for (let i = 0; i < audio.ids.length; i++) {
        if (highlighting && lit.has(audio.ids[i]!) !== pass) continue;
        const [sx, sy] = toScreen(...audio.xy[i]!);
        if (sx < -10 || sy < -10 || sx > width + 10 || sy > height + 10) continue;
        ctx.globalAlpha = !highlighting ? dotAlpha : pass ? 0.95 : 0.18;
        ctx.fillStyle = colorOf(i);
        ctx.beginPath();
        ctx.arc(sx, sy, highlighting && pass ? r + 1 : r, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // Playlist bubbles (zoomed out)
    if (groupAlpha > 0) {
      const taken: Box[] = [];
      ctx.font = "600 11px ui-sans-serif, system-ui";
      for (const g of data.groups) {
        if (highlighting && !highlight.includes(g.id)) continue;
        const [sx, sy] = toScreen(g.x, g.y);
        const radius = 3 + Math.sqrt(g.n) * 1.1;
        const color = colors.get(g.id) ?? UNSORTED;
        ctx.globalAlpha = 0.22 * groupAlpha;
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(sx, sy, radius, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = 0.85 * groupAlpha;
        ctx.strokeStyle = color;
        ctx.lineWidth = 1.5;
        ctx.stroke();

        const w = ctx.measureText(g.name).width;
        const box: Box = [sx - w / 2 - 3, sy - radius - 16, w + 6, 14];
        if (overlaps(taken, box) && !highlight.includes(g.id)) continue;
        taken.push(box);
        ctx.globalAlpha = groupAlpha;
        ctx.fillStyle = "#fafafa";
        ctx.textAlign = "center";
        ctx.fillText(g.name, sx, sy - radius - 5);
      }
    }

    // Song names (zoomed in): the focus's neighbors first, then highlighted songs, then the rest,
    // skipping any name that would overlap one already drawn.
    if (k >= LABEL_ZOOM) {
      ctx.font = "11px ui-sans-serif, system-ui";
      ctx.textAlign = "left";
      ctx.fillStyle = "#f2ebe3";
      ctx.globalAlpha = Math.min((k - LABEL_ZOOM) / 3 + 0.5, 0.9);
      const order = new Set<number>();
      for (const n of focusNear) {
        const i = data.pos.get(n.id);
        if (i !== undefined) order.add(i);
      }
      if (highlighting) for (let i = 0; i < audio.ids.length; i++) if (lit.has(audio.ids[i]!)) order.add(i);
      for (let i = 0; i < audio.ids.length; i++) order.add(i);
      const taken: Box[] = [];
      const marked = mark ? data.pos.get(mark) : undefined; // gets its own label below
      for (const i of order) {
        if (taken.length >= MAX_LABELS) break;
        if (i === marked) continue;
        const [sx, sy] = toScreen(...audio.xy[i]!);
        if (sx < 0 || sy < 0 || sx > width || sy > height) continue;
        const name = clip(lib.tracks[audio.ids[i]!]?.name ?? "");
        const box: Box = [sx + r + 2, sy - 7, ctx.measureText(name).width + 2, 13];
        if (overlaps(taken, box)) continue;
        taken.push(box);
        ctx.fillText(name, sx + r + 3, sy + 4);
      }
    }

    // Focused song and its neighbors
    const fi = focusId ? data.pos.get(focusId) : undefined;
    if (fi !== undefined) {
      const [fx, fy] = toScreen(...audio.xy[fi]!);
      for (const n of focusNear) {
        const ni = data.pos.get(n.id);
        if (ni === undefined) continue;
        const [nx, ny] = toScreen(...audio.xy[ni]!);
        ctx.globalAlpha = 0.25 + 0.6 * Math.max(n.sim, 0);
        ctx.strokeStyle = colorOf(ni);
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.moveTo(fx, fy);
        ctx.lineTo(nx, ny);
        ctx.stroke();
        ctx.fillStyle = colorOf(ni);
        ctx.beginPath();
        ctx.arc(nx, ny, r + 1.5, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
      ctx.fillStyle = "#fafafa";
      ctx.beginPath();
      ctx.arc(fx, fy, 5.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = "#fafafa";
      ctx.lineWidth = 1.5;
      ctx.globalAlpha = 0.4;
      ctx.beginPath();
      ctx.arc(fx, fy, 10, 0, Math.PI * 2);
      ctx.stroke();
    }

    const mi = mark ? data.pos.get(mark) : undefined;
    if (mi !== undefined) {
      const [mx, my] = toScreen(...audio.xy[mi]!);
      ctx.globalAlpha = 0.8;
      ctx.strokeStyle = "#f2ebe3";
      ctx.lineWidth = 1.5;
      if (fi !== undefined && audio.ids[mi] !== focusId) {
        const [fx, fy] = toScreen(...audio.xy[fi]!);
        ctx.setLineDash([4, 4]);
        ctx.beginPath();
        ctx.moveTo(fx, fy);
        ctx.lineTo(mx, my);
        ctx.stroke();
        ctx.setLineDash([]);
      }
      ctx.globalAlpha = 1;
      ctx.fillStyle = colorOf(mi);
      ctx.beginPath();
      ctx.arc(mx, my, r + 2.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(mx, my, r + 6, 0, Math.PI * 2);
      ctx.stroke();
      // Name in a pill, kept inside the map even when the song is off-screen.
      ctx.font = "600 12px ui-sans-serif, system-ui";
      const name = clip(lib.tracks[mark!]?.name ?? "");
      const w = ctx.measureText(name).width + 14;
      const px = Math.min(Math.max(mx + 12, 6), width - w - 6);
      const py = Math.min(Math.max(my - 26, 6), height - 26);
      ctx.fillStyle = "#17111bee";
      ctx.beginPath();
      ctx.roundRect(px, py, w, 20, 6);
      ctx.fill();
      ctx.fillStyle = "#f7f2ec";
      ctx.textAlign = "left";
      ctx.fillText(name, px + 7, py + 14);
    }

    if (hover) {
      const [hx, hy] = toScreen(...audio.xy[hover.i]!);
      ctx.globalAlpha = 1;
      ctx.strokeStyle = "#fafafa";
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(hx, hy, r + 3, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  };

  useEffect(() => redraw.current());

  // Glide to the focused song.
  useEffect(() => {
    const fi = focusId ? data.pos.get(focusId) : undefined;
    if (fi === undefined || !focusZoom) return;
    const [tx, ty] = audio.xy[fi]!;
    const from = { ...view.current };
    const start = performance.now();
    let frame = 0;
    const step = (now: number) => {
      const t = Math.min((now - start) / 450, 1);
      const e = 1 - (1 - t) ** 3;
      view.current = { k: from.k + (focusZoom - from.k) * e, cx: from.cx + (tx - from.cx) * e, cy: from.cy + (ty - from.cy) * e };
      redraw.current();
      if (t < 1) frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [focusId, focusZoom, audio, data]);

  // ---- interaction ----
  const drag = useRef<{ x: number; y: number; moved: number } | null>(null);

  const nearest = (sx: number, sy: number) => {
    let best = -1;
    let bestD = 64; // 8px radius, squared
    for (let i = 0; i < audio.ids.length; i++) {
      const [px, py] = toScreen(...audio.xy[i]!);
      const d = (px - sx) ** 2 + (py - sy) ** 2;
      if (d < bestD) [best, bestD] = [i, d];
    }
    return best;
  };

  const local = (e: { clientX: number; clientY: number }) => {
    const rect = canvasRef.current!.getBoundingClientRect();
    return [e.clientX - rect.left, e.clientY - rect.top] as const;
  };

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const [sx, sy] = local(e);
      const [dx, dy] = toData(sx, sy);
      const k = Math.min(Math.max(view.current.k * Math.exp(-e.deltaY * 0.0015), 0.6), 80);
      view.current = { k, cx: dx - (sx - width / 2) / (base * k), cy: dy - (sy - height / 2) / (base * k) };
      redraw.current();
    };
    canvas.addEventListener("wheel", onWheel, { passive: false });
    return () => canvas.removeEventListener("wheel", onWheel);
  });

  const hovered = hover ? audio.ids[hover.i] : undefined;
  const hoveredTrack = hovered ? lib.tracks[hovered] : undefined;

  return (
    <div ref={wrapRef} className="relative w-full select-none" style={{ height }}>
      <canvas
        ref={canvasRef}
        width={width * (window.devicePixelRatio || 1)}
        height={height * (window.devicePixelRatio || 1)}
        style={{ width, height }}
        className={drag.current ? "cursor-grabbing" : hover ? "cursor-pointer" : "cursor-grab"}
        onPointerDown={(e) => {
          drag.current = { x: e.clientX, y: e.clientY, moved: 0 };
          e.currentTarget.setPointerCapture(e.pointerId);
        }}
        onPointerMove={(e) => {
          const d = drag.current;
          if (d) {
            const dx = e.clientX - d.x, dy = e.clientY - d.y;
            d.moved += Math.abs(dx) + Math.abs(dy);
            [d.x, d.y] = [e.clientX, e.clientY];
            const { k } = view.current;
            view.current = { k, cx: view.current.cx - dx / (base * k), cy: view.current.cy - dy / (base * k) };
            redraw.current();
            return;
          }
          const [sx, sy] = local(e);
          const i = nearest(sx, sy);
          setHover(i >= 0 ? { i, x: sx, y: sy } : null);
        }}
        onPointerUp={(e) => {
          const d = drag.current;
          drag.current = null;
          if (d && d.moved < 4) {
            const i = nearest(...local(e));
            if (i >= 0) onSelect?.(audio.ids[i]!);
          }
        }}
        onPointerLeave={() => setHover(null)}
      />
      {hover && hoveredTrack && (
        <div
          className="pointer-events-none absolute z-10 max-w-64 rounded-lg border border-white/10 bg-zinc-900/95 px-3 py-2 text-xs shadow-xl"
          style={{ left: Math.min(hover.x + 14, width - 260), top: Math.min(hover.y + 14, height - 90) }}
        >
          <div className="font-semibold text-zinc-100">{hoveredTrack.name}</div>
          <div className="text-zinc-400">{hoveredTrack.artists.map((a) => a.name).join(", ")}</div>
          <div className="mt-1.5 flex flex-wrap gap-1">
            {data.playlistsOf[hover.i]!.length === 0 && <span className="text-zinc-500">Unsorted</span>}
            {data.playlistsOf[hover.i]!.slice(0, 5).map((p) => (
              <span key={p} className="rounded px-1.5 py-0.5 text-[10px] text-zinc-950" style={{ background: colors.get(p) }}>
                {data.names.get(p)}
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
