# playlist-sorter

Suggests which of my Spotify playlists a liked song belongs in, learned from how I've already sorted my music.

## Setup

`.env` (gitignored):

```
SPOTIFY_CLIENT_ID=...                              # reuses the old axor_portfolio Spotify app
SPOTIFY_REDIRECT_URI=http://127.0.0.1:3000/web_player
```

Playlist choices (the all-songs playlist, ignored copies) live in `src/core/config.ts`.

## Layout

- `src/core/`: shared by scripts and app (Spotify client, library sync, suggestion model)
- `src/cli/`: Node scripts

## Scripts

- `pnpm export` logs in (PKCE, browser) and writes `data/library.json` plus engine input
  `data/tracks.jsonl`. It refetches every playlist (~1.5 min): Spotify's snapshot_id can stay
  stale after edits, so it can't be used to skip unchanged playlists.
- `pnpm eval` runs a 5-fold check of the suggestion model against existing playlist memberships.
- `pnpm backfill [--apply]` adds sorted songs missing from the all-songs playlist (dry run by default).
