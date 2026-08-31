import {
  MessageFlags,
  PermissionFlagsBits,
  type RepliableInteraction,
} from "discord.js";
import type { AppContext } from "../context.js";
import { cancelNight, type NightRow } from "../db/repos/nights.js";
import { deleteScheduledEvent } from "../discord/events.js";
import { renderNightNow } from "../discord/updateQueue.js";

/**
 * Shared by `/gamenight cancel` and the poll's trash-can button, so the two
 * paths to the same action can't drift apart. `interaction` is typed as
 * `RepliableInteraction` — the same interface `requireTimezone` uses — since
 * both a slash command and a button interaction satisfy it identically.
 */
export async function performCancel(
  interaction: RepliableInteraction,
  ctx: AppContext,
  night: NightRow,
): Promise<void> {
  const isModerator =
    interaction.memberPermissions?.has(PermissionFlagsBits.ManageEvents) ?? false;
  if (night.hostId !== interaction.user.id && !isModerator) {
    await interaction.reply({
      content: "Only the host or someone with Manage Events can cancel this.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  cancelNight(ctx.db, night.id);

  // Answer before the Discord round trips, not after. The cancellation is
  // already committed, so a slow event delete or a re-render of a poll whose
  // message was deleted must not cost the canceller their confirmation — and
  // past three seconds the reply would fail outright, reading as if the
  // action broke when it had in fact worked.
  await interaction.reply({ content: "Cancelled.", flags: MessageFlags.Ephemeral });

  // Best-effort tidying. Failing here must not surface as the router's
  // generic error on top of a "Cancelled." the user already has.
  try {
    if (night.eventId) {
      await deleteScheduledEvent(interaction.client, night.guildId, night.eventId);
    }
    await renderNightNow(interaction.client, ctx.db, night.id);
  } catch (error) {
    console.error("Cancelled, but could not finish tidying up", {
      nightId: night.id,
      error,
    });
  }
}
