import { useCallback, useEffect } from "react";
import { useApp } from "./store.ts";

/**
 * Returns `title(id, name)`: a song's name with its listens, "Name (12)", once data/plays.json has loaded (it starts
 * loading on first use). Library songs never listened to show (0); songs outside the library, or before plays load,
 * show the bare name.
 */
export function useTitle() {
  const plays = useApp((s) => s.plays);
  const tracks = useApp((s) => s.lib?.tracks);
  useEffect(() => useApp.getState().loadPlays(), []);
  return useCallback(
    (id: string | null | undefined, name: string) => {
      const count = id ? (plays?.get(id)?.plays ?? (plays && tracks && id in tracks ? 0 : undefined)) : undefined;
      return count === undefined ? name : `${name} (${count})`;
    },
    [plays, tracks],
  );
}
