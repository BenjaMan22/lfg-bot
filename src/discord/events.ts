import { GuildScheduledEventEntityType, GuildScheduledEventPrivacyLevel, type Client } from "discord.js";
import type { Suggestion } from "../domain/scheduling.js";
import type { NightRow } from "../db/repos/nights.js";

/** Discord's hard limit on a Scheduled Event's name. */
const EVENT_NAME_LIMIT = 100;

/**
 * `night.title` (up to 80 characters, host-chosen) and `suggestion.game.name`
 * have no combined length cap, so their concatenation can exceed Discord's
 * 100-character Scheduled Event name limit — which the API rejects outright
 * rather than truncating for us.
 */
export function eventName(night: Pick<NightRow, "title">, suggestion: Suggestion): string {
  const full = `${night.title}: ${suggestion.game.name}`;
  if (full.length <= EVENT_NAME_LIMIT) return full;
  return `${full.slice(0, EVENT_NAME_LIMIT - 1)}…`;
}

/**
 * Discord rejects a Scheduled Event whose start time is already in the past.
 * A night can lock late enough for that to happen — a slow sweep tick, a
 * stretch of infra retries — so this must be checked before ever attempting
 * creation, not discovered as an API error.
 */
export function hasAlreadyStarted(suggestion: Suggestion, nowUtc: number): boolean {
  return suggestion.startUtc <= nowUtc;
}

export async function createScheduledEvent(
  client: Client,
  night: NightRow,
  suggestion: Suggestion,
  nowUtc: number = Math.floor(Date.now() / 1000),
): Promise<string | null> {
  if (hasAlreadyStarted(suggestion, nowUtc)) {
    console.error("Skipping scheduled event: its window has already started", {
      nightId: night.id,
      startUtc: suggestion.startUtc,
      nowUtc,
    });
    return null;
  }

  const base = {
    name: eventName(night, suggestion),
    scheduledStartTime: new Date(suggestion.startUtc * 1000),
    scheduledEndTime: new Date(suggestion.endUtc * 1000),
    privacyLevel: GuildScheduledEventPrivacyLevel.GuildOnly,
    description: `Auto-scheduled from the game night poll. ${suggestion.roster.length} players.`,
  };

  try {
    // Inside the try: a transient fetch failure (rate limit, a 5xx, the bot
    // having been removed from the guild) must not lose the decision either.
    const guild = await client.guilds.fetch(night.guildId);
    const event = night.voiceChannelId
      ? await guild.scheduledEvents.create({
          ...base,
          entityType: GuildScheduledEventEntityType.Voice,
          channel: night.voiceChannelId,
        })
      : await guild.scheduledEvents.create({
          ...base,
          entityType: GuildScheduledEventEntityType.External,
          // External events require a location and an end time.
          entityMetadata: { location: suggestion.game.name },
        });
    return event.id;
  } catch (error) {
    // A missing Manage Events permission must not lose the decision itself.
    console.error("Could not create scheduled event", { nightId: night.id, error });
    return null;
  }
}

export async function deleteScheduledEvent(
  client: Client,
  guildId: string,
  eventId: string,
): Promise<void> {
  try {
    const guild = await client.guilds.fetch(guildId);
    await guild.scheduledEvents.delete(eventId);
  } catch (error) {
    console.error("Could not delete scheduled event", { eventId, error });
  }
}
