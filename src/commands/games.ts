import {
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
} from "discord.js";
import type { AppContext } from "../context.js";
import { addGame, findGameByName, listGames, removeGame } from "../db/repos/games.js";

export const data = new SlashCommandBuilder()
  .setName("games")
  .setDescription("Manage this server's game library")
  .addSubcommand((s) =>
    s
      .setName("add")
      .setDescription("Add a game")
      .addStringOption((o) =>
        o.setName("name").setDescription("Game name").setRequired(true).setMaxLength(80),
      )
      .addIntegerOption((o) =>
        o
          .setName("min")
          .setDescription("Fewest players it works with")
          .setRequired(true)
          .setMinValue(1)
          .setMaxValue(100),
      )
      .addIntegerOption((o) =>
        o
          .setName("max")
          .setDescription("Most players it supports (leave empty for unlimited)")
          .setMinValue(1)
          .setMaxValue(100),
      ),
  )
  .addSubcommand((s) => s.setName("list").setDescription("List the library"))
  .addSubcommand((s) =>
    s
      .setName("remove")
      .setDescription("Remove a game")
      .addStringOption((o) =>
        o.setName("name").setDescription("Game name").setRequired(true),
      ),
  );

export async function execute(
  interaction: ChatInputCommandInteraction,
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

  const subcommand = interaction.options.getSubcommand();

  if (subcommand === "add") {
    const name = interaction.options.getString("name", true).trim();
    const min = interaction.options.getInteger("min", true);
    const max = interaction.options.getInteger("max");

    if (max !== null && max < min) {
      await interaction.reply({
        content: `**max** (${max}) cannot be below **min** (${min}).`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    if (findGameByName(ctx.db, guildId, name)) {
      await interaction.reply({
        content: `**${name}** is already in the library.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const game = addGame(ctx.db, guildId, name, min, max, interaction.user.id);
    await interaction.reply({
      content: `Added **${game.name}** (${game.minPlayers}–${game.maxPlayers ?? "∞"} players).`,
    });
    return;
  }

  if (subcommand === "list") {
    const games = listGames(ctx.db, guildId);
    if (games.length === 0) {
      await interaction.reply({
        content: "The library is empty. Add one with `/games add`.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    const lines = games.map(
      (g) => `• **${g.name}** — ${g.minPlayers}–${g.maxPlayers ?? "∞"} players`,
    );
    await interaction.reply({ content: lines.join("\n") });
    return;
  }

  // remove
  const name = interaction.options.getString("name", true);
  const isModerator =
    interaction.memberPermissions?.has(PermissionFlagsBits.ManageEvents) ?? false;
  const result = removeGame(ctx.db, guildId, name, interaction.user.id, isModerator);

  const messages = {
    removed: `Removed **${name}**.`,
    not_found: `**${name}** is not in the library. Check \`/games list\` for the exact name.`,
    forbidden: `**${name}** was added by someone else. Removing it needs the Manage Events permission.`,
  } as const;

  await interaction.reply({
    content: messages[result],
    flags: MessageFlags.Ephemeral,
  });
}
