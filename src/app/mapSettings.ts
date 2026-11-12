// Sound map preferences shared by every map, kept in this browser.
import { create } from "zustand";
import { COLOR_BY, type ColorBy } from "../core/colorBy.ts";

const KEY = "map-compilations";
const COLOR_KEY = "map-color-by";

type MapSettings = {
  /** Whether playlists that aren't a sound (uncounted ones, and ones named after their own artist) color songs and tint tiles. */
  compilations: boolean;
  setCompilations: (on: boolean) => void;
  /** What the Sound map tab colors songs and tiles by; other maps always use playlists. */
  colorBy: ColorBy;
  setColorBy: (mode: ColorBy) => void;
};

/** Reads a saved value; blocked storage reads as nothing saved. */
const load = (key: string) => {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
};
/** Saves a value; blocked storage only means the choice resets on reload. */
const save = (key: string, value: string) => {
  try {
    localStorage.setItem(key, value);
  } catch {}
};
const isColorBy = (s: string | null): s is ColorBy => COLOR_BY.some((m) => m === s);

export const useMapSettings = create<MapSettings>((set) => ({
  compilations: load(KEY) === "true",
  setCompilations: (on) => {
    save(KEY, String(on));
    set({ compilations: on });
  },
  colorBy: (() => {
    const saved = load(COLOR_KEY);
    return isColorBy(saved) ? saved : "playlist";
  })(),
  setColorBy: (mode) => {
    save(COLOR_KEY, mode);
    set({ colorBy: mode });
  },
}));
