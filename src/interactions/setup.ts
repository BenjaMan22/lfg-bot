import { MessageFlags, type ButtonInteraction, type StringSelectMenuInteraction } from "discord.js";
import type { AppContext } from "../context.js";
import { getNight, getNightGameIds, publishNight, setNightGames } from "../db/repos/nights.js";
import { buildPollView } from "../discord/updateQueue.js";
import { renderPoll } from "../discord/render.js";

export async function handleSetupSelect(
  interaction: StringSelectMenuInteraction,
  ctx: AppContext,
  nightId: number,
): Promise<void> {
  setNightGames(ctx.db, nightId, interaction.values.map(Number));
  await interaction.deferUpdate();
}

export async function handlePostButton(
  interaction: ButtonInteraction,
  ctx: AppContext,
  nightId: number,
): Promise<void> {
  const night = getNight(ctx.db, nightId);
  if (!night || night.status !== "draft") {
    await interaction.update({ content: "That draft is gone. Run `/gamenight create` again.", components: [] });
    return;
  }
  if (interaction.user.id !== night.hostId) {
    await interaction.reply({ content: "Only the host can post this.", flags: MessageFlags.Ephemeral });
    return;
  }
  if (getNightGameIds(ctx.db, nightId).length === 0) {
    await interaction.reply({
      content: "Pick at least one game — there is nothing to rank otherwise.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const channel = await interaction.client.channels.fetch(night.channelId);
  if (!channel?.isTextBased() || !("send" in channel)) throw new Error("Channel is not sendable");

  const view = await buildPollView(interaction.client, ctx.db, nightId);
  if (!view) throw new Error(`Night ${nightId} vanished`);
  const message = await channel.send(renderPoll(view));
  publishNight(ctx.db, nightId, message.id);

  await interaction.update({ content: "Posted.", components: [] });
}
