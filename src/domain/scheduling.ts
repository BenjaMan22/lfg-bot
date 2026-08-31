import { hoursIn, type NightDay } from "./timeblocks.js";

export interface Game {
  id: number;
  name: string;
  minPlayers: number;
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

export interface NearMiss {
  dayIndex: number;
  startUtc: number;
  endUtc: number;
  game: Game;
  rosterSize: number;
  shortfall: number;
}

export interface SchedulingResult {
  /**
   * The best suggestions, day-diversified: distinct-day picks are preferred
   * over same-day backfills, so array order is not strictly rank order —
   * a backfilled entry can outrank an earlier distinct-day pick.
   */
  top: Suggestion[];
  nearMisses: NearMiss[];
}

export const MAX_SUGGESTIONS = 3;

const HOUR = 3600;

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

  if (minSessionHours < 1) return { top: [], nearMisses: [] };

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
  const misses: NearMiss[] = [];

  for (const day of days) {
    const hours = hoursIn(day);
    for (let start = 0; start < hours.length; start += 1) {
      for (let end = start + minSessionHours; end <= hours.length; end += 1) {
        const run = hours.slice(start, end);
        const free = freeForAll(run, availability);
        if (free.length === 0) continue;

        const startUtc = run[0];
        const endUtc = run[run.length - 1] + HOUR;

        for (const game of games) {
          const eligible = voters.get(game.id)!;
          const roster = free.filter((userId) => eligible.has(userId));
          if (roster.length === 0) continue;

          if (roster.length >= game.minPlayers) {
            suggestions.push({
              dayIndex: day.dayIndex,
              startUtc,
              endUtc,
              game,
              roster: roster.sort(),
              oversubscribed:
                game.maxPlayers !== null && roster.length > game.maxPlayers,
            });
          } else {
            misses.push({
              dayIndex: day.dayIndex,
              startUtc,
              endUtc,
              game,
              rosterSize: roster.length,
              shortfall: game.minPlayers - roster.length,
            });
          }
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

  misses.sort((a, b) => {
    if (a.shortfall !== b.shortfall) return a.shortfall - b.shortfall;
    if (a.rosterSize !== b.rosterSize) return b.rosterSize - a.rosterSize;
    const aLength = a.endUtc - a.startUtc;
    const bLength = b.endUtc - b.startUtc;
    if (aLength !== bLength) return bLength - aLength;
    return a.startUtc - b.startUtc;
  });
  const bestMisses: NearMiss[] = [];
  const missSeen = new Set<string>();
  for (const miss of misses) {
    const key = `${miss.dayIndex}:${miss.game.id}`;
    if (missSeen.has(key)) continue;
    missSeen.add(key);
    bestMisses.push(miss);
    if (bestMisses.length === MAX_SUGGESTIONS) break;
  }

  return { top, nearMisses: top.length > 0 ? [] : bestMisses };
}
