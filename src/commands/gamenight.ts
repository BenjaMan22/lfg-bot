import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  MessageFlags,
  SlashCommandBuilder,
  StringSelectMenuBuilder,
  type ChatInputCommandInteraction,
} from "discord.js";
import { DateTime } from "luxon";
import type { AppContext } from "../context.js";
import { listGames } from "../db/repos/games.js";
import {
  createDraftNight,
  getOpenNightForChannel,
} from "../db/repos/nights.js";
import {
  TimeParseError,
  expandDays,
  parseDays,
  parseDeadline,
  parseWindow,
} from "../domain/timeblocks.js";
import { requireTimezone } from "../discord/timezonePicker.js";

export const data = new SlashCommandBuilder()
  .setName("gamenight")
  .setDescription("Plan a game night")
  .addSubcommand((s) => s.setName("ping").setDescription("Check the bot is alive"))
  .addSubcommand((s) =>
    s
      .setName("create")
      .setDescription("Start a game night poll")
      .addStringOption((o) =>
        o.setName("days").setDescription("e.g. fri,sat or 2026-08-28").setRequired(true),
      )
      .addStringOption((o) =>
        o.setName("window").setDescription("e.g. 6pm-1am").setRequired(true),
      )
      .addStringOption((o) =>
        o.setName("deadline").setDescription("e.g. thu 9pm or 24h").setRequired(true),
      )
      .addIntegerOption((o) =>
        o
          .setName("minhours")
          .setDescription("Shortest session worth having (default 2)")
          .setMinValue(1)
          .setMaxValue(12),
      )
      .addChannelOption((o) =>
        o
          .setName("voice")
          .setDescription("Voice channel to attach the event to")
          .addChannelTypes(ChannelType.GuildVoice),
      )
      .addStringOption((o) =>
        o.setName("title").setDescription("Title for the post").setMaxLength(80),
      ),
  );

export async function execute(
  interaction: ChatInputCommandInteraction,
  ctx: AppContext,
): Promise<void> {
  if (interaction.options.getSubcommand() === "ping") {
    await interaction.reply({
      content: `Alive. Round trip ${Date.now() - interaction.createdTimestamp}ms.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (!interaction.guildId || !interaction.channelId) {
    await interaction.reply({
      content: "Game nights only work inside a server channel.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const existing = getOpenNightForChannel(ctx.db, interaction.channelId);
  if (existing) {
    await interaction.reply({
      content: `This channel already has an open game night: https://discord.com/channels/${interaction.guildId}/${interaction.channelId}/${existing.messageId}\nFinish or \`/gamenight cancel\` that one first.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const tz = await requireTimezone(interaction, ctx);
  if (!tz) return;

  const now = DateTime.now().setZone(tz);
  let days, window, deadlineUtc;
  try {
    days = parseDays(interaction.options.getString("days", true), tz, now);
    window = parseWindow(interaction.options.getString("window", true));
    deadlineUtc = parseDeadline(interaction.options.getString("deadline", true), tz, now);
  } catch (error) {
    if (error instanceof TimeParseError) {
      await interaction.reply({ content: error.message, flags: MessageFlags.Ephemeral });
      return;
    }
    throw error;
  }

  const expanded = expandDays(days, window, tz);
  if (deadlineUtc >= expanded[0].startUtc) {
    await interaction.reply({
      content: "The deadline has to be before the first day's window starts, or there is no time to decide.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const library = listGames(ctx.db, interaction.guildId);
  if (library.length === 0) {
    await interaction.reply({
      content: "The game library is empty. Add a few with `/games add` first.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const nightId = createDraftNight(ctx.db, {
    guildId: interaction.guildId,
    channelId: interaction.channelId,
    hostId: interaction.user.id,
    title: interaction.options.getString("title") ?? "Game Night",
    displayTz: tz,
    minSessionHours: interaction.options.getInteger("minhours") ?? 2,
    deadlineUtc,
    voiceChannelId: interaction.options.getChannel("voice")?.id ?? null,
    days: expanded,
    createdUtc: now.toUnixInteger(),
  });

  await interaction.reply({
    content: "Pick the games for this night, then post it.",
    flags: MessageFlags.Ephemeral,
    components: [
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(`gn:setup:${nightId}`)
          .setPlaceholder("Games")
          .setMinValues(0)
          .setMaxValues(Math.min(library.length, 25))
          .addOptions(
            library.slice(0, 25).map((g) => ({
              label: g.name.slice(0, 100),
              description: `${g.minPlayers}–${g.maxPlayers ?? "∞"} players`,
              value: String(g.id),
            })),
          ),
      ),
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(`gn:setupadd:${nightId}`)
          .setLabel("Add a game")
          .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId(`gn:post:${nightId}`)
          .setLabel("Post it")
          .setStyle(ButtonStyle.Success),
      ),
    ],
  });
}
