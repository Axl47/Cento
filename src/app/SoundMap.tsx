// The canvas behind every view of the library's sound: each song placed by how it sounds (2D layout of audio
// embeddings). One component, so anything added here works wherever a map is shown; a view only says what to show.
//
// The `scene` says what to show, and the camera glides to keep all of it on screen:
//   overview  everything, with the names of the areas each playlist leads while zoomed out
//   song      one song and its nearest songs, in their playlists' colors, connected and named; the rest gray
//   bridge    a route between two songs, in its own color with distinct ends; the rest gray
//   set       a set being built (Build tab), drawn like a bridge: rough handoffs dashed red, songs that don't fit
//             ringed red, and suggestions as dashed rings
// Highlighting playlists colors only their songs, and focus lines then go to their closest songs. Clicking empty map
// in a song scene releases that: the song's nearest songs show, undimmed. Any interaction with the song (hovering
// its dot) or with the page around the map (the song's info, the lists below the map) brings the highlight back. A marked song
// (hovered elsewhere on the page) gets a ring, a line from the focused song and its name, and joins the fit.
// Unless the Compilations setting is on, uncounted and artist playlists color no songs and tint no tiles.
// Under every scene, hex tiles tint each area by the playlist most of its songs are colored by; a corner panel says
// which playlists the songs of the tile under the pointer are in, alongside any hovered song's own tooltip.
// A `colorable` map (the Sound map tab) can instead color songs, tiles and area names by a category (mood, tempo,
// genre or era, see core/colorBy.ts), chosen under Color by in the gear menu, with a legend in the bottom-left corner.
import { useEffect, useMemo, useRef, useState } from "react";
import { categorize, COLOR_BY, type CategoryMode } from "../core/colorBy.ts";
import { closestAmong, nearestSorted, NEAREST, neighborsFrom, type AudioIndex } from "../core/audio.ts";
import { regions, tileKeyAt, tileUp } from "../core/hexTiles.ts";
import { isArtistPlaylist, primaryPlaylists, sortTargets, type Library } from "../core/library.ts";
import { fitCamera, MIN_ZOOM, overlaps, placeLabel, revealZooms, type Box, type Camera, type NameCandidate, type Point, type Size } from "../core/mapLayout.ts";
import { useMapSettings } from "./mapSettings.ts";
import { useApp } from "./store.ts";
import { useTitle } from "./useTitle.ts";

export type MapScene =
  | { kind: "overview" }
  | { kind: "song"; id: string }
  /** The songs of the route in order; one song means the route's end hasn't been chosen yet. */
  | { kind: "bridge"; ids: readonly string[] }
  | {
      kind: "set";
      /** The set's songs on the map, in order. */
      ids: readonly string[];
      /** Songs whose handoff to the next one is rough. */
      rough: ReadonlySet<string>;
      ringed: readonly string[];
      dashed: readonly string[];
    };

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
  /** Offer Color by in the gear menu and follow it; without it, the map always colors by playlist. */
  colorable?: boolean;
};

