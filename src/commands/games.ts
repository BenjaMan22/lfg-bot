import {
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type AutocompleteInteraction,
  type ChatInputCommandInteraction,
} from "discord.js";
import type { AppContext } from "../context.js";
import { listGames, removeGame } from "../db/repos/games.js";
import { buildGameAddModal } from "../interactions/games.js";
import {
  decodeGamePick,
  encodeGamePick,
  searchSteam,
  steamStoreUrl,
} from "../steam/store.js";

export const data = new SlashCommandBuilder()
  .setName("games")
  .setDescription("Manage this server's game library")
  .addSubcommand((s) =>
    s
      .setName("add")
      .setDescription("Add a game")
      .addStringOption((o) =>
        o
          .setName("name")
          .setDescription("Start typing to search Steam, or just type any name")
          .setRequired(false)
          // Autocomplete is the only place Discord offers live, server-side
          // search: it exists on command options and nowhere else — not in
          // modals, not in select menus. That is why the Steam lookup lives
          // here rather than on the game picker in /gamenight create.
          .setAutocomplete(true),
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
    // The option is optional, so `/games add` on its own still opens the
    // blank modal exactly as before; a Steam pick just arrives prefilled.
    const picked = interaction.options.getString("name");
    const pick = picked ? decodeGamePick(picked) : null;
    await interaction.showModal(
      buildGameAddModal(
        pick === null
          ? undefined
          : pick.kind === "steam"
            ? { name: pick.name, link: steamStoreUrl(pick.appid) }
            : { name: pick.name },
      ),
    );
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

/**
 * Suggest Steam titles as the host types `/games add name:`.
 *
 * Discord gives this three seconds and no way to report an error, so
 * `searchSteam` is written to return [] rather than throw — an empty
 * suggestion list simply means the host types the name themselves, which is
 * exactly the behaviour that existed before Steam was involved.
 */
export async function autocomplete(
  interaction: AutocompleteInteraction,
): Promise<void> {
  const typed = interaction.options.getFocused();
  const games = await searchSteam(typed);
  await interaction.respond(
    games.map((g) => ({
      // The host sees the title; the handler receives appid and name.
      name: g.name.slice(0, 100),
      value: encodeGamePick(g),
    })),
  );
}
