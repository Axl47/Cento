// The canvas behind every view of the library's sound: each song placed by how it sounds (2D layout of audio
// embeddings). One component, so anything added here works wherever a map is shown; a view only says what to show.
//
// The `scene` says what to show, and the camera glides to keep all of it on screen:
//   overview  everything; playlists are bubbles where their songs are densest, fading into songs as you zoom in
//   song      one song and its nearest songs, in their playlists' colors, connected and named; the rest gray
//   bridge    a route between two songs, in its own color with distinct ends; the rest gray
// Highlighting playlists colors only their songs, and focus lines then go to their closest songs. A marked song
// (hovered elsewhere on the page) gets a ring, a line from the focused song and its name, and joins the fit.
import { useEffect, useMemo, useRef, useState } from "react";
import { closestAmong, nearestSorted, NEAREST, neighborsFrom, type AudioIndex } from "../core/audio.ts";
import { clusters } from "../core/clusters.ts";
import { primaryPlaylists, sortTargets, type Library } from "../core/library.ts";
import { fitCamera, MIN_ZOOM, overlaps, placeLabel, type Box, type Camera, type Point } from "../core/mapLayout.ts";
import { useApp } from "./store.ts";

export type MapScene =
  | { kind: "overview" }
  | { kind: "song"; id: string }
  /** The songs of the route in order; one song means the route's end hasn't been chosen yet. */
  | { kind: "bridge"; ids: readonly string[] };

type Props = {
  audio: AudioIndex;
  lib: Library;
  colors: Map<string, string>;
  height: number;
  scene: MapScene;
  /** Playlists to emphasize; every other song turns gray, and focus lines only go to their songs. */
  highlight?: readonly string[];
  /** When set, only these songs are drawn and hoverable, and playlist bubbles (which summarize every song) are off. */
  only?: ReadonlySet<string> | null;
  /** Song to point out, e.g. one hovered in a list next to the map. */
  mark?: string | null;
  onSelect?: (trackId: string) => void;
};

const OVERVIEW: Camera = { k: 1, cx: 0, cy: 0 };
const GLIDE_MS = 400;
const GROUP_FADE_END = 2.6; // zoom where playlist bubbles have fully faded out
const LABEL_ZOOM = 7; // zoom where every song's name can show
const MAX_LABELS = 70;
const UNSORTED = "#71717a";
const BACKGROUND = "#221a28"; // zinc-900; the halo that keeps names legible over dots and lines
const NAME_HEIGHT = 14;
const PILL_HEIGHT = 22;
const FONT = { pill: "700 13px ui-sans-serif, system-ui", near: "600 12px ui-sans-serif, system-ui", rest: "11px ui-sans-serif, system-ui" };
export const BRIDGE_COLORS = { start: "#6ee7b7", end: "#f9a8d4", path: "#7dd3fc" };