const OVERVIEW: Camera = { k: 1, cx: 0, cy: 0 };
const GLIDE_MS = 400;
const REGION_FADE_END = 2.6; // zoom where area names have fully faded out
const TILE = 0.04; // tile size (center to corner) in layout units, which span about [-1, 1]
const MIN_REGION_SONGS = 12; // smaller areas go unnamed
const NAME_ZOOM = 6; // zoom highlighted songs and each tile's lead song can be named from
const NAME_FILL = 0.5; // how fast the rest of a tile follows: its nth song can be named from NAME_ZOOM·√(1 + n·NAME_FILL)
const NAME_ROOM = [16, 24] as const; // clear space after a background name, and the height it takes with spacing
const CENTER_BIAS = 0.5; // how much later a name appears a screen's diagonal away from the center (or the focused song)
const NAME_FADE = 0.2; // share of its appear zoom over which a name fades in
const EDGE_FADE = 28; // pixels from the canvas edge over which background names fade out
const SPOT_RADIUS = 110; // pixels around the pointer whose songs are named early, fully within half of it
const UNSORTED = "#71717a";
const BACKGROUND = "#221a28"; // zinc-900; the halo that keeps names legible over dots and lines
const NAME_HEIGHT = 14;
const PILL_HEIGHT = 22;
const FONT = { pill: "700 13px ui-sans-serif, system-ui", near: "600 12px ui-sans-serif, system-ui", rest: "11px ui-sans-serif, system-ui" };
export const BRIDGE_COLORS = { start: "#6ee7b7", end: "#f9a8d4", path: "#7dd3fc" };
const BAD = "#ff8f7a";
/** Category colors, in each mode's legend order; tempo and era run cool to warm (slow to fast, old to new). */
const CATEGORY_COLORS: Record<CategoryMode, readonly string[]> = {
  mood: ["#f87171", "#2dd4bf", "#60a5fa", "#f472b6", "#fbbf24", "#a78bfa"],
  tempo: ["#60a5fa", "#c084fc", "#fb923c"],
  genre: ["#f87171", "#22d3ee", "#facc15", "#a78bfa", "#34d399", "#f472b6", "#fb923c", "#60a5fa", "#a3e635", "#d6a77a"],
  era: ["#60a5fa", "#a78bfa", "#f472b6", "#fb923c"],
};

