import { MessageFlags, type Interaction } from "discord.js";
import type { AppContext } from "../context.js";
import { commandsByName } from "../commands/index.js";
import {
  handleTimezoneModal,
  handleTimezoneOtherButton,
  handleTimezoneSelect,
} from "../discord/timezonePicker.js";
import { handlePostButton, handleSetupSelect } from "./setup.js";
import {
  handleAvailabilityButton,
  handleDaySelect,
  handleInButton,
  handleOutButton,
  handleSuggestButton,
  handleSuggestModal,
  handleVotesButton,
  handleVotesSelect,
} from "./respond.js";

export function parseCustomId(id: string): { action: string; args: string[] } {
  const [namespace, action, ...args] = id.split(":");
  if (namespace !== "gn" || !action) {
    return { action: "", args: [] };
  }
  return { action, args };
}

/** Reply with a message the user can act on, whether or not we already deferred. */
async function replyError(interaction: Interaction, message: string): Promise<void> {
  if (!interaction.isRepliable()) return;
  const payload = { content: message, flags: MessageFlags.Ephemeral } as const;
  try {
    if (interaction.deferred || interaction.replied) {
      await interaction.followUp(payload);
    } else {
      await interaction.reply(payload);
    }
  } catch {
    // The interaction token expired (15 minutes) — nothing left to say.
  }
}

export async function routeInteraction(
  interaction: Interaction,
  ctx: AppContext,
): Promise<void> {
  try {
    if (interaction.isChatInputCommand()) {
      const command = commandsByName.get(interaction.commandName);
      if (!command) throw new Error(`Unknown command ${interaction.commandName}`);
      await command.execute(interaction, ctx);
      return;
    }
    if (interaction.isStringSelectMenu()) {
      const { action, args } = parseCustomId(interaction.customId);
      if (action === "tz") return await handleTimezoneSelect(interaction, ctx);
      if (action === "setup") return await handleSetupSelect(interaction, ctx, Number(args[0]));
      if (action === "day") {
        return await handleDaySelect(interaction, ctx, Number(args[0]), Number(args[1]));
      }
      if (action === "voteselect") return await handleVotesSelect(interaction, ctx, Number(args[0]));
    }
    if (interaction.isButton()) {
      const { action, args } = parseCustomId(interaction.customId);
      if (action === "tzother") return await handleTimezoneOtherButton(interaction);
      if (action === "post") return await handlePostButton(interaction, ctx, Number(args[0]));
      if (action === "setupadd") return await handleSuggestButton(interaction, Number(args[0]));
      if (action === "avail") return await handleAvailabilityButton(interaction, ctx, Number(args[0]));
      if (action === "votes") return await handleVotesButton(interaction, ctx, Number(args[0]));
      if (action === "suggest") return await handleSuggestButton(interaction, Number(args[0]));
      if (action === "out") return await handleOutButton(interaction, ctx, Number(args[0]));
      if (action === "in") return await handleInButton(interaction, ctx, Number(args[0]));
    }
    if (interaction.isModalSubmit()) {
      const { action, args } = parseCustomId(interaction.customId);
      if (action === "tzmodal") return await handleTimezoneModal(interaction, ctx);
      if (action === "suggestmodal") return await handleSuggestModal(interaction, ctx, Number(args[0]));
    }
  } catch (error) {
    console.error("Interaction failed", {
      id: interaction.id,
      type: interaction.type,
      error,
    });
    await replyError(
      interaction,
      "Something went wrong handling that. It has been logged — try again.",
    );
  }
}
