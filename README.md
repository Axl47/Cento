# Cento

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

For the sound map and "sounds like" suggestions, point `pnpm audio` at Stemma in `.env`
(run with cwd `ENGINE_DIR`; `{input}`/`{output}` are filled in):

```
ENGINE_DIR=/Users/axel/Desktop/Code_Projects/Personal/Developer/Stemma
ENGINE_EMBED="uv run --project /Users/axel/Desktop/Code_Projects/Personal/Developer/Stemma audio-embed embed {input}"
ENGINE_EXPORT="uv run --project /Users/axel/Desktop/Code_Projects/Personal/Developer/Stemma audio-embed export {input} --out {output}"
ENGINE_MODEL=discogs-effnet   # label only
```

## App

`pnpm dev`, then open http://127.0.0.1:3000 (must match the Spotify app's redirect URI).

`pnpm dev:lan` serves it to your network instead, over HTTPS with a self-signed certificate (accept the
browser warning once per device). Spotify only takes plain-http redirects for 127.0.0.1, so register
`https://<this machine's LAN IP>:3000/web_player` (and `https://127.0.0.1:3000/web_player` to use it from
this machine) on the Spotify app. Each address logs in separately. The dev server's `/api/*` data has no
auth, so anyone on the network can read and change it. Playback is remote
control (Spotify Connect): the app tells one of your Spotify apps (picker under the player; the Mac app by
default) what to play and shows the position Spotify reports. Audio never plays in the page, so any browser
works. Needs Premium and Spotify open somewhere. Tracks are started as a position in their album: a plain
track-URI play request is accepted but loads nothing on this account.

