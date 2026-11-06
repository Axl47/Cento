// Spotify Web API client shared by Node scripts and the browser app. Each side supplies
// its own way of getting an access token.

const API = "https://api.spotify.com/v1";

type Page<T> = { items: T[]; next: string | null };

export type SpotifyClient = ReturnType<typeof createClient>;

export function createClient(getToken: () => Promise<string>) {
  /** Sends a request to an API path or full URL, retrying on 429 and transient 5xx. */
  async function request<T>(method: string, pathOrUrl: string, body?: unknown): Promise<T> {
    const url = pathOrUrl.startsWith("http") ? pathOrUrl : `${API}${pathOrUrl}`;
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(url, {
        method,
        headers: {
          Authorization: `Bearer ${await getToken()}`,
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      if (res.ok) {
        const text = await res.text();
        return (text ? JSON.parse(text) : undefined) as T;
      }
      const retryable = res.status === 429 || res.status >= 500;
      if (!retryable || attempt >= 5) throw new Error(`${method} ${url} -> ${res.status} ${await res.text()}`);
      const wait = Number(res.headers.get("retry-after") ?? 2 ** attempt) * 1000;
      await new Promise((r) => setTimeout(r, wait));
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

export async function setLiked(client: SpotifyClient, trackIds: string[], liked: boolean) {
  for (const batch of chunks(trackIds, 50)) {
    await client.request(liked ? "PUT" : "DELETE", `/me/tracks?ids=${batch.join(",")}`);
  }
}
