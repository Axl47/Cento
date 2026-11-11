import assert from "node:assert/strict";
import { test } from "node:test";
import { firstAdded, isArtistPlaylist, syncLibrary, type Library } from "./library.ts";
import type { SpotifyClient } from "./spotify.ts";

const song = (id: string) => ({ id, name: id, type: "track", is_local: false, duration_ms: 1, artists: [] });

test("a sync keeps each playlist row's date, skipping rows Spotify has no date for", async () => {
  const paths: string[] = [];
  const client = {
    get: async () => ({ id: "me" }),
    getAll: async (path: string) => {
      paths.push(path);
      if (path.startsWith("/me/playlists")) return [{ id: "p", name: "P", owner: { id: "me" }, images: null }];
      if (path.startsWith("/me/tracks")) return [];
      return [
        { added_at: "2024-01-01T00:00:00Z", track: song("a") },
        { added_at: "2025-01-01T00:00:00Z", track: song("a") },
        { added_at: null, track: song("b") },
      ];
    },
  } as unknown as SpotifyClient;

  const [playlist] = (await syncLibrary(client)).playlists;
  assert.match(paths.find((p) => p.startsWith("/playlists/"))!, /items\(added_at,/);
  assert.deepEqual(playlist!.trackIds, ["a", "b"]);
  assert.deepEqual(playlist!.addedAt, { a: "2024-01-01T00:00:00Z" });
});

test("firstAdded takes the earliest of liked and playlist dates", () => {
  const lib: Library = {
    fetchedAt: "",
    userId: "me",
    tracks: {},
    liked: [{ id: "a", addedAt: "2025-05-05" }, { id: "c", addedAt: "2023-03-03" }],
    playlists: [{ id: "p", name: "P", imageUrl: null, trackIds: ["a", "b"], addedAt: { a: "2024-04-04", b: "2026-06-06" } }],
  };
  assert.deepEqual([...firstAdded(lib)].toSorted(), [["a", "2024-04-04"], ["b", "2026-06-06"], ["c", "2023-03-03"]]);
});

test("a playlist named after an artist on its songs is an artist playlist, ignoring case and accents", () => {
  const track = (id: string, artist: string) => ({ id, name: id, artists: [{ id: artist, name: artist }], album: { name: "", imageUrl: null }, isrc: null, durationMs: 1 });
  const lib = { tracks: { a: track("a", "The Marías"), b: track("b", "Other") } } as unknown as Library;
  const playlist = (name: string, trackIds: string[]) => ({ id: name, name, imageUrl: null, trackIds });
  assert.equal(isArtistPlaylist(lib, playlist("the marias", ["b", "a"])), true);
  assert.equal(isArtistPlaylist(lib, playlist("The Marías", ["b"])), false);
  assert.equal(isArtistPlaylist(lib, playlist("Chill", ["a"])), false);
});
