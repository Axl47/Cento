import assert from "node:assert/strict";
import { test } from "node:test";

// The module reads data/refresh.json relative to the working directory; keep it away from the real one.
const { mkdtemp, realpath } = await import("node:fs/promises");
const { tmpdir } = await import("node:os");
const { join } = await import("node:path");
process.chdir(await realpath(await mkdtemp(join(tmpdir(), "cento-refresh-"))));
const { isDue } = await import("./refresh.ts");

const at = (day: string, time: string) => new Date(`${day}T${time}`); // local time

test("the refresh is due once a day from 12:01 AM, and retried an hour after a failure", () => {
  assert.equal(isDue({}, at("2026-11-12", "00:00:30")), false);
  assert.equal(isDue({}, at("2026-11-12", "00:01:00")), true);
  assert.equal(isDue({ lastDay: "2026-11-12" }, at("2026-11-12", "18:00")), false);
  assert.equal(isDue({ lastDay: "2026-11-11" }, at("2026-11-12", "09:00")), true);
  const failed = { lastDay: "2026-11-11", lastAttempt: at("2026-11-12", "00:01").toISOString(), error: "offline" };
  assert.equal(isDue(failed, at("2026-11-12", "00:30")), false);
  assert.equal(isDue(failed, at("2026-11-12", "01:02")), true);
});
