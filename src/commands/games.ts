import {
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
} from "discord.js";
import type { AppContext } from "../context.js";
import { listGames, removeGame } from "../db/repos/games.js";
import { buildGameAddModal } from "../interactions/games.js";

export const data = new SlashCommandBuilder()
  .setName("games")
  .setDescription("Manage this server's game library")
  .addSubcommand((s) => s.setName("add").setDescription("Add a game"))
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
    await interaction.showModal(buildGameAddModal());
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
    const lines = games.map((g) => {
      const base = `• **${g.name}** — ${g.minPlayers}–${g.maxPlayers ?? "∞"} players`;
      return g.link ? `${base} — ${g.link}` : base;
    });
    // Suppressed so a library full of linked games doesn't unfurl into a
    // wall of preview cards — one per line is plenty to read, no previews
    // needed. /games add's own confirmation is a single game and keeps its
    // preview, which is a nice confirmation that the link is the right one.
    await interaction.reply({
      content: lines.join("\n"),
      flags: MessageFlags.SuppressEmbeds,
    });
    return;
  }

  // remove
  const name = interaction.options.getString("name", true).trim();
  const isModerator =
    interaction.memberPermissions?.has(PermissionFlagsBits.ManageEvents) ?? false;
  const result = removeGame(ctx.db, guildId, name, interaction.user.id, isModerator);

  const messages = {
    removed: `Removed **${name}**.`,
    not_found: `**${name}** is not in the library. Check \`/games list\` for the exact name.`,
    forbidden: `**${name}** was added by someone else. Removing it needs the Manage Events permission.`,
    in_use: `**${name}** is used by an existing game night and can't be removed.`,
  } as const;

  await interaction.reply({
    content: messages[result],
    flags: MessageFlags.Ephemeral,
  });
}
