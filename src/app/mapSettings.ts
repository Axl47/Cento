// Sound map preferences shared by every map, kept in this browser.
import { create } from "zustand";

const KEY = "map-compilations";

type MapSettings = {
  /** Whether playlists that aren't a sound (uncounted ones, and ones named after their own artist) color songs and tint tiles. */
  compilations: boolean;
  setCompilations: (on: boolean) => void;
};

export const useMapSettings = create<MapSettings>((set) => ({
  compilations: (() => {
    try {
      return localStorage.getItem(KEY) === "true";
    } catch {
      return false;
    }
  })(),
  setCompilations: (on) => {
    try {
      localStorage.setItem(KEY, String(on));
    } catch {
      // Blocked storage only means the choice resets on reload.
    }
    set({ compilations: on });
  },
}));
