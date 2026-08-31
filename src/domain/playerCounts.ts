export class PlayerCountError extends Error {}

/**
 * What a game's minimum becomes when nobody supplies one.
 *
 * Deliberately 2, not 1. The minimum is the engine's quorum — a combination
 * is viable when the roster reaches it — so a default of 1 would let a night
 * lock in for a single person who happened to be free. 2 keeps a game night a
 * group activity while still asking nothing of a host who does not care.
 */
export const DEFAULT_MIN_PLAYERS = 2;

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
