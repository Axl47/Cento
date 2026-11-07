# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Sort several alike songs at once: upcoming songs that would get the same picks are outlined after the current one; leave any out with a click and sort the rest with `⇧Enter`.
- `⌘K` (or `/`) opens one palette for finding, checking and creating playlists, hiding and unhiding them, artist rules, queue order, "Remove from Liked Songs" and the playback device.
- Undo any song sorted this session from the row of recent sorts, not just the latest one.
- `↑`/`↓` move through the playlist tiles, so the evidence panel can be browsed without the mouse.
- The evidence panel shows the artist's sorted songs as covers, how many of the 15 nearest songs are in the playlist, and the playlist's closest songs with similarity bars.

### Changed

- Playlists show as tiles with a single confidence bar in the playlist's own color, replacing the multi-color score bar and its legend.
- Hide and Artists… moved from each playlist row to the evidence panel and the palette.
- The sort screen drops always-on hints and settings, so the song and its playlists are the focus.
- New aubergine color scheme and Bricolage Grotesque type across the app.
- Number keys now cover the top 8 playlists instead of 9.
