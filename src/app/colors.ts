// One color per playlist for the sound map, taken from its cover where the image allows
// it (CORS) and otherwise derived from the name. Colors are adjusted to read on a dark
// background, and cached per cover URL in localStorage.
import { useEffect, useState } from "react";
import type { Playlist } from "../core/library.ts";

const CACHE_KEY = "playlist-colors-v1";

const hashHue = (s: string) => [...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7) % 360;
const fallback = (p: Playlist) => `hsl(${hashHue(p.name)} 70% 62%)`;

/** The most saturated common hue of a cover, as a readable HSL color, or null if unreadable. */
async function coverColor(url: string): Promise<string | null> {
  const img = new Image();
  img.crossOrigin = "anonymous";
  img.src = url;
  try {
    await img.decode();
    const size = 24;
    const canvas = Object.assign(document.createElement("canvas"), { width: size, height: size });
    const ctx = canvas.getContext("2d")!;
    ctx.drawImage(img, 0, 0, size, size);
    const { data } = ctx.getImageData(0, 0, size, size); // throws if the image is cross-origin tainted

    // Weighted hue histogram: saturated, mid-light pixels count most.
    const bins = new Float64Array(36);
    for (let i = 0; i < data.length; i += 4) {
      const [r, g, b] = [data[i]! / 255, data[i + 1]! / 255, data[i + 2]! / 255];
      const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2, d = max - min;
      if (d < 0.08) continue;
      const sat = d / (1 - Math.abs(2 * l - 1));
      const hue = max === r ? ((g - b) / d + 6) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
      bins[Math.floor(hue * 6) % 36]! += sat * (1 - Math.abs(l - 0.5));
    }
    const best = bins.indexOf(Math.max(...bins));
    if (bins[best]! < 3) return null; // mostly grey/black covers
    return `hsl(${best * 10 + 5} 75% 62%)`;
  } catch {
    return null;
  }
}

export function usePlaylistColors(playlists: Playlist[]): Map<string, string> {
  const [colors, setColors] = useState(() => new Map<string, string>());

  useEffect(() => {
    let cancelled = false;
    setColors(new Map(playlists.map((p) => [p.id, fallback(p)]))); // immediate, refined below
    let cache: Record<string, string | null> = {};
    try {
      cache = JSON.parse(localStorage.getItem(CACHE_KEY) ?? "{}") as Record<string, string | null>;
    } catch {}
    void (async () => {
      const result = new Map<string, string>();
      for (const p of playlists) {
        if (p.imageUrl && !(p.imageUrl in cache)) cache[p.imageUrl] = await coverColor(p.imageUrl);
        result.set(p.id, (p.imageUrl && cache[p.imageUrl]) || fallback(p));
      }
      try {
        localStorage.setItem(CACHE_KEY, JSON.stringify(cache));
      } catch {}
      if (!cancelled) setColors(result);
    })();
    return () => void (cancelled = true);
  }, [playlists]);

  return colors;
}
