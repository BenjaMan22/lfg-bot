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
          .setLabel("Fewest players it works with")
          .setStyle(TextInputStyle.Short)
          .setPlaceholder("2")
          .setRequired(true),
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("max")
          .setLabel("Most players (blank = unlimited)")
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
  const minText = interaction.fields.getTextInputValue("min").trim();
  const maxText = interaction.fields.getTextInputValue("max").trim();
  const linkText = interaction.fields.getTextInputValue("link");
  const min = Number(minText);
  const max = maxText === "" ? null : Number(maxText);

  if (!Number.isInteger(min) || min < 1) {
    await interaction.reply({
      content: `"${minText}" is not a whole number of players.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  if (max !== null && (!Number.isInteger(max) || max < min)) {
    await interaction.reply({
      content: `"${maxText}" has to be a whole number no smaller than ${min}, or blank for unlimited.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
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
