// Personal playlist settings shared by the scripts and the app.

/** Suggestions at or above this score start out checked in the app (`pnpm eval` reports how accurate that is). */
export const PRECHECK = 0.4;
export const config = {
  /** "Everything": holds every song. Never suggested; every sorted song is added to it. */
  allPlaylistId: "1xVoRBtLYULxvva0k1OwMn",
  /** Copies of other people's playlists: never suggested, never backfilled. */
  ignoredPlaylistIds: ["3fKpVGfURs7G9L3WxrDhtr"] as string[],
  /** Spotify scopes the app and scripts request (one token covers both). */
  scopes: [
    "playlist-read-private",
    "playlist-read-collaborative",
    "playlist-modify-private",
    "playlist-modify-public",
    "user-library-read",
    "user-library-modify",
    "user-read-playback-state",
    "user-modify-playback-state",
    "user-read-email",
    "user-read-private",
    "streaming",
  ],
};