export function SoundMap({ audio, lib, colors, height, scene, highlight = [], only = null, mark, onSelect, colorable = false }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const view = useRef<Camera>(OVERVIEW);
  const [width, setWidth] = useState(600);
  const [hover, setHover] = useState<{ i: number; x: number; y: number } | null>(null);
  /** The tile under the pointer, and whether the pointer is in the corner its panel normally takes. */
  /** The song scene + highlight a click on empty map released; released only while both stay as they were. */
  const [releasedFor, setReleasedFor] = useState<string | null>(null);
  const [area, setArea] = useState<{ key: string; corner: boolean } | null>(null);
  /** Where each name sat last frame ("n<i>" for names, "p<i>" for pills), so names hold still as the camera moves. */
  const lastSpots = useRef(new Map<string, string>());
  /** The pointer on the canvas, in canvas pixels; songs around it are named early. */
  const pointer = useRef<Point | null>(null);
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
  const compilations = useMapSettings((s) => s.compilations);
  const setCompilations = useMapSettings((s) => s.setCompilations);
  const savedColorBy = useMapSettings((s) => s.colorBy);
  const setColorBy = useMapSettings((s) => s.setColorBy);
  const tags = useApp((s) => s.tags);
  const features = useApp((s) => s.features);
  const title = useTitle();
  /** The `i`th mapped song's name with its plays. */
  const songName = (i: number) => {
    const t = lib.tracks[audio.ids[i]!];
    return t ? title(t.id, t.name) : "";
  };
  const [menu, setMenu] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  // Per-point data, parallel to audio.ids. Hidden playlists never color songs; unless compilations are on, neither
  // do uncounted ones or ones named after their own artist, so songs and tiles show a shared sound, not who made them.
  const data = useMemo(() => {
    const targets = compilations
      ? sortTargets(lib, hidden)
      : sortTargets(lib, [...hidden, ...uncounted]).filter((p) => !isArtistPlaylist(lib, p));
    const memberOf = new Map<string, string[]>();
    for (const p of targets) for (const id of p.trackIds) memberOf.set(id, [...(memberOf.get(id) ?? []), p.id]);
    return {
      playlistsOf: audio.ids.map((id) => memberOf.get(id) ?? []),
      primary: primaryPlaylists(targets),
      names: new Map(targets.map((p) => [p.id, p.name])),
      pos: new Map(audio.ids.map((id, i) => [id, i])),
    };
  }, [audio, lib, hidden, uncounted, compilations]);

  useEffect(() => {
    if (!colorable) return;
    useApp.getState().loadTags();
    useApp.getState().loadFeatures();
  }, [colorable]);
  // Color by modes whose data is here; a saved mode whose data isn't falls back to playlists.
  const offered = useMemo(() => {
    if (!colorable) return [];
    const hasYears = audio.ids.some((id) => lib.tracks[id]?.year);
    return COLOR_BY.filter((m) => (m === "mood" || m === "genre" ? !!tags : m === "tempo" ? !!features : m === "era" ? hasYears : true));
  }, [colorable, audio, lib, tags, features]);
  const colorBy = offered.includes(savedColorBy) ? savedColorBy : "playlist";

  // What colors songs, tiles and area names: per song its leading group (a playlist, or its category), each group's
  // name and color, and every group a song is in (for the tile panel). Categories are drawn as if they were playlists.
  const paint = useMemo(() => {
    if (colorBy === "playlist") return { lead: data.primary, names: data.names, colors, groupsOf: data.playlistsOf, legend: [] };
    const { categories, of } = categorize(colorBy, audio.ids, (id) => ({ tags: tags?.get(id), features: features?.get(id), year: lib.tracks[id]?.year }));
    const palette = CATEGORY_COLORS[colorBy];
    return {
      lead: of,
      names: new Map(categories.map((c) => [c, c])),
      colors: new Map(categories.map((c, i) => [c, palette[i % palette.length]!])),
      groupsOf: audio.ids.map((id) => {
        const c = of.get(id);
        return c ? [c] : [];
      }),
      legend: categories,
    };
  }, [colorBy, data, colors, audio, lib, tags, features]);

  // Tiles of the drawn songs, each led by the playlist (or category) most of its songs are colored by, and the areas they form.
  const tiled = useMemo(() => {
    const tiles = tileUp(audio.xy, TILE, (i) => paint.lead.get(audio.ids[i]!) ?? null, only ? (i) => only.has(audio.ids[i]!) : undefined);
    return { tiles, regions: regions(tiles, TILE).filter((r) => r.songs >= MIN_REGION_SONGS) };
  }, [audio, paint, only]);

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
  // A released song scene shows plainly until something interacts with it again.
  const highlighting = lit.size > 0 && scene.kind !== "bridge" && scene.kind !== "set" && !released;
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

  useEffect(() => {
    if (!menu) return;
    const close = (e: PointerEvent) => {
      if (!(e.target instanceof Node && menuRef.current?.contains(e.target))) setMenu(false);
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [menu]);

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
  // Background names, most important first, each with the zoom it appears at. Highlighted songs lead, then each
  // tile's lead song (nearest its middle among the tile's leading playlist), then the rest of each tile from its
  // middle out, taking turns between tiles so every tile fills at the same pace.
  const backgroundNames = useMemo(() => {
    const measure = document.createElement("canvas").getContext("2d")!;
    measure.font = FONT.rest;
    const ranked: { i: number; tier: number; turn: number }[] = [];
    for (const tile of tiled.tiles.values()) {
      const fromMiddle = (i: number) => Math.hypot(audio.xy[i]![0] - tile.x, audio.xy[i]![1] - tile.y);
      const byMiddle = tile.songs.toSorted((a, b) => fromMiddle(a) - fromMiddle(b));
      const lead = byMiddle.find((i) => paint.lead.get(audio.ids[i]!) === tile.top) ?? byMiddle[0]!;
      [lead, ...byMiddle.filter((i) => i !== lead)].forEach((i, turn) => {
        const tier = highlighting && lit.has(audio.ids[i]!) ? 0 : turn === 0 ? 1 : 2;
        ranked.push({ i, tier, turn });
      });
    }
    ranked.sort((a, b) => a.tier - b.tier || a.turn - b.turn);
    // A tile's names grow with its area on screen, which grows with the square of zoom.
    const candidates = ranked.map(({ i, tier, turn }): NameCandidate => ({
      point: audio.xy[i]!,
      width: measure.measureText(songName(i)).width + 4,
      floor: tier < 2 ? NAME_ZOOM : NAME_ZOOM * Math.sqrt(1 + turn * NAME_FILL),
    }));
    const zooms = revealZooms(candidates, base, NAME_ROOM);
    return ranked.map(({ i }, n) => ({ i, zoom: zooms[n]!, width: candidates[n]!.width }));
  }, [tiled, paint, audio, lib, lit, highlighting, base, title]);

  const toScreen = (x: number, y: number): [number, number] => {
    const { k, cx, cy } = view.current;
    return [(x - cx) * base * k + width / 2, (y - cy) * base * k + height / 2];
  };
  const toData = (sx: number, sy: number): [number, number] => {
    const { k, cx, cy } = view.current;
    return [(sx - width / 2) / (base * k) + cx, (sy - height / 2) / (base * k) + cy];
  };

  // Everything the scene needs on screen, and so where the camera belongs.
  const bridgeIds = scene.kind === "bridge" || scene.kind === "set" ? scene.ids : [];
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
    /** 1 at overview zoom, easing to 0 by the zoom where songs take over. */
    const zoomedOut = Math.min(Math.max((REGION_FADE_END - k) / (REGION_FADE_END - 1), 0), 1);
    const regionAlpha = overview ? zoomedOut : 0;
    const r = dotRadius();
    // Anything but a plain overview grays the songs the story isn't about.
    const dimming = highlighting || (!overview && !released);
    // Highlighted songs take their highlighted playlist's color, unless the map is colored by category.
    const colorOf = (i: number) => {
      const id = audio.ids[i]!;
      const p = highlighting && colorBy === "playlist" ? lit.get(id) : paint.lead.get(id);
      return p ? (paint.colors.get(p) ?? UNSORTED) : UNSORTED;
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

    // Tiles, under everything: a tint as strong as the tile's lead is clear and its songs many, and stronger zoomed out,
    // where they summarize the most. The hovered one is outlined.
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
      ctx.globalAlpha = (0.07 + 0.33 * strength) * (1 + 0.6 * zoomedOut) * (dimming ? 0.5 : 1);
      ctx.fillStyle = tile.top ? (paint.colors.get(tile.top) ?? UNSORTED) : UNSORTED;
      hex(sx, sy, corner * 0.94);
      ctx.fill();
    }
    if (hoveredTile) {
      ctx.globalAlpha = 0.7;
      ctx.strokeStyle = hoveredTile.top ? (paint.colors.get(hoveredTile.top) ?? UNSORTED) : UNSORTED;
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

    // Names of the areas playlists (or categories) lead (zoomed out), biggest first; highlighted playlists keep theirs
    // through overlaps. Each is named once, on its biggest area; its other areas are still tinted.
    if (regionAlpha > 0) {
      const taken: Box[] = [];
      const named = new Set<string>();
      ctx.font = "600 11px ui-sans-serif, system-ui";
      ctx.textAlign = "center";
      ctx.lineJoin = "round";
      for (const region of tiled.regions) {
        if (highlighting && colorBy === "playlist" && !highlight.includes(region.group)) continue;
        if (named.has(region.group)) continue;
        named.add(region.group);
        const name = paint.names.get(region.group) ?? "";
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

    // The bridge (or set): one line through its songs, with ends that look different from each other.
    const route = bridgeIds.flatMap((id) => {
      const i = data.pos.get(id);
      return i === undefined ? [] : [i];
    });
    const rough = scene.kind === "set" ? scene.rough : null;
    if (route.length > 0) {
      ctx.globalAlpha = 0.9;
      ctx.lineWidth = 2;
      ctx.lineJoin = "round";
      route.slice(1).forEach((i, step) => {
        const bad = rough?.has(audio.ids[route[step]!]!) ?? false;
        ctx.strokeStyle = bad ? BAD : BRIDGE_COLORS.path;
        ctx.setLineDash(bad ? [4, 4] : []);
        ctx.beginPath();
        ctx.moveTo(...at(route[step]!));
        ctx.lineTo(...at(i));
        ctx.stroke();
      });
      ctx.setLineDash([]);
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
    if (scene.kind === "set") {
      ctx.globalAlpha = 0.9;
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = "#a092ab";
      ctx.setLineDash([2, 3]);
      for (const id of scene.dashed) {
        const i = data.pos.get(id);
        if (i !== undefined) ring(...at(i), r + 4);
      }
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;
      ctx.lineWidth = 2;
      ctx.strokeStyle = BAD;
      for (const id of scene.ringed) {
        const i = data.pos.get(id);
        if (i !== undefined) ring(...at(i), 9);
      }
    }

    // Song names: the scene's pills first, then its songs, then everyone else's (zoomed in, dimmer).
    // Each one is placed to fit fully inside the canvas, and the scene's dots are kept clear of names.
    const marked = mark ? data.pos.get(mark) : undefined;
    const taken: Box[] = [];
    const spots = new Map<string, string>();
    /** Places a name, preferring the spot it had last frame, and remembers where it went. */
    const place = (key: string, point: Point, size: Size, gap: number, mustShow: boolean) => {
      const placed = placeLabel(point, size, gap, [width, height], taken, mustShow, lastSpots.current.get(key));
      if (!placed) return null;
      taken.push(placed.box);
      spots.set(key, placed.spot);
      return placed.box;
    };
    for (const id of subjects) {
      const i = data.pos.get(id);
      if (i === undefined) continue;
      const [sx, sy] = at(i);
      taken.push([sx - r - 3, sy - r - 3, 2 * r + 6, 2 * r + 6]);
    }
    /** The song's name, cut short only if it's wider than the whole canvas. */
    const nameOf = (i: number) => {
      const name = songName(i);
      const room = width - 32;
      if (ctx.measureText(name).width <= room) return name;
      let cut = name;
      while (cut.length > 1 && ctx.measureText(`${cut}…`).width > room) cut = cut.slice(0, -1);
      return `${cut}…`;
    };
    /** A name displaced from its song gets a thin line back to it. */
    const leader = (i: number, [bx, by, bw, bh]: Box, color: string, alpha = 1) => {
      const [sx, sy] = at(i);
      const [ex, ey] = [Math.max(bx, Math.min(sx, bx + bw)), Math.max(by, Math.min(sy, by + bh))];
      if (Math.hypot(ex - sx, ey - sy) < r + 14) return;
      ctx.globalAlpha = 0.4 * alpha;
      ctx.strokeStyle = color;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(sx, sy);
      ctx.lineTo(ex, ey);
      ctx.stroke();
    };
    /** A scene's song name, kept inside the canvas; it fades out as its dot nears the edge, gone once the dot leaves. */
    const label = (i: number, font: string, color: string, alpha: number, mustShow: boolean) => {
      const point = at(i);
      const edge = Math.min(Math.min(point[0], point[1], width - point[0], height - point[1]) / EDGE_FADE, 1);
      if (edge <= 0) return;
      ctx.font = font;
      const name = nameOf(i);
      const box = place(`n${i}`, point, [ctx.measureText(name).width + 4, NAME_HEIGHT], r + 3, mustShow);
      if (!box) return;
      leader(i, box, color, edge);
      ctx.globalAlpha = alpha * edge;
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
      const box = place(`p${i}`, at(i), [ctx.measureText(name).width + 14, PILL_HEIGHT], 14, true)!;
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
    lastSpots.current = spots;

    // Background names: each fades in past its appear zoom, later the farther it is from the center of attention,
    // always to the right of its dot. Instead of moving away from the canvas edge or the scene's names, it fades out.
    // The focused song held to the canvas, so one panned off screen still leans names toward its side.
    const anchor = fi !== undefined ? at(fi) : [width / 2, height / 2];
    const [ox, oy] = [Math.min(Math.max(anchor[0]!, 0), width), Math.min(Math.max(anchor[1]!, 0), height)];
    const reach = Math.hypot(width, height);
    ctx.font = FONT.rest;
    /** Draws a background name to the right of its dot at `fade`, unless the edge or a name already there hides it. */
    const backgroundName = (i: number, w: number, fade: number) => {
      const [sx, sy] = at(i);
      const box: Box = [sx + r + 3, sy - NAME_HEIGHT / 2, w, NAME_HEIGHT];
      const edge = Math.min(box[0], width - box[0] - w, box[1], height - box[1] - NAME_HEIGHT) / EDGE_FADE;
      if (edge <= 0 || overlaps(taken, box)) return;
      taken.push(box);
      named.add(i);
      ctx.globalAlpha = (dimming ? 0.5 : 0.75) * fade * Math.min(edge, 1);
      const name = songName(i);
      ctx.lineWidth = 3;
      ctx.strokeStyle = BACKGROUND;
      ctx.strokeText(name, box[0] + 2, box[1] + 11);
      ctx.fillStyle = "#c2b6c9";
      ctx.fillText(name, box[0] + 2, box[1] + 11);
    };
    for (const { i, zoom, width: w } of backgroundNames) {
      if (zoom > k || named.has(i)) continue;
      const [sx, sy] = at(i);
      const appear = zoom * (1 + (CENTER_BIAS * Math.hypot(sx - ox, sy - oy)) / reach);
      const fade = Math.min((k - appear) / (appear * NAME_FADE), 1);
      if (fade > 0) backgroundName(i, w, fade);
    }
    // Around the pointer, songs not named yet get named early, nearest first, fading out toward the radius's rim.
    const near = pointer.current;
    if (near && k >= REGION_FADE_END) {
      const spot = backgroundNames.flatMap(({ i, width: w }) => {
        if (named.has(i) || i === hover?.i) return [];
        const [sx, sy] = at(i);
        const d = Math.hypot(sx - near[0], sy - near[1]);
        return d < SPOT_RADIUS ? [{ i, w, d }] : [];
      });
      for (const { i, w, d } of spot.sort((a, b) => a.d - b.d)) backgroundName(i, w, Math.min((SPOT_RADIUS - d) / (SPOT_RADIUS / 2), 1));
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
  // The hovered tile's playlists (or categories), by the share of its songs in each (a song can be in several
  // playlists, so they overlap).
  const tileShares = (() => {
    if (!hoveredTile) return [];
    const counts = new Map<string, number>();
    for (const i of hoveredTile.songs) for (const p of paint.groupsOf[i]!) counts.set(p, (counts.get(p) ?? 0) + 1);
    return [...counts].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([id, n]) => ({ id, share: n / hoveredTile.songs.length }));
  })();

  return (
    <div ref={wrapRef} className="relative w-full select-none overflow-hidden rounded-lg bg-zinc-900" style={{ height }}>
      <canvas
        ref={canvasRef}
        width={width * (window.devicePixelRatio || 1)}
        height={height * (window.devicePixelRatio || 1)}
        style={{ width, height }}
        className={drag.current ? "cursor-grabbing" : hover ? "cursor-pointer" : scene.kind === "bridge" && bridgeIds.length === 1 ? "cursor-crosshair" : "cursor-grab"}
        onPointerDown={(e) => {
          cancelAnimationFrame(glide.current);
          drag.current = { x: e.clientX, y: e.clientY, moved: 0 };
          e.currentTarget.setPointerCapture(e.pointerId);
        }}
        onPointerMove={(e) => {
          pointer.current = local(e);
          schedule();
          const d = drag.current;
          if (d) {
            const dx = e.clientX - d.x, dy = e.clientY - d.y;
            d.moved += Math.abs(dx) + Math.abs(dy);
            [d.x, d.y] = [e.clientX, e.clientY];
            const { k } = view.current;
            view.current = { k, cx: view.current.cx - dx / (base * k), cy: view.current.cy - dy / (base * k) };
            return;
          }
          const [sx, sy] = pointer.current;
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
        onPointerLeave={() => {
          pointer.current = null;
          schedule();
          setHover(null);
          setArea(null);
        }}
      />
      {area && hoveredTile && (
        <div
          className={`pointer-events-none absolute top-2 z-10 w-56 rounded-lg border border-white/10 bg-zinc-900/90 px-3 py-2 text-xs shadow-xl ${area.corner ? "right-2" : "left-2"}`}
        >
          <div className="mb-1.5 text-zinc-400">{hoveredTile.songs.length === 1 ? "1 song" : `${hoveredTile.songs.length} songs`}</div>
          {tileShares.length === 0 && colorBy === "playlist" && <div className="text-zinc-500">Unsorted</div>}
          {tileShares.map(({ id, share }) => (
            <div key={id} className="mt-1">
              <div className="flex justify-between gap-2">
                <span className="truncate text-zinc-200">{paint.names.get(id)}</span>
                <span className="tabular-nums text-zinc-400">{Math.round(share * 100)}%</span>
              </div>
              <div className="mt-0.5 h-1 rounded-full bg-white/5">
                <div className="h-full rounded-full" style={{ width: `${share * 100}%`, background: paint.colors.get(id) ?? UNSORTED }} />
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
          <div className="font-semibold text-zinc-100">{title(hoveredTrack.id, hoveredTrack.name)}</div>
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
      {paint.legend.length > 0 && (
        <div className="pointer-events-none absolute bottom-2 left-2 z-10 space-y-1 rounded-lg border border-white/10 bg-zinc-900/90 px-3 py-2 text-xs text-zinc-300">
          {paint.legend.map((c) => (
            <div key={c} className="flex items-center gap-2">
              <span className="size-2.5 shrink-0 rounded-full" style={{ background: paint.colors.get(c) }} />
              {c}
            </div>
          ))}
        </div>
      )}
      <div ref={menuRef} className="absolute bottom-2 right-2 z-20 flex flex-col items-end gap-1.5">
        {menu && offered.length > 1 && (
          <div className="rounded-lg border border-white/10 bg-zinc-900/95 px-3 py-2 text-xs text-zinc-400 shadow-xl">
            <div className="mb-1.5">Color by</div>
            <div className="flex gap-1">
              {offered.map((m) => (
                <button
                  key={m}
                  aria-pressed={m === colorBy}
                  onClick={() => setColorBy(m)}
                  className={`rounded-md px-2 py-1 capitalize ${m === colorBy ? "bg-white/15 text-zinc-50" : "text-zinc-300 hover:bg-white/5"}`}
                >
                  {m}
                </button>
              ))}
            </div>
          </div>
        )}
        {menu && colorBy === "playlist" && (
          <button
            role="switch"
            aria-checked={compilations}
            onClick={() => setCompilations(!compilations)}
            className="flex items-center gap-2.5 rounded-lg border border-white/10 bg-zinc-900/95 px-3 py-2 text-xs text-zinc-200 shadow-xl hover:bg-zinc-800"
          >
            Compilations
            <span className={`relative h-4 w-7 rounded-full transition ${compilations ? "bg-emerald-400" : "bg-white/15"}`}>
              <span className={`absolute top-0.5 size-3 rounded-full bg-zinc-50 transition-all ${compilations ? "left-3.5" : "left-0.5"}`} />
            </span>
          </button>
        )}
        <button
          aria-label="Map settings"
          aria-expanded={menu}
          onClick={() => setMenu(!menu)}
          className="grid size-8 place-items-center rounded-lg border border-white/10 bg-zinc-900/90 text-zinc-400 hover:text-zinc-100"
        >
          <svg viewBox="0 0 24 24" className="size-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
            <circle cx="12" cy="12" r="3" />
          </svg>
        </button>
      </div>
    </div>
  );
}
