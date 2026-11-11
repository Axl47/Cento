// The canvas behind every view of the library's sound: each song placed by how it sounds (2D layout of audio
// embeddings). One component, so anything added here works wherever a map is shown; a view only says what to show.
//
// The `scene` says what to show, and the camera glides to keep all of it on screen:
//   overview  everything, with the names of the areas each playlist leads while zoomed out
//   song      one song and its nearest songs, in their playlists' colors, connected and named; the rest gray
//   bridge    a route between two songs, in its own color with distinct ends; the rest gray
// Highlighting playlists colors only their songs, and focus lines then go to their closest songs. Clicking empty map
// in a song scene releases that: the song's nearest songs show, undimmed. Any interaction with the song (hovering
// its dot) or with the page around the map (the song's info, the lists below the map) brings the highlight back. A marked song
// (hovered elsewhere on the page) gets a ring, a line from the focused song and its name, and joins the fit.
// Under every scene, hex tiles tint each area by the playlist most of its songs are in (not counting uncounted or artist playlists); a corner panel says
// which playlists the songs of the tile under the pointer are in, alongside any hovered song's own tooltip.
import { useEffect, useMemo, useRef, useState } from "react";
import { closestAmong, nearestSorted, NEAREST, neighborsFrom, type AudioIndex } from "../core/audio.ts";
import { regions, tileKeyAt, tileUp } from "../core/hexTiles.ts";
import { isArtistPlaylist, primaryPlaylists, sortTargets, type Library } from "../core/library.ts";
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
  /** When set, only these songs are drawn, hoverable and counted in the tiles. */
  only?: ReadonlySet<string> | null;
  /** Song to point out, e.g. one hovered in a list next to the map. */
  mark?: string | null;
  onSelect?: (trackId: string) => void;
};

