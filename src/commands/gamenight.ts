import {
  MessageFlags,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
} from "discord.js";
import { DateTime } from "luxon";
import type { AppContext } from "../context.js";
import { listGames } from "../db/repos/games.js";
import { requireTimezone } from "../discord/timezonePicker.js";
import { buildGameNightCreateModal } from "../interactions/gamenightCreate.js";

// No cancel subcommand: a channel can run several game nights at once, so
// "cancel this channel's night" has no single answer. The trash can on each
// poll cancels exactly that one.
export const data = new SlashCommandBuilder()
  .setName("gamenight")
  .setDescription("Plan a game night")
  .addSubcommand((s) => s.setName("ping").setDescription("Check the bot is alive"))
  .addSubcommand((s) => s.setName("create").setDescription("Start a game night poll"));

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

  const tz = await requireTimezone(interaction, ctx);
  if (!tz) return;

  // Checked before the modal, not inside its handler: the modal now carries
  // the game picker, and Discord rejects a select menu with zero options —
  // so an empty library has to be caught while there is still a reply to
  // make, rather than throwing when the modal is built.
  const library = listGames(ctx.db, interaction.guildId);
  if (library.length === 0) {
    await interaction.reply({
      content: "The game library is empty. Add a few with `/games add` first.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await interaction.showModal(buildGameNightCreateModal(library, tz, DateTime.now()));
}
