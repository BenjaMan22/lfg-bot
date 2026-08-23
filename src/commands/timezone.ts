import { SlashCommandBuilder, type ChatInputCommandInteraction } from "discord.js";
import type { AppContext } from "../context.js";
import { getTimezone } from "../db/repos/users.js";
import { timezonePrompt } from "../discord/timezonePicker.js";

export const data = new SlashCommandBuilder()
  .setName("timezone")
  .setDescription("Set the timezone your game night times are shown in");

export async function execute(
  interaction: ChatInputCommandInteraction,
  ctx: AppContext,
): Promise<void> {
  const current = getTimezone(ctx.db, interaction.user.id);
  await interaction.reply(
    timezonePrompt(current ? `You are currently set to **${current}**.` : "Pick your timezone."),
  );
}