const OVERVIEW: Camera = { k: 1, cx: 0, cy: 0 };
const GLIDE_MS = 400;
const REGION_FADE_END = 2.6; // zoom where area names have fully faded out
const TILE = 0.04; // tile size (center to corner) in layout units, which span about [-1, 1]
const MIN_REGION_SONGS = 12; // smaller areas go unnamed
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
  /** The tile under the pointer, and whether the pointer is in the corner its panel normally takes. */
  /** The song scene + highlight a click on empty map released; released only while both stay as they were. */
  const [releasedFor, setReleasedFor] = useState<string | null>(null);
  const [area, setArea] = useState<{ key: string; corner: boolean } | null>(null);
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
  const uncounted = useApp((s) => s.uncounted);
  const vectors = useApp((s) => s.vectors);
  // Per-point data, parallel to audio.ids. Hidden playlists don't color songs.
  const data = useMemo(() => {
    const targets = sortTargets(lib, hidden);
    const memberOf = new Map<string, string[]>();
    for (const p of targets) for (const id of p.trackIds) memberOf.set(id, [...(memberOf.get(id) ?? []), p.id]);
    return {
      playlistsOf: audio.ids.map((id) => memberOf.get(id) ?? []),
      primary: primaryPlaylists(targets),
      names: new Map(targets.map((p) => [p.id, p.name])),
      pos: new Map(audio.ids.map((id, i) => [id, i])),
    };
  }, [audio, lib, hidden]);

  // What tiles are made of: playlists that count as sorted and aren't one artist's catch-all, so a tile shows the
  // sound its songs share rather than who made them.
  const tileData = useMemo(() => {
    const targets = sortTargets(lib, [...hidden, ...uncounted]).filter((p) => !isArtistPlaylist(lib, p));
    const memberOf = new Map<string, string[]>();
    for (const p of targets) for (const id of p.trackIds) memberOf.set(id, [...(memberOf.get(id) ?? []), p.id]);
    return { playlistsOf: audio.ids.map((id) => memberOf.get(id) ?? []), primary: primaryPlaylists(targets) };
  }, [audio, lib, hidden, uncounted]);

  // Tiles of the drawn songs, each led by the playlist most of its songs are in, and the areas they form.
  const tiled = useMemo(() => {
    const tiles = tileUp(audio.xy, TILE, (i) => tileData.primary.get(audio.ids[i]!) ?? null, only ? (i) => only.has(audio.ids[i]!) : undefined);
    return { tiles, regions: regions(tiles, TILE).filter((r) => r.songs >= MIN_REGION_SONGS) };
  }, [audio, tileData, only]);

  // Song -> the first highlighted playlist it's in. Built from all playlists, so a hidden one still lights up.
  const lit = useMemo(() => {
    const m = new Map<string, string>();
    for (const id of highlight.toReversed())
      for (const t of lib.playlists.find((p) => p.id === id)?.trackIds ?? []) m.set(t, id);
    return m;
  }, [lib, highlight.join()]); // by content: callers pass fresh arrays

  const neighbors = useMemo(() => neighborsFrom(audio), [audio]);
  const focusId = scene.kind === "song" ? scene.id : null;
  const released = focusId !== null && releasedFor === `${focusId}|${highlight.join()}`;
  // Songs the focus lines go to; while highlighting, the closest highlighted ones (exact once vectors load).
  const focusNear = useMemo(() => {
    if (!focusId) return [];
    const near =
      lit.size === 0 || released
        ? nearestSorted(neighbors, data.primary, focusId)
        : vectors
          ? closestAmong(audio, vectors, focusId, lit.keys(), NEAREST)
          : neighbors(focusId).filter((n) => lit.has(n.id)).slice(0, NEAREST);
    return only ? near.filter((n) => only.has(n.id)) : near;
  }, [focusId, lit, released, neighbors, vectors, audio, data, only]);

  // A release ends when the pointer reaches anything but the map, or a song elsewhere on the page is marked.
  useEffect(() => {
    if (!released) return;
    const onOver = (e: PointerEvent) => {
      if (!(e.target instanceof Node && wrapRef.current?.contains(e.target))) setReleasedFor(null);
    };
    document.addEventListener("pointerover", onOver);
    return () => document.removeEventListener("pointerover", onOver);
  }, [released]);
  useEffect(() => {
    if (mark) setReleasedFor(null);
  }, [mark]);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setWidth(Math.max(200, Math.floor(e!.contentRect.width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const base = Math.min(width, height) / 2 * 0.9;
  /** A song's dot radius in pixels at the current zoom; a date range can leave few songs, so keep them visible. */
  const dotRadius = () => Math.min(Math.max(1.4 * Math.sqrt(view.current.k), only ? 3 : 1.6), 5);
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

  const hoveredTile = area ? tiled.tiles.get(area.key) : undefined;

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
    const regionAlpha = overview ? Math.min(Math.max((REGION_FADE_END - k) / (REGION_FADE_END - 1), 0), 1) : 0;
    const r = dotRadius();
    // A released song scene shows plainly until something interacts with it again.
    const highlighting = lit.size > 0 && scene.kind !== "bridge" && !released;
    // Anything but a plain overview grays the songs the story isn't about.
    const dimming = highlighting || (!overview && !released);
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

    // Tiles, under everything: a tint as strong as the tile's lead is clear and its songs many. The hovered one is outlined.
    const corner = TILE * base * k;
    const hex = (sx: number, sy: number, size: number) => {
      ctx.beginPath();
      for (let a = 0; a < 6; a++) {
        const angle = (Math.PI / 3) * a - Math.PI / 6;
        ctx[a ? "lineTo" : "moveTo"](sx + size * Math.cos(angle), sy + size * Math.sin(angle));
      }
      ctx.closePath();
    };
    for (const tile of tiled.tiles.values()) {
      const [sx, sy] = toScreen(tile.x, tile.y);
      if (sx < -corner || sy < -corner || sx > width + corner || sy > height + corner) continue;
      const strength = tile.share * Math.min(tile.songs.length / 8, 1);
      ctx.globalAlpha = (0.07 + 0.33 * strength) * (dimming ? 0.5 : 1);
      ctx.fillStyle = tile.top ? (colors.get(tile.top) ?? UNSORTED) : UNSORTED;
      hex(sx, sy, corner * 0.94);
      ctx.fill();
    }
    if (hoveredTile) {
      ctx.globalAlpha = 0.7;
      ctx.strokeStyle = hoveredTile.top ? (colors.get(hoveredTile.top) ?? UNSORTED) : UNSORTED;
      ctx.lineWidth = 1.5;
      hex(...toScreen(hoveredTile.x, hoveredTile.y), corner * 0.94);
      ctx.stroke();
    }

    // Songs: gray ones first so bright songs draw on top. One path per color, so a frame
    // is a few dozen fills instead of one per song.
    const dotAlpha = only ? 0.9 : 0.7;
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

    // Names of the areas playlists lead (zoomed out), biggest first; highlighted playlists keep theirs through overlaps.
    // Each playlist is named once, on its biggest area; its other areas are still tinted.
    if (regionAlpha > 0) {
      const taken: Box[] = [];
      const named = new Set<string>();
      ctx.font = "600 11px ui-sans-serif, system-ui";
      ctx.textAlign = "center";
      ctx.lineJoin = "round";
      for (const region of tiled.regions) {
        if (highlighting && !highlight.includes(region.group)) continue;
        if (named.has(region.group)) continue;
        named.add(region.group);
        const name = data.names.get(region.group) ?? "";
        const [sx, sy] = toScreen(region.x, region.y);
        const w = ctx.measureText(name).width;
        const box: Box = [sx - w / 2 - 3, sy - 8, w + 6, 14];
        if (overlaps(taken, box) && !highlight.includes(region.group)) continue;
        taken.push(box);
        ctx.globalAlpha = regionAlpha;
        ctx.lineWidth = 3;
        ctx.strokeStyle = BACKGROUND;
        ctx.strokeText(name, sx, sy + 4);
        ctx.fillStyle = "#fafafa";
        ctx.fillText(name, sx, sy + 4);
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
    // Zoomed out, songs are small and close together: a tighter reach leaves the tiles between them hoverable.
    let best = -1;
    let bestD = Math.min(Math.max(dotRadius() + 3, 5), 8) ** 2;
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

  const hoveredTrack = hover ? lib.tracks[audio.ids[hover.i]!] : undefined;
  // The hovered tile's playlists, by the share of its songs in each (a song can be in several, so they overlap).
  const tileShares = (() => {
    if (!hoveredTile) return [];
    const counts = new Map<string, number>();
    for (const i of hoveredTile.songs) for (const p of tileData.playlistsOf[i]!) counts.set(p, (counts.get(p) ?? 0) + 1);
    return [...counts].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([id, n]) => ({ id, share: n / hoveredTile.songs.length }));
  })();

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
          // Re-render only when the hovered song or tile changes, not on every pixel of movement.
          const i = nearest(sx, sy);
          if (i !== (hover?.i ?? -1)) setHover(i >= 0 ? { i, x: sx, y: sy } : null);
          // The song itself (or a copy right under its dot) brings the highlight back.
          const fi = focusId ? data.pos.get(focusId) : undefined;
          if (released && i >= 0 && fi !== undefined) {
            const [fx, fy] = toScreen(...audio.xy[fi]!);
            const [hx, hy] = toScreen(...audio.xy[i]!);
            if (Math.hypot(fx - hx, fy - hy) < 6) setReleasedFor(null);
          }
          const key = tileKeyAt(toData(sx, sy), TILE);
          const next = tiled.tiles.has(key) ? { key, corner: sx < 260 && sy < 180 } : null;
          if (next?.key !== area?.key || next?.corner !== area?.corner) setArea(next);
        }}
        onPointerUp={(e) => {
          const d = drag.current;
          drag.current = null;
          if (d && d.moved < 4) {
            const i = nearest(...local(e));
            if (i >= 0) onSelect?.(audio.ids[i]!);
            else if (focusId) setReleasedFor(`${focusId}|${highlight.join()}`);
          }
        }}
        onPointerLeave={() => (setHover(null), setArea(null))}
      />
      {area && hoveredTile && (
        <div
          className={`pointer-events-none absolute top-2 z-10 w-56 rounded-lg border border-white/10 bg-zinc-900/90 px-3 py-2 text-xs shadow-xl ${area.corner ? "right-2" : "left-2"}`}
        >
          <div className="mb-1.5 text-zinc-400">{hoveredTile.songs.length === 1 ? "1 song" : `${hoveredTile.songs.length} songs`}</div>
          {tileShares.length === 0 && <div className="text-zinc-500">Unsorted</div>}
          {tileShares.map(({ id, share }) => (
            <div key={id} className="mt-1">
              <div className="flex justify-between gap-2">
                <span className="truncate text-zinc-200">{data.names.get(id)}</span>
                <span className="tabular-nums text-zinc-400">{Math.round(share * 100)}%</span>
              </div>
              <div className="mt-0.5 h-1 rounded-full bg-white/5">
                <div className="h-full rounded-full" style={{ width: `${share * 100}%`, background: colors.get(id) ?? UNSORTED }} />
              </div>
            </div>
          ))}
        </div>
      )}
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
