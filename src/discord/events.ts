import { GuildScheduledEventEntityType, GuildScheduledEventPrivacyLevel, type Client } from "discord.js";
import type { Suggestion } from "../domain/scheduling.js";
import type { NightRow } from "../db/repos/nights.js";

export async function createScheduledEvent(
  client: Client,
  night: NightRow,
  suggestion: Suggestion,
): Promise<string | null> {
  const base = {
    name: `${night.title}: ${suggestion.game.name}`,
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
