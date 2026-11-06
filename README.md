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
ENGINE_EMBED="uv run --project /Users/axel/.t3/projects/audio-embed-engine audio-embed embed {input}"
ENGINE_EXPORT="uv run --project /Users/axel/.t3/projects/audio-embed-engine audio-embed export {input} --out {output}"
ENGINE_MODEL=discogs-effnet   # label only
```

## App

`pnpm dev`, then open http://127.0.0.1:3000 (must match the Spotify app's redirect URI). Playback is remote
control (Spotify Connect): the app tells one of your Spotify apps (picker under the player; the Mac app by
default) what to play and shows the position Spotify reports. Audio never plays in the page, so any browser
works. Needs Premium and Spotify open somewhere. Tracks are started as a position in their album: a plain
track-URI play request is accepted but loads nothing on this account.

- **Sort**: the current liked song plays from ~35% in. Confident suggestions start checked, but only for
  artists you've sorted before (audio-only prechecks were right ~35% of the time; see `pnpm eval`).
  `1`–`9` toggle, `/` searches all playlists (or creates a private one named after the search, checked for
  the current song, with no resync needed), `Enter` sorts (adds to checked playlists + the all-songs
  playlist, removes from Liked Songs), `S` skips, `⌘Z` undoes (re-liking loses the original liked date),
  `Space` play/pause, `←`/`→` seek 10s, `M` switches tabs.
- **Artist rules**: hover a playlist row (or a search result) and click **Artists…** to say "this playlist
  is for these artists" (any of them matches; autocomplete from your library). Matching songs get the
  playlist on top and checked; it's never suggested for other songs. Saved in `data/rules.json`, which
  `pnpm eval` also reads.
- **Hidden playlists**: for playlists like "Best of 2020", click **Hide** on a row (or a search result).
  They're never suggested, the model doesn't learn from them, they're left off the sound map, and a
  liked song that's only in hidden playlists still counts as unsorted. You can still pick one from
  search. Unhide from the "Hidden:" list under the search box. Saved in `data/hidden.json`.

- **Sound map**: every song placed by sound; zoomed out shows playlist bubbles, zoom in for songs.
  Click a playlist to highlight it, click a song to select/play it.

Spotify writes run in order in the background; the header shows pending/failed writes. The app saves its
view of the library to `data/library.json` (shared with the scripts) through the dev server. Each sort is
also recorded right away in `data/ledger.json` and applied over whatever library loads or resyncs, so a
sort is never forgotten if that save is lost or Spotify still returns old data. A resync drops entries once
Spotify shows them; entries older than a day are dropped too.


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
