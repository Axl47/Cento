// Who may use the host. The Mac itself always may; anything else on the network needs the password,
// set from the Mac. Being signed in is a cookie derived from the password's hash, so changing the
// password signs every device out.
import { createHmac, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import { promisify } from "node:util";

const AUTH_FILE = "data/host-auth.json";
const COOKIE = "now_session";
const COOKIE_DAYS = 365;
const KEY_BYTES = 64;
const derive = promisify(scrypt) as (password: string, salt: string, length: number) => Promise<Buffer>;

export type Secret = { salt: string; hash: string };

export const newSecret = async (password: string): Promise<Secret> => {
  const salt = randomBytes(16).toString("hex");
  return { salt, hash: (await derive(password, salt, KEY_BYTES)).toString("hex") };
};

const same = (a: Buffer, b: Buffer) => a.length === b.length && timingSafeEqual(a, b);

export const passwordMatches = async (secret: Secret, password: string) => same(await derive(password, secret.salt, KEY_BYTES), Buffer.from(secret.hash, "hex"));

const sessionFor = (secret: Secret) => createHmac("sha256", secret.hash).update("screen-session").digest("hex");

export const sessionCookie = (secret: Secret) => `${COOKIE}=${sessionFor(secret)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${COOKIE_DAYS * 86_400}`;

export function hasSession(secret: Secret | null, cookieHeader: string | undefined) {
  if (!secret) return false;
  const sent = cookieHeader?.split(/;\s*/).find((c) => c.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1);
  return !!sent && same(Buffer.from(sent), Buffer.from(sessionFor(secret)));
}

const LOOPBACK_ADDRESSES = ["127.0.0.1", "::1", "::ffff:127.0.0.1"];
const LOOPBACK_NAMES = ["127.0.0.1", "localhost"];

/** A request from this Mac. The Host check stops a web page from reaching the host by pointing its own domain at 127.0.0.1. */
export function isLocal(req: Pick<IncomingMessage, "socket" | "headers">) {
  const name = req.headers.host?.replace(/:\d+$/, "");
  return LOOPBACK_ADDRESSES.includes(req.socket.remoteAddress ?? "") && !!name && LOOPBACK_NAMES.includes(name);
}

export async function readSecret(): Promise<Secret | null> {
  try {
    return JSON.parse(await readFile(AUTH_FILE, "utf8")) as Secret;
  } catch {
    return null;
  }
}

export const saveSecret = (secret: Secret) => writeFile(AUTH_FILE, JSON.stringify(secret), { mode: 0o600 });
