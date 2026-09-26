export class PlayerCountError extends Error {}

/**
 * Read the only player count a game still has: its maximum. Blank means any
 * number — the host should never be blocked on a number they have no opinion
 * about.
 */
export function parseMaxPlayers(text: string): number | null {
  const trimmed = text.trim();
  if (trimmed === "") return null;

  const max = Number(trimmed);
  if (!Number.isInteger(max) || max < 1) {
    throw new PlayerCountError(
      `"${trimmed}" has to be a whole number of players, or blank for any number.`,
    );
  }
  return max;
}

/** How a game's size reads everywhere a game is listed. */
export function playerCountLabel(maxPlayers: number | null): string {
  if (maxPlayers === null) return "any number of players";
  return maxPlayers === 1 ? "1 player" : `up to ${maxPlayers} players`;
}
