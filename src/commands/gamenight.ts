import {
  SlashCommandBuilder,
  MessageFlags,
  type ChatInputCommandInteraction,
} from "discord.js";
import type { AppContext } from "../context.js";

export const data = new SlashCommandBuilder()
  .setName("gamenight")
  .setDescription("Plan a game night")
  .addSubcommand((s) => s.setName("ping").setDescription("Check the bot is alive"));

export async function execute(
  interaction: ChatInputCommandInteraction,
  _ctx: AppContext,
): Promise<void> {
  if (interaction.options.getSubcommand() === "ping") {
    await interaction.reply({
      content: `Alive. Round trip ${Date.now() - interaction.createdTimestamp}ms.`,
      flags: MessageFlags.Ephemeral,
    });
  }
}
