import assert from "node:assert/strict";
import { test } from "node:test";
import { dropSong, groupsOf, merged, moveSong, replaceGroup, savedIds, signature, synced, updateGroup, type Split } from "./workshop.ts";

const split = (lists: string[][]): Split => ({ by: "sound", k: lists.length, groups: groupsOf(lists), unplaced: [] });

test("splitting a group puts its halves in its place and leaves the other groups as they were", () => {
  const s = split([["a", "b"], ["c", "d"], ["e"]]);
  const named = updateGroup(s, s.groups[2]!.key, () => ({ name: "Kept", savedAs: "sent" }));
  const next = replaceGroup(named, named.groups[1]!.key, [["c"], ["d"]]);

  assert.deepEqual(next.groups.map((g) => g.ids), [["a", "b"], ["c"], ["d"], ["e"]]);
  assert.deepEqual(next.groups.map((g) => g.name), [null, null, null, "Kept"]);
  assert.equal(next.groups[3]!.savedAs, "sent");
  assert.equal(new Set(next.groups.map((g) => g.key)).size, 4);
});

test("dropping a group's last song drops the group", () => {
  const s = split([["a", "b"], ["c"]]);
  const next = updateGroup(s, s.groups[1]!.key, (g) => ({ ids: g.ids.filter((id) => id !== "c") }));

  assert.deepEqual(next.groups.map((g) => g.ids), [["a", "b"]]);
});

test("songs that left the playlist leave their groups, and a split nothing left stays the same object", () => {
  const s = { ...split([["a", "b"], ["c"]]), unplaced: ["d"] };
  const members = new Set(["a", "d"]);
  const next = synced(s, (id) => members.has(id), () => true);

  assert.deepEqual(next.groups.map((g) => g.ids), [["a"]]);
  assert.deepEqual(next.unplaced, ["d"]);
  assert.equal(synced(s, () => true, () => true), s);
});

test("a group whose saved playlist was deleted can be saved again as a new one", () => {
  const s = split([["a"], ["b"]]);
  const saved = updateGroup(updateGroup(s, s.groups[0]!.key, () => ({ playlistId: "gone", savedAs: "x" })), s.groups[1]!.key, () => ({ playlistId: "here", savedAs: "y" }));
  const next = synced(saved, () => true, (id) => id === "here");

  assert.deepEqual(next.groups.map((g) => [g.playlistId, g.savedAs]), [[undefined, undefined], ["here", "y"]]);
});

test("saving a group again keeps what its playlist gained elsewhere and doesn't bring back what it lost", () => {
  const saved = savedIds(signature("Name", ["a", "b", "c"]));
  assert.deepEqual(saved, ["a", "b", "c"]);
  // Since the save: "b" was dropped from the group and "d" dragged in; elsewhere the playlist lost "c" and gained "e".
  assert.deepEqual(merged(["d", "a", "c"], saved, ["a", "b", "e"]), ["d", "a", "e"]);
});

test("a song dropped from its group is left in no group", () => {
  const s = split([["a", "b"], ["c"]]);
  const next = dropSong(s, "c");

  assert.deepEqual(next.groups.map((g) => g.ids), [["a", "b"]]);
  assert.deepEqual(next.unplaced, ["c"]);
});

test("a song moved to another group leads it, and the group it emptied is dropped", () => {
  const s = split([["a", "b"], ["c"], ["d"]]);
  const next = moveSong(s, "c", s.groups[0]!.key);

  assert.deepEqual(next.groups.map((g) => g.ids), [["c", "a", "b"], ["d"]]);
  assert.equal(moveSong(next, "c", next.groups[0]!.key), next);

  const taken = moveSong({ ...next, unplaced: ["x", "y"] }, "x", next.groups[1]!.key);
  assert.deepEqual([taken.groups[1]!.ids, taken.unplaced], [["x", "d"], ["y"]]);
});
