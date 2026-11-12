import assert from "node:assert/strict";
import { test } from "node:test";
import { groupsOf, replaceGroup, updateGroup, type Split } from "./workshop.ts";

const split = (lists: string[][]): Split => ({ by: "sound", k: lists.length, groups: groupsOf(lists), unplaced: [] });

test("splitting a group puts its halves in its place and leaves the other groups as they were", () => {
  const s = split([["a", "b"], ["c", "d"], ["e"]]);
  const named = updateGroup(s, s.groups[2]!.key, () => ({ name: "Kept", saved: true }));
  const next = replaceGroup(named, named.groups[1]!.key, [["c"], ["d"]]);

  assert.deepEqual(next.groups.map((g) => g.ids), [["a", "b"], ["c"], ["d"], ["e"]]);
  assert.deepEqual(next.groups.map((g) => g.name), [null, null, null, "Kept"]);
  assert.equal(next.groups[3]!.saved, true);
  assert.equal(new Set(next.groups.map((g) => g.key)).size, 4);
});

test("dropping a group's last song drops the group", () => {
  const s = split([["a", "b"], ["c"]]);
  const next = updateGroup(s, s.groups[1]!.key, (g) => ({ ids: g.ids.filter((id) => id !== "c") }));

  assert.deepEqual(next.groups.map((g) => g.ids), [["a", "b"]]);
});
