# Agent notes

## Data on the way

- Spotify's extended streaming history (every play with timestamps, milliseconds played and skips) was requested on 2026-11-12 and has not arrived yet. Spotify emails a download link, usually within 30 days. Its `Streaming_History_Audio_*.json` files go in `data/extended-history/`, where `pnpm plays` joins them with the host's own recording in `data/listening-history.jsonl` (which starts in November 2026). Until then that recording is the only play history. The tolerance for matching a recorded play to its export row (`MATCH_TOLERANCE_MS` in `src/core/plays.ts`) is a guess: check it on the days both cover when the export lands.
