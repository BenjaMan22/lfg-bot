import {
  MessageFlags,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
} from "discord.js";
import type { AppContext } from "../context.js";
import { getCancellableNightForChannel, getOpenNightForChannel } from "../db/repos/nights.js";
import { requireTimezone } from "../discord/timezonePicker.js";
import { buildGameNightCreateModal } from "../interactions/gamenightCreate.js";
import { messageLink } from "../interactions/setup.js";
import { performCancel } from "../nights/cancel.js";

export const data = new SlashCommandBuilder()
  .setName("gamenight")
  .setDescription("Plan a game night")
  .addSubcommand((s) => s.setName("ping").setDescription("Check the bot is alive"))
  .addSubcommand((s) => s.setName("create").setDescription("Start a game night poll"))
  .addSubcommand((s) =>
    s.setName("cancel").setDescription("Cancel this channel's open game night"),
  );

export async function execute(
  interaction: ChatInputCommandInteraction,
  ctx: AppContext,
): Promise<void> {
  if (interaction.options.getSubcommand() === "ping") {
    await interaction.reply({
      content: `Alive. Round trip ${Date.now() - interaction.createdTimestamp}ms.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (!interaction.guildId || !interaction.channelId) {
    await interaction.reply({
      content: "Game nights only work inside a server channel.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (interaction.options.getSubcommand() === "cancel") {
    // Open or locked: a locked night still has a live Scheduled Event and
    // roster to retract, so it must stay cancellable too.
    const night = getCancellableNightForChannel(
      ctx.db,
      interaction.channelId,
      Math.floor(Date.now() / 1000),
    );
    if (!night) {
      await interaction.reply({
        content: "No open game night in this channel.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    await performCancel(interaction, ctx, night);
    return;
  }

  const existing = getOpenNightForChannel(ctx.db, interaction.channelId);
  if (existing) {
    await interaction.reply({
      content: `This channel already has an open game night: ${messageLink(interaction.guildId, interaction.channelId, existing.messageId)}\nFinish or \`/gamenight cancel\` that one first.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const tz = await requireTimezone(interaction, ctx);
  if (!tz) return;

  await interaction.showModal(buildGameNightCreateModal());
}