export function SoundMap({ audio, lib, colors, height, scene, highlight = [], only = null, mark, onSelect }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const view = useRef<Camera>(OVERVIEW);
  const [width, setWidth] = useState(600);
  const [hover, setHover] = useState<{ i: number; x: number; y: number } | null>(null);
  const redraw = useRef<() => void>(() => {});
  const frame = useRef(0);
  /** Redraws on the next animation frame, once however many pointer/wheel events arrive before it. */
  const schedule = () => {
    frame.current ||= requestAnimationFrame(() => {
      frame.current = 0;
      redraw.current();
    });
  };

  const hidden = useApp((s) => s.hidden);
  const vectors = useApp((s) => s.vectors);
  // Per-point data, parallel to audio.ids. Hidden playlists get no bubble and don't color songs.
  const data = useMemo(() => {
    const targets = sortTargets(lib, hidden);

    const memberOf = new Map<string, string[]>();
    for (const p of targets) for (const id of p.trackIds) memberOf.set(id, [...(memberOf.get(id) ?? []), p.id]);
    const names = new Map(targets.map((p) => [p.id, p.name]));
    const playlistsOf = audio.ids.map((id) => memberOf.get(id) ?? []);

    const pointsOf = new Map<string, [number, number][]>();
    playlistsOf.forEach((ps, i) => {
      for (const p of ps) pointsOf.set(p, [...(pointsOf.get(p) ?? []), audio.xy[i]!]);
    });
    // Bubbles at each playlist's dense spots, sized by the songs there. Main spots come first so
    // their labels win collisions over secondary ones.
    const groups = [...pointsOf]
      .flatMap(([id, points]) => clusters(points).map((c, rank) => ({ id, name: names.get(id) ?? "", ...c, main: rank === 0 })))
      .sort((a, b) => +b.main - +a.main || b.n - a.n);

    return { playlistsOf, primary: primaryPlaylists(targets), groups, names, pos: new Map(audio.ids.map((id, i) => [id, i])) };
  }, [audio, lib, hidden]);

  // Song -> the first highlighted playlist it's in. Built from all playlists, so a hidden one still lights up.
  const lit = useMemo(() => {
    const m = new Map<string, string>();
    for (const id of highlight.toReversed())
      for (const t of lib.playlists.find((p) => p.id === id)?.trackIds ?? []) m.set(t, id);
    return m;
  }, [lib, highlight.join()]); // by content: callers pass fresh arrays

  const neighbors = useMemo(() => neighborsFrom(audio), [audio]);
  const focusId = scene.kind === "song" ? scene.id : null;
  // Songs the focus lines go to; while highlighting, the closest highlighted ones (exact once vectors load).
  const focusNear = useMemo(() => {
    if (!focusId) return [];
    const near =
      lit.size === 0
        ? nearestSorted(neighbors, data.primary, focusId)
        : vectors
          ? closestAmong(audio, vectors, focusId, lit.keys(), NEAREST)
          : neighbors(focusId).filter((n) => lit.has(n.id)).slice(0, NEAREST);
    return only ? near.filter((n) => only.has(n.id)) : near;
  }, [focusId, lit, neighbors, vectors, audio, data, only]);

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

  // Everything the scene needs on screen, and so where the camera belongs.
  const bridgeIds = scene.kind === "bridge" ? scene.ids : [];
  const subjects = focusId ? [focusId, ...focusNear.map((n) => n.id)] : bridgeIds.length > 1 ? bridgeIds : [];
  const subjectPoints = (subjects.length && mark ? [...subjects, mark] : subjects).flatMap((id): Point[] => {
    const i = data.pos.get(id);
    return i === undefined ? [] : [audio.xy[i]!];
  });
  const target = subjectPoints.length ? fitCamera(subjectPoints, [width, height], base) : OVERVIEW;

  // ---- drawing ----
  redraw.current = () => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    const dpr = window.devicePixelRatio || 1;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);

    const { k } = view.current;
    const overview = scene.kind === "overview";
    const groupAlpha = overview ? Math.min(Math.max((GROUP_FADE_END - k) / (GROUP_FADE_END - 1), 0), 1) : 0;
    const r = Math.min(Math.max(1.4 * Math.sqrt(k), only ? 3 : 1.6), 5); // a date range can leave few songs: keep them visible
    const highlighting = lit.size > 0 && scene.kind !== "bridge";
    // Anything but a plain overview grays the songs the story isn't about.
    const dimming = highlighting || !overview;
    const colorOf = (i: number) => {
      const id = audio.ids[i]!;
      const p = highlighting ? lit.get(id) : data.primary.get(id);
      return p ? (colors.get(p) ?? UNSORTED) : UNSORTED;
    };
    const at = (i: number) => toScreen(...audio.xy[i]!);
    const dot = (x: number, y: number, radius: number) => {
      ctx.beginPath();
      ctx.arc(x, y, radius, 0, Math.PI * 2);
      ctx.fill();
    };
    const ring = (x: number, y: number, radius: number) => {
      ctx.beginPath();
      ctx.arc(x, y, radius, 0, Math.PI * 2);
      ctx.stroke();
    };

    // Songs: gray ones first so bright songs draw on top. One path per color, so a frame
    // is a few dozen fills instead of one per song.
    const dotAlpha = only ? 0.9 : 0.3 + 0.6 * (1 - groupAlpha);
    for (const bright of dimming ? [false, true] : [true]) {
      const paths = new Map<string, Path2D>();
      const dr = highlighting && bright ? r + 1 : r;
      for (let i = 0; i < audio.ids.length; i++) {
        const id = audio.ids[i]!;
        if (only && !only.has(id)) continue;
        if (dimming && (highlighting && lit.has(id)) !== bright) continue;
        const [sx, sy] = at(i);
        if (sx < -10 || sy < -10 || sx > width + 10 || sy > height + 10) continue;
        const color = bright ? colorOf(i) : UNSORTED;
        let path = paths.get(color);
        if (!path) paths.set(color, (path = new Path2D()));
        path.moveTo(sx + dr, sy);
        path.arc(sx, sy, dr, 0, Math.PI * 2);
      }
      ctx.globalAlpha = !dimming ? dotAlpha : bright ? 0.95 : 0.18;
      for (const [color, path] of paths) {
        ctx.fillStyle = color;
        ctx.fill(path);
      }
    }

    // Playlist bubbles (zoomed out)
    if (groupAlpha > 0 && !only) {
      const taken: Box[] = [];
      ctx.font = "600 11px ui-sans-serif, system-ui";
      for (const g of data.groups) {
        if (highlighting && !highlight.includes(g.id)) continue;
        const [sx, sy] = toScreen(g.x, g.y);
        const radius = 3 + Math.sqrt(g.n) * 1.1;
        const color = colors.get(g.id) ?? UNSORTED;
        ctx.globalAlpha = (g.main ? 0.22 : 0.14) * groupAlpha;
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
        // Highlighted playlists keep their label through overlaps.
        if (overlaps(taken, box) && !highlight.includes(g.id)) continue;
        taken.push(box);
        ctx.globalAlpha = (g.main ? 1 : 0.6) * groupAlpha;
        ctx.textAlign = "center";
        ctx.lineJoin = "round";
        ctx.lineWidth = 3;
        ctx.strokeStyle = BACKGROUND;
        ctx.strokeText(g.name, sx, sy - radius - 5);
        ctx.fillStyle = "#fafafa";
        ctx.fillText(g.name, sx, sy - radius - 5);
      }
    }

    // Lines from the focused song to its neighbors
    const fi = focusId ? data.pos.get(focusId) : undefined;
    if (fi !== undefined) {
      const [fx, fy] = at(fi);
      for (const n of focusNear) {
        const ni = data.pos.get(n.id);
        if (ni === undefined) continue;
        const [nx, ny] = at(ni);
        ctx.globalAlpha = 0.25 + 0.6 * Math.max(n.sim, 0);
        ctx.strokeStyle = colorOf(ni);
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.moveTo(fx, fy);
        ctx.lineTo(nx, ny);
        ctx.stroke();
        ctx.fillStyle = colorOf(ni);
        dot(nx, ny, r + 1.5);
      }
      ctx.globalAlpha = 1;
      ctx.fillStyle = "#fafafa";
      dot(fx, fy, 5.5);
      ctx.strokeStyle = "#fafafa";
      ctx.lineWidth = 1.5;
      ctx.globalAlpha = 0.4;
      ring(fx, fy, 10);
    }

    // The bridge: one line through its songs, with ends that look different from each other.
    const route = bridgeIds.flatMap((id) => {
      const i = data.pos.get(id);
      return i === undefined ? [] : [i];
    });
    if (route.length > 0) {
      ctx.globalAlpha = 0.9;
      ctx.strokeStyle = BRIDGE_COLORS.path;
      ctx.lineWidth = 2;
      ctx.lineJoin = "round";
      ctx.beginPath();
      route.forEach((i, step) => (step ? ctx.lineTo(...at(i)) : ctx.moveTo(...at(i))));
      ctx.stroke();
      ctx.globalAlpha = 1;
      ctx.fillStyle = BRIDGE_COLORS.path;
      for (const i of route.slice(1, -1)) dot(...at(i), r + 1.5);
      const ends = route.length > 1 ? [[route[0]!, BRIDGE_COLORS.start], [route.at(-1)!, BRIDGE_COLORS.end]] as const : [[route[0]!, BRIDGE_COLORS.start]] as const;
      for (const [i, color] of ends) {
        ctx.fillStyle = color;
        ctx.strokeStyle = color;
        ctx.globalAlpha = 1;
        dot(...at(i), 6);
        ctx.lineWidth = 1.5;
        ctx.globalAlpha = 0.5;
        ring(...at(i), 11);
      }
    }

    // Song names: the scene's pills first, then its songs, then everyone else's (zoomed in, dimmer).
    // Each one is placed to fit fully inside the canvas, and the scene's dots are kept clear of names.
    const marked = mark ? data.pos.get(mark) : undefined;
    const taken: Box[] = [];
    for (const id of subjects) {
      const i = data.pos.get(id);
      if (i === undefined) continue;
      const [sx, sy] = at(i);
      taken.push([sx - r - 3, sy - r - 3, 2 * r + 6, 2 * r + 6]);
    }
    /** The song's name, cut short only if it's wider than the whole canvas. */
    const nameOf = (i: number) => {
      const name = lib.tracks[audio.ids[i]!]?.name ?? "";
      const room = width - 32;
      if (ctx.measureText(name).width <= room) return name;
      let cut = name;
      while (cut.length > 1 && ctx.measureText(`${cut}…`).width > room) cut = cut.slice(0, -1);
      return `${cut}…`;
    };
    /** A name displaced from its song gets a thin line back to it. */
    const leader = (i: number, [bx, by, bw, bh]: Box, color: string) => {
      const [sx, sy] = at(i);
      const [ex, ey] = [Math.max(bx, Math.min(sx, bx + bw)), Math.max(by, Math.min(sy, by + bh))];
      if (Math.hypot(ex - sx, ey - sy) < r + 14) return;
      ctx.globalAlpha = 0.4;
      ctx.strokeStyle = color;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(sx, sy);
      ctx.lineTo(ex, ey);
      ctx.stroke();
    };
    const label = (i: number, font: string, color: string, alpha: number, mustShow: boolean) => {
      const point = at(i);
      if (point[0] < 0 || point[1] < 0 || point[0] > width || point[1] > height) return;
      ctx.font = font;
      const name = nameOf(i);
      const box = placeLabel(point, [ctx.measureText(name).width + 4, NAME_HEIGHT], r + 3, [width, height], taken, mustShow);
      if (!box) return;
      taken.push(box);
      leader(i, box, color);
      ctx.globalAlpha = alpha;
      ctx.lineWidth = 3;
      ctx.strokeStyle = BACKGROUND;
      ctx.strokeText(name, box[0] + 2, box[1] + 11);
      ctx.fillStyle = color;
      ctx.fillText(name, box[0] + 2, box[1] + 11);
    };
    /** Places a pill now so names steer around it; it's drawn after them, on top. */
    const pill = (i: number, font: string, fill: string, text: string) => {
      ctx.font = font;
      const name = nameOf(i);
      const box = placeLabel(at(i), [ctx.measureText(name).width + 14, PILL_HEIGHT], 14, [width, height], taken, true)!;
      taken.push(box);
      return () => {
        leader(i, box, fill.slice(0, 7));
        ctx.globalAlpha = 1;
        ctx.font = font;
        ctx.fillStyle = fill;
        ctx.beginPath();
        ctx.roundRect(box[0], box[1], box[2], PILL_HEIGHT, 6);
        ctx.fill();
        ctx.fillStyle = text;
        ctx.fillText(name, box[0] + 7, box[1] + 15);
      };
    };

    ctx.textAlign = "left";
    ctx.lineJoin = "round";
    const named = new Set<number>([...(fi !== undefined ? [fi] : []), ...route, ...(marked !== undefined ? [marked] : [])]);
    const pills = [
      ...(fi !== undefined ? [pill(fi, FONT.pill, "#f2ebe3", "#17111b")] : []),
      ...(route.length > 0 ? [pill(route[0]!, FONT.pill, BRIDGE_COLORS.start, "#17111b")] : []),
      ...(route.length > 1 ? [pill(route.at(-1)!, FONT.pill, BRIDGE_COLORS.end, "#17111b")] : []),
      ...(marked !== undefined && marked !== fi && !(marked === route[0] || marked === route.at(-1)) ? [pill(marked, FONT.near, "#17111bee", "#f7f2ec")] : []),
    ];
    for (const n of focusNear) {
      const i = data.pos.get(n.id);
      if (i === undefined || named.has(i)) continue;
      named.add(i);
      label(i, FONT.near, colorOf(i), 1, true);
    }
    for (const i of route.slice(1, -1)) if (i !== marked) label(i, FONT.near, BRIDGE_COLORS.path, 1, true);
    if (k >= LABEL_ZOOM) {
      const alpha = Math.min((k - LABEL_ZOOM) / 3 + 0.45, 0.75);
      const rest = (i: number) => {
        if (taken.length < MAX_LABELS + subjects.length && !named.has(i)) label(i, FONT.rest, "#c2b6c9", alpha, false);
      };
      if (highlighting) for (let i = 0; i < audio.ids.length; i++) if (lit.has(audio.ids[i]!)) rest(i);
      for (let i = 0; i < audio.ids.length; i++) rest(i);
    }

    // The marked song: a ring, and a dashed line from the focused song to show how far apart they are.
    if (marked !== undefined) {
      const [mx, my] = at(marked);
      ctx.globalAlpha = 0.8;
      ctx.strokeStyle = "#f2ebe3";
      ctx.lineWidth = 1.5;
      if (fi !== undefined && marked !== fi) {
        const [fx, fy] = at(fi);
        ctx.setLineDash([4, 4]);
        ctx.beginPath();
        ctx.moveTo(fx, fy);
        ctx.lineTo(mx, my);
        ctx.stroke();
        ctx.setLineDash([]);
      }
      ctx.globalAlpha = 1;
      ctx.fillStyle = colorOf(marked);
      dot(mx, my, r + 2.5);
      ctx.lineWidth = 2;
      ring(mx, my, r + 6);
    }

    for (const draw of pills) draw();

    if (hover) {
      const [hx, hy] = at(hover.i);
      ctx.globalAlpha = 1;
      ctx.strokeStyle = "#fafafa";
      ctx.lineWidth = 1.5;
      ring(hx, hy, r + 3);
    }
    ctx.globalAlpha = 1;
  };

  useEffect(() => redraw.current());

  // Glide to wherever the scene needs the camera. Keyed on the destination, so a hover that needs no move doesn't undo your panning.
  const glide = useRef(0);
  useEffect(() => {
    const from = { ...view.current };
    const start = performance.now();
    const step = (now: number) => {
      const t = Math.min((now - start) / GLIDE_MS, 1);
      const e = 1 - (1 - t) ** 3;
      view.current = { k: from.k + (target.k - from.k) * e, cx: from.cx + (target.cx - from.cx) * e, cy: from.cy + (target.cy - from.cy) * e };
      redraw.current();
      glide.current = t < 1 ? requestAnimationFrame(step) : 0;
    };
    cancelAnimationFrame(glide.current);
    glide.current = requestAnimationFrame(step);
    return () => cancelAnimationFrame(glide.current);
  }, [target.k, target.cx, target.cy]);

  // ---- interaction ----
  const drag = useRef<{ x: number; y: number; moved: number } | null>(null);

  const nearest = (sx: number, sy: number) => {
    let best = -1;
    let bestD = 64; // 8px radius, squared
    for (let i = 0; i < audio.ids.length; i++) {
      if (only && !only.has(audio.ids[i]!)) continue;
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
      cancelAnimationFrame(glide.current);
      const [sx, sy] = local(e);
      const [dx, dy] = toData(sx, sy);
      const k = Math.min(Math.max(view.current.k * Math.exp(-e.deltaY * 0.0015), MIN_ZOOM), 80);
      view.current = { k, cx: dx - (sx - width / 2) / (base * k), cy: dy - (sy - height / 2) / (base * k) };
      schedule();
    };
    canvas.addEventListener("wheel", onWheel, { passive: false });
    return () => canvas.removeEventListener("wheel", onWheel);
  });

  const hovered = hover ? audio.ids[hover.i] : undefined;
  const hoveredTrack = hovered ? lib.tracks[hovered] : undefined;

  return (
    <div ref={wrapRef} className="relative w-full select-none overflow-hidden rounded-lg bg-zinc-900" style={{ height }}>
      <canvas
        ref={canvasRef}
        width={width * (window.devicePixelRatio || 1)}
        height={height * (window.devicePixelRatio || 1)}
        style={{ width, height }}
        className={drag.current ? "cursor-grabbing" : hover ? "cursor-pointer" : bridgeIds.length === 1 ? "cursor-crosshair" : "cursor-grab"}
        onPointerDown={(e) => {
          cancelAnimationFrame(glide.current);
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
            schedule();
            return;
          }
          const [sx, sy] = local(e);
          const i = nearest(sx, sy);
          // Re-render only when the hovered song changes, not on every pixel of movement.
          if (i !== (hover?.i ?? -1)) setHover(i >= 0 ? { i, x: sx, y: sy } : null);
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
