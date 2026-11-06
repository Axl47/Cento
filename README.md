# playlist-sorter

Suggests which of my Spotify playlists a liked song belongs in, learned from how I've already sorted my music.

## Setup

`.env` (gitignored):

```
SPOTIFY_CLIENT_ID=...                              # reuses the old axor_portfolio Spotify app
SPOTIFY_REDIRECT_URI=http://127.0.0.1:3000/web_player
```

Playlist choices (the all-songs playlist, ignored copies) live in `src/core/config.ts`.
The scripts' Spotify token is cached in `~/.cache/playlist-sorter/token.json` (outside the project so the
dev server can't serve it); the app keeps its own token in the browser.

For the sound map and "sounds like" suggestions, point `pnpm audio` at audio-embed-engine in `.env`
(run with cwd `ENGINE_DIR`; `{input}`/`{output}` are filled in):

```
ENGINE_DIR=/Users/axel/.t3/projects/audio-embed-engine
ENGINE_EMBED=...    # e.g. <engine cli> embed {input}
ENGINE_EXPORT=...   # e.g. <engine cli> export {input} --out {output}  -> JSONL { key, status, vector? }
ENGINE_MODEL=...    # label only
```

## App

`pnpm dev`, then open http://127.0.0.1:3000 (must match the Spotify app's redirect URI). Playback uses the
Web Playback SDK, which needs Spotify Premium.

- **Sort**: the current liked song plays from ~35% in. Confident suggestions start checked.
  `1`–`9` toggle, `/` searches all playlists, `Enter` sorts (adds to checked playlists + the all-songs
  playlist, removes from Liked Songs), `S` skips, `⌘Z` undoes (re-liking loses the original liked date),
  `Space` play/pause, `←`/`→` seek 10s, `M` switches tabs.
- **Sound map**: every song placed by sound; zoomed out shows playlist bubbles, zoom in for songs.
  Click a playlist to highlight it, click a song to select/play it.

Spotify writes run in order in the background; the header shows pending/failed writes. The app saves its
view of the library to `data/library.json` (shared with the scripts) through the dev server.

## Layout

- `src/core/`: shared by scripts and app (Spotify client, library sync, suggestion model, audio index)
- `src/cli/`: Node scripts
- `src/app/`: the Vite + React app

## Scripts

- `pnpm export` logs in (PKCE, browser) and writes `data/library.json` plus engine input
  `data/tracks.jsonl`. It refetches every playlist (~1.5 min): Spotify's snapshot_id can stay
  stale after edits, so it can't be used to skip unchanged playlists.
- `pnpm eval` runs a 5-fold check of the suggestion model against existing playlist memberships.
- `pnpm backfill [--apply]` adds sorted songs missing from the all-songs playlist (dry run by default).
- `pnpm audio [--vectors <file>]` runs the engine (or reads its vectors) and writes `data/audio.json`:
  top-50 neighbors and a UMAP layout per track. Skipped when vectors and settings are unchanged.
- `pnpm test` runs the suggestion-model tests.