- **Sort**: the current liked song plays from ~35% in, with its genres, mood, tempo and key under the album name
  (see `pnpm tags`). Its playlists show as tiles; the bar on each is the
  model's confidence. Confident suggestions start checked. For artists you've never sorted, that's limited to the one
  playlist the sound classifier is confident about (see `pnpm classify`). `1`–`8` toggle, `Enter` sorts (adds to
  checked playlists + the all-songs playlist, removes from Liked Songs), `S` skips, `Space` play/pause,
  `←`/`→` seek 10s, `M` switches tabs.
  - **Runs**: when the next songs would be prechecked exactly like this one, they're outlined after it.
    Click one to leave it out; `⇧Enter` sorts the whole run with the current picks.
  - **Sound panel** (right): with no tile hovered, the map shows the song's 15 nearest sorted songs by name, each in
    its own playlist's color. Hover a tile (or `↑`/`↓`, `Esc` to go back) to compare against that playlist instead:
    its closest songs, which of the artist's sorted songs are in it, how many of the 15 nearest are, and its closest
    songs with bars (from the random-pair baseline to this song's nearest neighbor anywhere). Hovering any song
    there, or in the run / up-next strip, points it out on the map, which zooms out if that's what it takes to show it.
  - **Playlist info** (below the actions): the last playlist looked at, with its size, the languages of its songs,
    its lyric themes (ones this song shares are outlined) and how well sound predicts it.
  - **Undo**: each sorted song stays in a row below the actions with its own Undo; `⌘Z` undoes the latest
    (re-liking loses the original liked date).
  - **`⌘K`** (or `/`): find a playlist and check it, create a private one named after the search (checked,
    no resync needed), hide/unhide, artist rules, queue order, "Remove from Liked Songs", playback device.
- **Artist rules**: **Artists…** in the playlist info (or on a `⌘K` result) says "this playlist is for these
  artists" (any of them matches; autocomplete from your library). Matching songs get the playlist on top and
  checked; it's never suggested for other songs. Saved in `data/rules.json`, which `pnpm eval` also reads.
- **Hidden playlists**: for playlists like "Best of 2020", click **Hide** in the playlist info (or on a `⌘K`
  result). They're never suggested, the model doesn't learn from them, they're left off the sound map, and a
  liked song that's only in hidden playlists still counts as unsorted. You can still pick one from `⌘K`,
  which also lists them to unhide. Saved in `data/hidden.json`.

- **Not counted as sorted**: for doing a rough pass into a catch-all playlist (one per artist, say) and a proper
  one later. In `⌘K`, search for a playlist and choose **Don't count**. It joins a row on the sort screen where a
  click switches it on or off. While on, its songs are back in the queue even if they're no longer liked, unless
  another playlist that counts already has them, and it isn't suggested. Nothing changes on Spotify, and the row is saved in this browser.

- **Sound map**: every song placed by sound, over hex tiles tinted by the playlist most of each tile's songs are
  in. Playlists not counted as sorted and playlists named after their own artist color no songs and tint no tiles, unless **Compilations** is on (gear, bottom right of the map; saved in this browser). Tints are stronger where that playlist clearly leads (see `src/core/hexTiles.ts`). Zoomed out, each playlist's
  biggest area is named. Pointing anywhere shows, in a corner, which playlists that tile's songs are in. It's the same map as the sort screen's: click a song to see it among its nearest songs, hover a
  playlist to preview it and click to keep it highlighted.
  **Added between** narrows the map to songs first liked or added to a playlist in that date range (playlist dates
  arrive with the next resync).
  **Bridges**: on a selected song, **Bridge from here** (`B`) and then click the song to end on builds a route that
  travels gradually between them by sound, drawn on the map. Listen in order, replace any song, or save it as a private
  Spotify playlist that stays out of sorting.

- **Build** (`B`, except on the Sound map where `B` starts a bridge): turns a handful of songs into a playlist. Paste
  Spotify track, album or playlist links (several at once) or search by title or artist; an empty set also offers
  your recent playlists to start from. Songs not in the library can join, but they get no handoff bars and keep their
  place. The bar between two songs is the handoff: how well the end of one leads into the start of the next (green
  ≥ 0.65, red under 0.55, scaled from the random-pair baseline). Click it to hear the last 15 s of one and the first
  15 s of the next, or click a song to play it (`Space` play/pause). **Smooth** reorders for the best handoffs;
  dragging a song pins it (●, click to toggle) and Smooth keeps pinned songs in their slots. `rough` on a handoff
  offers songs that would bridge it, and says why when it can: a tempo jump (half and double time don't count), the next
  song starting much louder or quieter than the last one ended, or clashing keys. Songs with a steady beat show their
  BPM, and an **Energy** card plots each song's loudness in set order. Songs that don't fit are marked with **Remove**; when more than a quarter
  don't, **Two groups** offers to keep the first group or split the second into its own set. The right column
  suggests songs to add, or shows the set as a route on the map. The suggestions can be narrowed by mood, vocals,
  tempo, genre and language; with an empty set the same filters pick 20 songs to start from. `⌘Z` undoes. Sets are kept in this browser;
  **Save to Spotify** creates a private playlist in this order that stays out of sorting, and later updates it.
- **Playlists** (`P`): a workshop for one of your playlists, picked from the list on the left (biggest first).
  **Split** divides it into 2–6 groups by sound, each named after what sets it apart from the rest of the playlist,
  or by **Lyrics**: the themes most of its songs are about, each holding the songs that carry that theme clearly
  (songs with no clear theme stay out of every group).
  Rename a group, drop songs from it (×), divide it in two again, or open it in Build. **Save as playlist** creates
  a private playlist from the group that counts for sorting like any other; the parent playlist is left as it is.
  Splits last until a reload. **Missing** lists songs in your library the playlist probably should have; **Add** puts
  the checked ones in it on Spotify. **Doesn't fit** lists its songs least likely to belong; **Remove** takes one out of
  it on Spotify (it stays in your other playlists and in Everything), with **Undo** until you leave. A playlist with
  an artist rule is checked against the rule, not its sound: Missing is its artists' songs that aren't in it, and
  Doesn't fit is its songs by anyone else.

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
- `pnpm merge-copies [--apply]` keeps one copy of each song saved from several releases (same audio): the explicit one, then the album copy, then the newest release replaces the others in every playlist and Liked Songs, except hidden playlists (dry run by default; run `pnpm export` first). Each merge is logged in `data/merges.json`, and resyncs put back the dates the copies were first added.
- `pnpm audio [--vectors <file>]` runs the engine (or reads its vectors) and writes `data/audio.json`:
  top-50 neighbors and a UMAP layout per track, plus `data/vectors.bin` (8-bit vectors, ~8 MB) so the app
  can rank any playlist's closest songs. Skipped when vectors and settings are unchanged.
- `pnpm edges` writes `data/edges.bin`: the sound of each song's first and last ~16 s, from the engine's per-moment
  vectors (`PATCHES_DIR`, default `~/.cache/audio-embed-engine/patches`). Run it after `pnpm audio`. A song with no
  full track yet uses its whole-song vector instead.
- `pnpm tags` writes `data/tags.json`: each song's likeliest genres and its moods (aggressive, relaxed, sad, party,
  acoustic, electronic), from Stemma's per-song tags (`TAGS_FILE`, default `~/.cache/audio-embed-engine/tags/tags.jsonl`).
  New songs get tags only after rerunning Stemma's `bench/tags.py run`, which takes seconds. Skipped when that file
  doesn't exist. Genres and moods name the groups in Playlists, filter Build's suggestions, and show under the song in Sort.
- `pnpm features` writes `data/features.json`: each song's tempo, key, loudness (overall, and of its first and last 10 s)
  and vocals, from Stemma's per-song features (`FEATURES_FILE`, default `~/.cache/audio-embed-engine/features/features.jsonl`).
  New songs get features only after rerunning Stemma's `bench/extract_features.py`, which is resumable. Skipped when
  that file doesn't exist.
- `pnpm classify` trains one sound classifier per playlist from your sorted songs (seconds, on the engine's vectors)
  and writes `data/classifier.json`. Run it after `pnpm audio`; a resync in the app also runs it. Its scores replace
  the nearest-neighbor vote where available, and it can check one playlist from sound alone when it's confident and that
  playlist is reliably predictable (a held-out test on new artists: about two-thirds of those checks were already right).
  The classifier also uses each song's lyric language when `data/languages.jsonl` exists; refresh it with the engine's
  `audio-embed languages <lyrics.jsonl> --out data/languages.jsonl`. Songs without one use sound alone.
  When `pnpm lyrics` has built `data/lyrics-index.*`, it also uses what each song's lyrics mean (the average of its passage
  vectors, written to `data/lyrics-vectors.jsonl`); songs without lyrics are scored from sound alone. Rerun `pnpm lyrics` first
  so new songs have them.
- `pnpm lyrics` builds `data/lyrics-index.*` for the Lyrics tab from the engine's fetched lyrics (or `LYRICS_FILE`). It
  downloads the text model once, and later runs embed only new lyrics. Restart `pnpm dev` afterwards. It also scores
  every song against the list of `THEMES` in `src/core/themes.ts` for the Themes tab: edit the list and rerun to change them.
- `pnpm host` builds the app and runs the host in the background as a login agent: it returns right away, starts again
  at every login and restarts if it crashes. Rerun it after changing the code; `pnpm host:stop` stops it until the next
  login, and its output goes to `data/host.log`. The host keeps Now Playing running with no tab open.
  Once a day from 12:01 AM it refreshes the data: a resync from Spotify, then `pnpm audio`, `pnpm edges`, `pnpm features`, `pnpm tags` and `pnpm classify`. A day
  it missed (Mac asleep or off) runs as soon as the host is up, before it starts serving; a failed run is retried an
  hour later. `GET /host/status` shows the last run, kept in `data/refresh.json`. It's on this Mac at `http://127.0.0.1:3001/now`
  and on your network at the address it prints (also under Settings on that screen). Open Cento once with the host
  running and it takes over your Spotify login. Other devices need the password you set from Settings on the Mac, and can
  reach only that screen and its player controls. It uses plain HTTP, so keep it to your home network.
  It also records every play, with or without a screen open: every 5 minutes it adds new plays from Spotify's last-50
  list to `data/listening-history.jsonl`, one raw response item per line. If all 50 are newer than the last recorded
  play, some may be missing, and `data/listening-gaps.jsonl` says between when. Both files can't be regenerated, so they
  are copied hourly to `config.historyBackup`, only ever adding to the copy. `GET /host/status` on this Mac shows the
  recorder's state, and it logs any problem, such as a login that lacks the `user-read-recently-played` permission.
- `pnpm test` runs the suggestion-model tests.
