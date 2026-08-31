import {
  ActionRowBuilder,
  MessageFlags,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  type ModalSubmitInteraction,
} from "discord.js";
import type { AppContext } from "../context.js";
import { addGame, findGameByName } from "../db/repos/games.js";
import { GameLinkError, parseGameLink } from "../domain/gameLink.js";
import { PlayerCountError, parsePlayerCounts } from "../domain/playerCounts.js";

/** Values carried over from a Steam autocomplete pick, if there was one. */
export interface GameAddPrefill {
  name?: string;
  link?: string;
}

export function buildGameAddModal(prefill: GameAddPrefill = {}): ModalBuilder {
  const name = new TextInputBuilder()
    .setCustomId("name")
    .setLabel("Game name")
    .setStyle(TextInputStyle.Short)
    .setMaxLength(80)
    .setRequired(true);
  // Prefilled, not fixed: a Steam title is a starting point the host can edit,
  // and min players — the field ranking actually depends on — is still asked
  // for every time, because Steam does not publish it.
  if (prefill.name) name.setValue(prefill.name.slice(0, 80));

  return new ModalBuilder()
    .setCustomId("gn:gameaddmodal")
    .setTitle("Add a game")
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(name),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("min")
          .setLabel("Fewest players (optional)")
          .setStyle(TextInputStyle.Short)
          .setPlaceholder("Leave blank for 2")
          .setRequired(false),
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("max")
          .setLabel("Most players (optional)")
          .setStyle(TextInputStyle.Short)
          .setRequired(false),
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        (() => {
          const link = new TextInputBuilder()
            .setCustomId("link")
            .setLabel("Link (optional)")
            .setStyle(TextInputStyle.Short)
            .setPlaceholder("https://store.steampowered.com/...")
            .setRequired(false);
          if (prefill.link) link.setValue(prefill.link);
          return link;
        })(),
      ),
    );
}

export async function handleGameAddModal(
  interaction: ModalSubmitInteraction,
  ctx: AppContext,
): Promise<void> {
  const guildId = interaction.guildId;
  if (!guildId) {
    await interaction.reply({
      content: "Game nights only work inside a server.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const name = interaction.fields.getTextInputValue("name").trim();
  const linkText = interaction.fields.getTextInputValue("link");

  let min: number;
  let max: number | null;
  try {
    ({ min, max } = parsePlayerCounts(
      interaction.fields.getTextInputValue("min"),
      interaction.fields.getTextInputValue("max"),
    ));
  } catch (error) {
    if (error instanceof PlayerCountError) {
      await interaction.reply({ content: error.message, flags: MessageFlags.Ephemeral });
      return;
    }
    throw error;
  }
  let link: string | null;
  try {
    link = parseGameLink(linkText);
  } catch (error) {
    if (error instanceof GameLinkError) {
      await interaction.reply({ content: error.message, flags: MessageFlags.Ephemeral });
      return;
    }
    throw error;
  }

  if (findGameByName(ctx.db, guildId, name)) {
    await interaction.reply({
      content: `**${name}** is already in the library.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const game = addGame(ctx.db, guildId, name, min, max, interaction.user.id, link);
  await interaction.reply({
    content: `Added **${game.name}** (${game.minPlayers}–${game.maxPlayers ?? "∞"} players).${link ? `\n${link}` : ""}`,
  });
}
