// Spotify Web API client shared by Node scripts and the browser app. Each side supplies
// its own way of getting an access token.

const API = "https://api.spotify.com/v1";

type Page<T> = { items: T[]; next: string | null };

export type SpotifyClient = ReturnType<typeof createClient>;

/** Longest Retry-After we sit out quietly; past this Spotify has blocked the app (quota), not throttled it. */
const MAX_WAIT_MS = 60_000;

/** Thrown instead of waiting when Spotify asks us to back off for longer than MAX_WAIT_MS. */
export class SpotifyBlockedError extends Error {
  constructor(readonly until: number) {
    super(`Spotify has blocked this app until ${new Date(until).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })} (rate limit)`);
  }
}

export function createClient(getToken: () => Promise<string>) {
  // After a 429 every request waits until this time (ms since epoch), so callers that keep
  // asking (pollers) don't each retry on their own and keep the rate limit going.
  let pausedUntil = 0;

  /** Sends a request to an API path or full URL, retrying on 429 and transient 5xx. */
  async function request<T>(method: string, pathOrUrl: string, body?: unknown): Promise<T> {
    const url = pathOrUrl.startsWith("http") ? pathOrUrl : `${API}${pathOrUrl}`;
    for (let attempt = 0; ; attempt++) {
      const wait = pausedUntil - Date.now();
      if (wait > MAX_WAIT_MS) throw new SpotifyBlockedError(pausedUntil);
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      const res = await fetch(url, {
        method,
        headers: {
          Authorization: `Bearer ${await getToken()}`,
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      if (res.ok) {
        // Some player endpoints reply with plain text (e.g. a snapshot id) or nothing at all.
        const isJson = res.headers.get("content-type")?.includes("json");
        const text = await res.text();
        return (isJson && text ? JSON.parse(text) : undefined) as T;
      }
      const retryable = res.status === 429 || res.status >= 500;
      if (!retryable || attempt >= 5) throw new Error(`${method} ${url} -> ${res.status} ${await res.text()}`);
      const backoff = Number(res.headers.get("retry-after") ?? 2 ** attempt) * 1000;
      if (res.status === 429) {
        pausedUntil = Math.max(pausedUntil, Date.now() + backoff);
        if (backoff > MAX_WAIT_MS) throw new SpotifyBlockedError(pausedUntil);
      } else await new Promise((r) => setTimeout(r, backoff));
    }
  }

  /** Follows `next` links and returns every item of a paged endpoint. */
  async function getAll<T>(path: string): Promise<T[]> {
    const items: T[] = [];
    for (let next: string | null = path; next; ) {
      const page: Page<T> = await request<Page<T>>("GET", next);
      items.push(...page.items);
      next = page.next;
    }
    return items;
  }

  return {
    request,
    getAll,
    get: <T>(path: string) => request<T>("GET", path),
    /** True while Spotify has asked us to back off; optional requests (polls) should skip. */
    limited: () => Date.now() < pausedUntil,
  };
}

/** Splits into chunks of `size` (Spotify write endpoints take at most 50–100 items). */
export const chunks = <T>(items: T[], size: number): T[][] =>
  Array.from({ length: Math.ceil(items.length / size) }, (_, i) => items.slice(i * size, (i + 1) * size));

/** Adds tracks to a playlist in batches of 100. */
export async function addToPlaylist(client: SpotifyClient, playlistId: string, trackIds: string[]) {
  for (const batch of chunks(trackIds, 100)) {
    await client.request("POST", `/playlists/${playlistId}/tracks`, { uris: batch.map((id) => `spotify:track:${id}`) });
  }
}

/** Removes tracks from a playlist (all occurrences) in batches of 100. */
export async function removeFromPlaylist(client: SpotifyClient, playlistId: string, trackIds: string[]) {
  for (const batch of chunks(trackIds, 100)) {
    await client.request("DELETE", `/playlists/${playlistId}/tracks`, {
      tracks: batch.map((id) => ({ uri: `spotify:track:${id}` })),
    });
  }
}

/** Creates a private playlist for the current user. */
export const createPlaylist = (client: SpotifyClient, name: string) =>
  client.request<{ id: string; name: string }>("POST", "/me/playlists", { name, public: false });

export async function setLiked(client: SpotifyClient, trackIds: string[], liked: boolean) {
  for (const batch of chunks(trackIds, 50)) {
    await client.request(liked ? "PUT" : "DELETE", `/me/tracks?ids=${batch.join(",")}`);
  }
}
