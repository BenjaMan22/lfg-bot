/**
 * Steam's storefront search, used to suggest real game titles while a host
 * types `/games add`.
 *
 * This is the bot's only dependency on anything outside Discord, so it is
 * built to fail quietly: a search that errors, times out, or comes back in an
 * unfamiliar shape yields no suggestions, and the host types the name
 * themselves exactly as before. Nothing here is ever allowed to throw into an
 * interaction handler.
 */

/** One Steam title, reduced to the two fields the library actually stores. */
export interface SteamGame {
  appid: number;
  name: string;
}

/** Discord accepts at most 25 autocomplete choices. */
export const MAX_SUGGESTIONS = 25;

/** How long a search may take before we give up and suggest nothing. */
const SEARCH_TIMEOUT_MS = 2000;

/**
 * The store search endpoint. Undocumented — Steam publishes no official
 * search API — so it is treated as best-effort: see the failure handling in
 * `searchSteam`. The documented alternative, ISteamApps/GetAppList, returns
 * every app ever published (soundtracks, DLC, dedicated servers) with no
 * ranking, which makes for far worse suggestions.
 */
const SEARCH_URL = "https://store.steampowered.com/api/storesearch/";

export function steamStoreUrl(appid: number): string {
  return `https://store.steampowered.com/app/${appid}/`;
}

/**
 * Pull the usable hits out of a search response. Written defensively against
 * the raw JSON rather than a declared type, because the endpoint is
 * undocumented and may change shape without notice.
 */
export function parseSearchResults(body: unknown): SteamGame[] {
  if (typeof body !== "object" || body === null) return [];
  const items = (body as { items?: unknown }).items;
  if (!Array.isArray(items)) return [];

  const games: SteamGame[] = [];
  for (const item of items) {
    if (typeof item !== "object" || item === null) continue;
    const { id, name } = item as { id?: unknown; name?: unknown };
    if (typeof id !== "number" || !Number.isInteger(id)) continue;
    if (typeof name !== "string" || name.trim() === "") continue;
    games.push({ appid: id, name: name.trim() });
    if (games.length === MAX_SUGGESTIONS) break;
  }
  return games;
}

/**
 * Autocomplete sends back an option *value*, not the label the host saw. A
 * Steam pick therefore travels as its appid, so the handler can rebuild the
 * store link without a second lookup — while a name the host simply typed
 * travels as itself, since autocomplete only ever suggests and never
 * constrains what may be submitted.
 */
/** Discord's hard limit on an application command option value. */
const OPTION_VALUE_LIMIT = 100;

export function encodeGamePick(game: SteamGame): string {
  const prefix = `steam:${game.appid}:`;
  // The name rides along so the modal can prefill it without a second lookup.
  // Truncating only shortens a prefilled field the host can still edit, which
  // is a far better failure than exceeding the limit and having Discord
  // reject the whole choice.
  return `${prefix}${game.name}`.slice(0, OPTION_VALUE_LIMIT);
}

export type GamePick =
  | { kind: "steam"; appid: number; name: string }
  | { kind: "name"; name: string };

export function decodeGamePick(value: string): GamePick {
  // Split on the first two colons only, so a title like "Half-Life: Alyx"
  // survives intact.
  const match = /^steam:(\d+):(.+)$/s.exec(value);
  if (match) return { kind: "steam", appid: Number(match[1]), name: match[2] };
  return { kind: "name", name: value };
}

/**
 * Search Steam for `query`. Returns [] on any failure — a timeout, a non-200,
 * malformed JSON, or no network at all — because autocomplete has a hard
 * three-second budget and no way to show an error.
 */
export async function searchSteam(
  query: string,
  fetchImpl: typeof fetch = fetch,
): Promise<SteamGame[]> {
  const term = query.trim();
  if (term === "") return [];

  const url = `${SEARCH_URL}?term=${encodeURIComponent(term)}&l=en&cc=us`;
  try {
    const response = await fetchImpl(url, {
      signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
      headers: { accept: "application/json" },
    });
    if (!response.ok) return [];
    return parseSearchResults(await response.json());
  } catch {
    // Deliberately silent at debug level: a host typing fast produces a
    // cancelled request per keystroke, and logging each one would bury the
    // failures that matter.
    return [];
  }
}
