import assert from "node:assert/strict";
import { appendFile, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, test } from "node:test";
import { createSegueStore } from "./segue.ts";

// Temp files only; the backup is a stub, so the storage box is never touched.

let file: string;
let backups: number;

const store = (append?: typeof appendFile) => createSegueStore({ file, backup: async () => void backups++, ...(append && { append }) });
const lines = async () => (await readFile(file, "utf8")).split("\n").filter(Boolean).map((l) => JSON.parse(l) as { event_id: string });
const event = (id: string, extra = {}) => ({ type: "play", event_id: id, at: "2026-11-20T10:00:00-04:00", key: "I", heard: 40, ended: "next", ...extra });

beforeEach(async () => {
  backups = 0;
  file = join(await mkdtemp(join(tmpdir(), "cento-segue-")), "segue.jsonl");
});

test("stores each event once, verbatim, across resends, duplicates in one batch and restarts", async () => {
  const first = store();
  assert.equal(await first.add([event("a", { unknown_field: [1] }), event("b"), event("a")]), 2);
  assert.equal(await first.add([event("b"), event("c")]), 1);
  assert.equal(await store().add([event("a"), event("c"), { type: "someday", event_id: "d" }]), 1, "a restart rebuilds the seen ids from the file");
  assert.deepEqual(await lines(), [event("a", { unknown_field: [1] }), event("b"), event("c"), { type: "someday", event_id: "d" }]);
  assert.equal(await store().add([{ type: "play" }, "junk"]), 0, "events without an id can't be deduplicated and aren't stored");
});

test("concurrent resends of one batch store it once", async () => {
  const s = store();
  const counts = await Promise.all([s.add([event("a")]), s.add([event("a")])]);
  assert.deepEqual(counts.toSorted(), [0, 1]);
  assert.equal((await lines()).length, 1);
});

test("a half-written line is ended before the next write, and its event can be stored again", async () => {
  const broken = `{"type":"play","event_id":"b","at`;
  await writeFile(file, `${JSON.stringify(event("a"))}\n${broken}`);
  assert.equal(await store().add([event("a"), event("b")]), 1);
  assert.equal(await readFile(file, "utf8"), `${JSON.stringify(event("a"))}\n${broken}\n${JSON.stringify(event("b"))}\n`);
});

test("a failed write is retried in full on the next add, and only play events are kept for counting", async () => {
  let fail = true;
  const s = store(async (path, data) => {
    if (fail) throw new Error("disk full");
    return appendFile(path, data);
  });
  await assert.rejects(s.add([event("a")]));
  fail = false;
  assert.equal(await s.add([event("a"), { type: "mark", event_id: "m" }]), 2);
  assert.deepEqual((await s.plays()).map((p) => (p as { event_id: string }).event_id), ["a"]);
});

test("backs up only when something new was stored", async () => {
  const s = store();
  await s.start();
  await s.backUp();
  assert.equal(backups, 0);
  await s.add([event("a")]);
  await s.backUp();
  await s.backUp();
  assert.equal(backups, 1);
});
