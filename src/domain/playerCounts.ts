export class PlayerCountError extends Error {}

/**
 * What a game's minimum becomes when nobody supplies one.
 *
 * 1, deliberately. The minimum is the engine's quorum — a combination is
 * viable once the roster reaches it — so this means one interested person is
 * enough to put a night on the calendar. That is the intent: an evening
 * should not fail to schedule just because nobody else has answered yet, and
 * whoever set it up is usually happy to play regardless. A game that
 * genuinely needs a group still says so by carrying its own minimum.
 */
export const DEFAULT_MIN_PLAYERS = 1;

/**
 * Read the player counts off an add-a-game modal.
 *
 * Both fields are optional: whoever is setting up a night should never be
 * blocked on a number they have no opinion about. A supplied value is still
 * honoured and still validated, so a group that does care can say Deep Rock
 * wants four.
 */
export function parsePlayerCounts(
  minText: string,
  maxText: string,
): { min: number; max: number | null } {
  const minTrimmed = minText.trim();
  const maxTrimmed = maxText.trim();

  const min = minTrimmed === "" ? DEFAULT_MIN_PLAYERS : Number(minTrimmed);
  if (!Number.isInteger(min) || min < 1) {
    throw new PlayerCountError(
      `"${minTrimmed}" is not a whole number of players. Leave it blank and I'll assume ${DEFAULT_MIN_PLAYERS}.`,
    );
  }

  if (maxTrimmed === "") return { min, max: null };

  const max = Number(maxTrimmed);
  if (!Number.isInteger(max) || max < min) {
    throw new PlayerCountError(
      `"${maxTrimmed}" has to be a whole number no smaller than ${min}, or blank for unlimited.`,
    );
  }
  return { min, max };
}

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
