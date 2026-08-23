import { MessageFlags, type Interaction } from "discord.js";
import type { AppContext } from "../context.js";
import { commandsByName } from "../commands/index.js";

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
    // Component and modal handlers are registered in later tasks.
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
