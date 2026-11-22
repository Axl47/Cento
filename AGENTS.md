# Agent notes

## Play history

- Spotify's extended streaming history (2016-11-06 to 2026-11-11) is in `data/extended-history/` as `Streaming_History_Audio_*.json`; `pnpm plays` joins it with the host's own recording in `data/listening-history.jsonl`, which starts 2026-11-09. A newer export replaces those files (request it from Spotify's privacy page; the link arrives by email).
- Segue's events (transitions, grades, plays, rejected pairings) are in `data/segue.jsonl`, written by the host (`src/host/segue.ts`) and counted by `pnpm plays`; times without a UTC offset are Puerto Rico local time (UTC−4).
