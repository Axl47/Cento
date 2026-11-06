import { test } from "node:test";
import assert from "node:assert/strict";
import { applyLedger, unconfirmed, type LedgerEntry } from "./ledger.ts";
import type { Library } from "./library.ts";

const stale: Library = {
  fetchedAt: "",
  userId: "me",
  liked: [{ id: "song", addedAt: "" }, { id: "other", addedAt: "" }],
  tracks: {},
  playlists: [
    { id: "dance", name: "Dance", imageUrl: null, trackIds: ["other"] },
    { id: "all", name: "Everything", imageUrl: null, trackIds: ["other"] },
  ],
};
const now = Date.parse("2026-11-06T18:00:00Z");
const entry: LedgerEntry = { trackId: "song", added: ["dance", "all"], unliked: true, at: "2026-11-06T17:59:00Z" };

test("a recorded sort wins over data that doesn't show it yet, and applying it twice changes nothing", () => {
  const applied = applyLedger(stale, [entry]);
  assert.deepEqual(applied.playlists.map((p) => p.trackIds), [["other", "song"], ["other", "song"]]);
  assert.deepEqual(applied.liked.map((l) => l.id), ["other"]);
  assert.deepEqual(applyLedger(applied, [entry]), applied);
});

test("entries are kept until Spotify shows them, or for a day at most", () => {
  assert.deepEqual(unconfirmed(stale, [entry], now), [entry]);
  assert.deepEqual(unconfirmed(applyLedger(stale, [entry]), [entry], now), []);
  assert.deepEqual(unconfirmed(stale, [entry], now + 25 * 3600_000), []);
});
