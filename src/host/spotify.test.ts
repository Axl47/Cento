import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

// The module loads and writes data/spotify-token.json relative to the working directory, so this file must
// move to a throwaway folder before importing it. A static import would run first and read the real login.
const sandbox = await realpath(await mkdtemp(join(tmpdir(), "cento-token-")));
process.chdir(sandbox);
assert.equal(process.cwd(), sandbox);

const TOKEN_FILE = "data/spotify-token.json";
const expired = JSON.stringify({ accessToken: "old", refreshToken: "refresh", expiresAt: 0 });
await mkdir("data");
await writeFile(TOKEN_FILE, expired);

globalThis.fetch = (async () => new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 })) as typeof fetch;

const { freshToken, spotify } = await import("./spotify.ts");
const { createRecorder } = await import("./history.ts");

test("a refused token refresh reports the login problem and keeps the stored token", async () => {
  await assert.rejects(freshToken(), /log in/);
  assert.equal(await readFile(TOKEN_FILE, "utf8"), expired);
});

test("a failed history poll through the host's client keeps the stored token", async () => {
  let backups = 0;
  const history = createRecorder(spotify, { file: "data/h.jsonl", gapsFile: "data/g.jsonl", backup: async () => void backups++ });
  const log = console.error;
  console.error = () => {};
  try {
    await history.poll();
  } finally {
    console.error = log;
  }
  assert.match(history.status.error ?? "", /log in/);
  assert.equal(backups, 0);
  assert.equal(await readFile(TOKEN_FILE, "utf8"), expired);
});
