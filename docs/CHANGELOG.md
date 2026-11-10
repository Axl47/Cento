# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- A Now Playing screen (`N`, or by itself at `/now` for a TV or spare monitor) shows the current song large with its place on the sound map, when you added it, what its lyrics are about and what it sounds like, with playback controls and per-screen settings for which panels show.
- A Bridges tab (`B`) builds a list that travels gradually from one song to another by sound; listen to it in order, replace any song, and optionally save it as a private Spotify playlist that stays out of sorting.
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

- Playlists show as tiles with a single confidence bar in the playlist's own color, replacing the multi-color score bar and its legend.
- Hide and Artists… moved from each playlist row to the evidence panel and the palette.
- The sort screen drops always-on hints and settings, so the song and its playlists are the focus.
- New aubergine color scheme and Bricolage Grotesque type across the app.
- Number keys now cover the top 8 playlists instead of 9.
- The sound map next to the playlists is larger.
- The current song's name is always shown on the sound map, even fully zoomed out, and its nearest neighbors are named from a medium zoom on, in their playlist's color.

### Fixed

- When Spotify blocks playback control for hours, the player says so and until when, instead of waiting silently and never showing the current song; syncing and playlist changes keep working, since Spotify blocks the player separately.

- Playlist bubbles on the sound map sit where the playlist's songs are concentrated instead of at their average position, which could land between groups or in empty space; a playlist split across tight groups gets a bubble per group.
- Panning and zooming the sound map draws at most once per frame and batches dots by color, so it does less work per movement.
- Zoomed-in song names on the sound map no longer pile on top of each other; the most relevant ones are shown first.
- Playback no longer hammers Spotify into a rate limit: the player polls less often, and after a 429 every request waits out the cooldown instead of retrying on its own.
- When Spotify is rate-limiting the app, the player says so instead of showing the raw error or claiming no device was found.
