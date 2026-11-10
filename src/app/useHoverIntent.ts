// Hover that waits a moment before it counts, so passing over something on the way elsewhere, or crossing
// the gap between two tiles, doesn't set off the map's camera.
import { useEffect, useRef, useState } from "react";

const SETTLE_MS = 90;

/** `current` is what's hovered now, `last` the latest thing that was; `hover` waits to settle, `set` applies at once (keyboard). */
export function useHoverIntent<T>() {
  const [state, setState] = useState<{ current: T | null; last: T | null }>({ current: null, last: null });
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const set = (value: T | null) => {
    clearTimeout(timer.current);
    setState((s) => ({ current: value, last: value ?? s.last }));
  };
  const hover = (value: T | null) => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => set(value), SETTLE_MS);
  };
  useEffect(() => () => clearTimeout(timer.current), []);
  return { ...state, hover, set };
}
