# playlist-sorter

Suggests which of my Spotify playlists a liked song belongs in, learned from how I've already sorted my music.

## Setup

`.env` (gitignored):

```
SPOTIFY_CLIENT_ID=...                              # reuses the old axor_portfolio Spotify app
SPOTIFY_REDIRECT_URI=http://127.0.0.1:3000/web_player
ALL_PLAYLIST=Everything                            # catch-all playlist: never suggested
```

## Scripts

- `pnpm export` logs in (PKCE, browser) and writes `data/library.json` plus engine input
  `data/tracks.jsonl` and `data/sample-tracks.jsonl`. Playlists whose snapshot is unchanged are not refetched.
- `pnpm eval` runs a 5-fold check of how well artist overlap and playlist pairings predict
  my existing playlist memberships.
