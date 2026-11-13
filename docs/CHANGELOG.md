# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- The sort screen shows how many times you've played the current song, and `⌘K` can order the queue most played first, so the songs you actually listen to get sorted before the rest.
- The sort screen shows how many songs are in the all-songs playlist and in no other that counts, and one click lets them into the queue. They were never offered before because they aren't liked.
- A reload opens the tab you were on (it's in the address, like `#playlists`), and the Playlists tab comes back to the view you had open with your splits as you left them, saved groups included.
- A song can be dragged from one split group to another.
- A playlist can be a part of another, like Future Bass of EDM. Sorting a song into a part also puts it in the playlist the part belongs to, the Playlists tab lists parts under their playlist, and its new **Parts** view shows which of a part's songs the playlist is still missing, which other playlists already sit mostly inside it, and which of its songs are in no part yet, with the parts each sounds closest to. A split group saved as a playlist becomes a part of the playlist it was split from.
- `pnpm plays` counts how often each song was played and skipped, and when it last played, from the plays the host records and, once its files are in `data/extended-history/`, Spotify's Extended Streaming History, counting a play both have once. The daily refresh runs it.
- The sound classifier also learns from what each song's lyrics mean, when `pnpm lyrics` has run, which places songs by artists you've never sorted a little better: the right playlist lands in the top 3 for about 3 more of every 100 such songs in `pnpm eval`. Songs without lyrics are scored from sound alone.
- A Build tab (`B`) turns a handful of songs into a playlist: add songs by pasting Spotify links or searching, see how smoothly each song hands off to the next and listen to each handoff, let **Smooth** order them around songs you've pinned, fill rough handoffs with suggested songs, drop songs that don't fit or split a set that's really two, and save it as a private Spotify playlist that stays out of sorting. Sets are kept in the browser.
- The host refreshes your data every day from 12:01 AM: it resyncs the library, embeds new songs and rebuilds the sound map, and retrains the classifiers. A day it missed runs as soon as the host starts again.
- `pnpm host` now runs the host in the background and returns right away, starts it again whenever you log in to the Mac, and restarts it if it crashes, so plays keep being recorded without a terminal held open. `pnpm host:stop` stops it.
- `pnpm merge-copies` never merges a remix, live or other version with the original, even when their audio looks the same.
- `pnpm merge-copies` cleans up songs saved from several releases (a single, an EP and the album): it keeps the explicit copy, then the album copy, then the newest release, puts it in every playlist any copy was in, including Liked Songs, and removes the other copies. Hidden playlists, such as yearly snapshots, are left as they are. It shows the plan first and only writes to Spotify with `--apply`.
- Songs merged by `pnpm merge-copies` keep the dates their copies were first added, in the app and after a resync, instead of showing as added on the day of the merge.
- The sound map tints its background in hex tiles by the playlist that leads each area, and pointing anywhere on it shows which playlists that tile's songs are in, while songs stay visible and clickable on top. This replaces the playlist bubbles.
- `pnpm host` records every Spotify play to a file with no screen open, logs any stretch where plays may be missing, and backs the file up hourly, so listening history isn't lost while waiting for Spotify's export. It needs one new Spotify login.
- A Now Playing screen (`N`, or by itself at `/now` for a TV or spare monitor) shows the current song large with its place on the sound map, when you added it, what its lyrics are about and what it sounds like, with playback controls and per-screen settings for which panels show.
- `pnpm host` keeps Now Playing running with no tab open and serves it to other devices on your network behind a password you set from the Mac, so a TV or spare monitor needs no Spotify login or certificate.
- Bridges build a list that travels gradually from one song to another by sound: on the Sound map choose **Bridge from here** (`B`) on a song, then click where it ends, and the route is drawn on the map with distinct ends. Listen to it in order, replace any song, and optionally save it as a private Spotify playlist that stays out of sorting.
- A playlist info section below the sort button shows the playlist's size, the languages of its songs, its lyric themes (highlighting the ones the current song shares) and how well sound predicts it.
- Selecting a song on the Sound map shows how it compares to the library, and hovering a playlist previews it, as on the sort screen.
- A Themes tab (`T`) describes what each playlist's lyrics are about, compared with the rest of your library, with the passages that show each theme, and says so when no theme stands out.
- The Themes tab lists songs that sound like a playlist but whose lyrics say something else, to help clean one up.
- The sort screen shows what the current song's lyrics lean toward, with the lines behind it and which suggested playlists share that theme.
- The evidence panel says what the focused playlist's lyrics lean toward and whether the current song shares it.
- A Lyrics tab (`L`) finds songs by a remembered line or by theme in any language, shows the passage that matched, and can narrow to songs not sorted yet.
- Suggestions now take a song's lyric language into account, which better places songs by artists you've never sorted.
- Suggestions now use a sound classifier trained on your own sorted playlists, which is better at placing songs by artists you've never sorted, and it can check one playlist from sound alone when it's confident.
- The sound map can be narrowed to songs added in a date range, and a resync now saves when each song was added to each playlist.
- A playlist can be marked as not counting as sorted, from `⌘K` or a new on/off row on the sort screen, which brings its songs back into the queue for a proper second pass without changing anything on Spotify.
- Sort several alike songs at once: upcoming songs that would get the same picks are outlined after the current one; leave any out with a click and sort the rest with `⇧Enter`.
- `⌘K` (or `/`) opens one palette for finding, checking and creating playlists, hiding and unhiding them, artist rules, queue order, "Remove from Liked Songs" and the playback device.
- Undo any song sorted this session from the row of recent sorts, not just the latest one.
- `↑`/`↓` move through the playlist tiles, so the evidence panel can be browsed without the mouse.
- Hovering a song in the evidence panel or the run / up-next strip points it out on the sound map.
- Clicking the current song's cover opens it in the Spotify app.
- The player can be turned off from `⌘K` (or "Turn off player" next to a player error): it stops checking Spotify, hides the controls, and Space opens the song in the Spotify app instead.
- A Log out button in the header (and on the error screen) forgets the Spotify login so you can sign in fresh.
- The evidence panel shows the artist's sorted songs as covers, how many of the 15 nearest songs are in the playlist, and the playlist's closest songs with similarity bars.

### Changed

- Song names on the sound map appear by importance as you zoom in: highlighted songs and one song per tile first, then each tile fills in as it grows on screen, starting near the center or the selected song. Names fade in and out instead of popping or jumping aside at the edges, and songs around the pointer are named early.
- The app is now called Cento.
- With no playlist hovered, the sort screen's map shows the song's 15 nearest songs by name, each in its own playlist's color.
- The sound map moves and zooms to keep every named song on screen, including a far-away song you hover to see how distant it is.
- The Sound map tab and Now Playing use the same map and styling as the sort screen.
- Number keys check a playlist without changing what the map shows; hover or `↑`/`↓` compares against one, and `Esc` goes back.
- Playlists show as tiles with a single confidence bar in the playlist's own color, replacing the multi-color score bar and its legend.
- Hide and Artists… moved from each playlist row to the evidence panel and the palette.
- The sort screen drops always-on hints and settings, so the song and its playlists are the focus.
- New aubergine color scheme and Bricolage Grotesque type across the app.
- Number keys now cover the top 8 playlists instead of 9.
- The sound map next to the playlists is larger.
- The current song's name is always shown on the sound map, even fully zoomed out, and its nearest neighbors are named from a medium zoom on, in their playlist's color.

### Fixed

- The same recording saved from different releases (a single, an EP and the album) now sits on one spot on the sound map instead of a few scattered dots. Run `pnpm audio` once to rebuild the map.
- Song names on the sound map hold their place while zooming instead of hopping above and below their dots.
- Log out now also signs the host out, so you can log in again to grant new permissions instead of being signed straight back in.
- The host keeps its Spotify login when Spotify refuses a token refresh, instead of deleting it during a background check.
- Song names on the sound map show in full and stay inside its border, moving to the other side of a song near the edge.
- When Spotify blocks playback control for hours, the player says so and until when, instead of waiting silently and never showing the current song; syncing and playlist changes keep working, since Spotify blocks the player separately.

- Playlist bubbles on the sound map sit where the playlist's songs are concentrated instead of at their average position, which could land between groups or in empty space; a playlist split across tight groups gets a bubble per group.
- Panning and zooming the sound map draws at most once per frame and batches dots by color, so it does less work per movement.
- Zoomed-in song names on the sound map no longer pile on top of each other; the most relevant ones are shown first.
- Playback no longer hammers Spotify into a rate limit: the player polls less often, and after a 429 every request waits out the cooldown instead of retrying on its own.
- When Spotify is rate-limiting the app, the player says so instead of showing the raw error or claiming no device was found.
