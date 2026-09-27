import { SLOT_SECONDS, slotsIn, type NightDay } from "./timeblocks.js";

export interface Game {
  id: number;
  name: string;
  /** The most people the game supports; null means any number. */
  maxPlayers: number | null;
  /**
   * Purely a display field — never read by ranking. Optional so the many
   * `Game` fixtures in tests unrelated to links don't need to carry it;
   * a game loaded from the repository always sets it explicitly.
   */
  link?: string | null;
}

export interface SchedulingInput {
  days: NightDay[];
  minSessionHours: number;
  games: Game[];
  /** userId -> the UTC hours (epoch seconds) they are free. */
  availability: Map<string, Set<number>>;
  /** userId -> the game ids they would play. */
  votes: Map<string, Set<number>>;
}

export interface Suggestion {
  dayIndex: number;
  startUtc: number;
  endUtc: number;
  game: Game;
  roster: string[];
  oversubscribed: boolean;
}

export interface SchedulingResult {
  /**
   * The best suggestions, day-diversified: distinct-day picks are preferred
   * over same-day backfills, so array order is not strictly rank order —
   * a backfilled entry can outrank an earlier distinct-day pick.
   */
  top: Suggestion[];
}

export const MAX_SUGGESTIONS = 3;

/**
 * Picking games without picking times means "I'm in, whenever" — so count
 * that person as free for every slot of every day. Without this they
 * responded but appeared in no range and on no roster.
 *
 * Applied when reading, never stored: picking any times switches them to
 * exactly those, and "I'm out" (which clears their votes) removes them.
 * Returns a new map; the one given is left alone.
 */
export function assumeFreeWhenUnset(
  days: NightDay[],
  availability: Map<string, Set<number>>,
  votes: Map<string, Set<number>>,
): Map<string, Set<number>> {
  const result = new Map(availability);
  for (const [userId, gameIds] of votes) {
    if (gameIds.size > 0 && (availability.get(userId)?.size ?? 0) === 0) {
      result.set(userId, new Set(days.flatMap(slotsIn)));
    }
  }
  return result;
}

/** Runs are measured in half-hour slots; minSessionHours converts into them. */
const SLOTS_PER_HOUR = 3600 / SLOT_SECONDS;

/** Users free for every hour of the run. Partial attendance does not count. */
function freeForAll(
  run: number[],
  availability: Map<string, Set<number>>,
): string[] {
  const users: string[] = [];
  for (const [userId, hours] of availability) {
    if (run.every((hour) => hours.has(hour))) users.push(userId);
  }
  return users;
}

function totalVotes(gameId: number, votes: Map<string, Set<number>>): number {
  let count = 0;
  for (const chosen of votes.values()) if (chosen.has(gameId)) count += 1;
  return count;
}

function compareSuggestions(
  a: Suggestion,
  b: Suggestion,
  voteCounts: Map<number, number>,
): number {
  if (a.roster.length !== b.roster.length) return b.roster.length - a.roster.length;
  const aLength = a.endUtc - a.startUtc;
  const bLength = b.endUtc - b.startUtc;
  if (aLength !== bLength) return bLength - aLength;
  if (a.startUtc !== b.startUtc) return a.startUtc - b.startUtc;
  return (voteCounts.get(b.game.id) ?? 0) - (voteCounts.get(a.game.id) ?? 0);
}

export function rankNight(input: SchedulingInput): SchedulingResult {
  const { days, minSessionHours, games, availability, votes } = input;

  if (minSessionHours < 1) return { top: [] };
  // Availability is stored per half-hour slot, so a 2-hour minimum is a run
  // of 4. The stored value stays in hours: that is the unit a host thinks in,
  // and the conversion belongs here rather than in the database.
  const minSessionSlots = minSessionHours * SLOTS_PER_HOUR;

  const voteCounts = new Map(games.map((g) => [g.id, totalVotes(g.id, votes)]));
  const voters = new Map(
    games.map((g) => [
      g.id,
      new Set(
        [...votes.entries()].filter(([, ids]) => ids.has(g.id)).map(([userId]) => userId),
      ),
    ]),
  );

  const suggestions: Suggestion[] = [];

  for (const day of days) {
    const slots = slotsIn(day);
    for (let start = 0; start < slots.length; start += 1) {
      for (let end = start + minSessionSlots; end <= slots.length; end += 1) {
        const run = slots.slice(start, end);
        const free = freeForAll(run, availability);
        if (free.length === 0) continue;

        const startUtc = run[0];
        const endUtc = run[run.length - 1] + SLOT_SECONDS;

        for (const game of games) {
          const eligible = voters.get(game.id)!;
          const roster = free.filter((userId) => eligible.has(userId));
          // No per-game minimum: one interested person is enough to put a
          // night on the calendar, and whoever set it up is usually happy
          // to play regardless.
          if (roster.length === 0) continue;

          suggestions.push({
            dayIndex: day.dayIndex,
            startUtc,
            endUtc,
            game,
            roster: roster.sort(),
            oversubscribed: game.maxPlayers !== null && roster.length > game.maxPlayers,
          });
        }
      }
    }
  }

  suggestions.sort((a, b) => compareSuggestions(a, b, voteCounts));

  // One entry per (day, game): the sort above already put the best one first.
  const bestPerDayGame: Suggestion[] = [];
  const seen = new Set<string>();
  for (const suggestion of suggestions) {
    const key = `${suggestion.dayIndex}:${suggestion.game.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    bestPerDayGame.push(suggestion);
  }

  // Prefer distinct days, then backfill in rank order if we came up short.
  const top: Suggestion[] = [];
  const usedDays = new Set<number>();
  const skipped: Suggestion[] = [];
  for (const suggestion of bestPerDayGame) {
    if (top.length === MAX_SUGGESTIONS) break;
    if (usedDays.has(suggestion.dayIndex)) {
      skipped.push(suggestion);
      continue;
    }
    usedDays.add(suggestion.dayIndex);
    top.push(suggestion);
  }
  for (const suggestion of skipped) {
    if (top.length === MAX_SUGGESTIONS) break;
    top.push(suggestion);
  }

  return { top };
}
