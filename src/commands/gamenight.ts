import {
  ChannelType,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
} from "discord.js";
import { DateTime } from "luxon";
import type { AppContext } from "../context.js";
import { listGames } from "../db/repos/games.js";
import {
  cancelNight,
  createDraftNight,
  getCancellableNightForChannel,
  getOpenNightForChannel,
} from "../db/repos/nights.js";
import {
  TimeParseError,
  expandDays,
  parseDays,
  parseDeadline,
  parseWindow,
} from "../domain/timeblocks.js";
import { deleteScheduledEvent } from "../discord/events.js";
import { renderNightNow } from "../discord/updateQueue.js";
import { requireTimezone } from "../discord/timezonePicker.js";
import { buildGameSetupComponents } from "../interactions/setup.js";

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
  )
  .addSubcommand((s) =>
    s.setName("cancel").setDescription("Cancel this channel's open game night"),
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

  if (interaction.options.getSubcommand() === "cancel") {
    // Open or locked: a locked night still has a live Scheduled Event and
    // roster to retract, so it must stay cancellable too.
    const night = getCancellableNightForChannel(
      ctx.db,
      interaction.channelId,
      Math.floor(Date.now() / 1000),
    );
    if (!night) {
      await interaction.reply({
        content: "No open game night in this channel.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    const isModerator =
      interaction.memberPermissions?.has(PermissionFlagsBits.ManageEvents) ?? false;
    if (night.hostId !== interaction.user.id && !isModerator) {
      await interaction.reply({
        content: "Only the host or someone with Manage Events can cancel this.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    cancelNight(ctx.db, night.id);

    // Answer before the Discord round trips, not after. The cancellation is
    // already committed, so a slow event delete or a re-render of a poll
    // whose message was deleted must not cost the host their confirmation —
    // and past three seconds the reply would fail outright, telling them the
    // command broke when it had in fact worked.
    await interaction.reply({ content: "Cancelled.", flags: MessageFlags.Ephemeral });

    // Best-effort tidying. Failing here must not surface as the router's
    // generic error on top of a "Cancelled." the user already has.
    try {
      if (night.eventId) {
        await deleteScheduledEvent(interaction.client, night.guildId, night.eventId);
      }
      await renderNightNow(interaction.client, ctx.db, night.id);
    } catch (error) {
      console.error("Cancelled, but could not finish tidying up", {
        nightId: night.id,
        error,
      });
    }
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
    components: buildGameSetupComponents(nightId, library, []),
  });
}
