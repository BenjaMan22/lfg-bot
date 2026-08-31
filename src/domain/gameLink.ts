export class GameLinkError extends Error {}

/**
 * A game's link is free text a host types into a modal, not a value Discord
 * validates for us. Empty (or whitespace-only) input means "no link" — the
 * field is optional. Anything else must be a real http(s) URL, or the host
 * gets a message that reads as help, not a stack trace.
 */
export function parseGameLink(input: string): string | null {
  const trimmed = input.trim();
  if (trimmed === "") return null;

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new GameLinkError(
      `"${trimmed}" doesn't look like a link. It should start with http:// or https://.`,
    );
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new GameLinkError(
      `"${trimmed}" doesn't look like a link. It should start with http:// or https://.`,
    );
  }
  return trimmed;
}
