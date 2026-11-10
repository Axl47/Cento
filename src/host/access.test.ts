import assert from "node:assert/strict";
import { test } from "node:test";
import type { IncomingMessage } from "node:http";
import { hasSession, isLocal, newSecret, passwordMatches, sessionCookie } from "./access.ts";

const cookieValue = (header: string) => header.split(";")[0]!;

test("only the right password matches", async () => {
  const secret = await newSecret("hunter22");

  assert.equal(await passwordMatches(secret, "hunter22"), true);
  assert.equal(await passwordMatches(secret, "hunter2"), false);
});

test("changing the password signs devices out", async () => {
  const first = await newSecret("one");
  const second = await newSecret("two");
  const cookie = cookieValue(sessionCookie(first));

  assert.equal(hasSession(first, `other=1; ${cookie}`), true);
  assert.equal(hasSession(second, cookie), false);
  assert.equal(hasSession(null, cookie), false);
  assert.equal(hasSession(first, undefined), false);
});

const request = (remoteAddress: string, host: string) => ({ socket: { remoteAddress }, headers: { host } }) as unknown as IncomingMessage;

test("local means this machine, addressed as itself", () => {
  assert.equal(isLocal(request("127.0.0.1", "127.0.0.1:3001")), true);
  assert.equal(isLocal(request("::ffff:127.0.0.1", "localhost:3000")), true);
  assert.equal(isLocal(request("192.168.1.20", "127.0.0.1:3001")), false);
  assert.equal(isLocal(request("127.0.0.1", "evil.example:3001")), false);
});
