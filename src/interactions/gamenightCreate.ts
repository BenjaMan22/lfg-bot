import {
  ActionRowBuilder,
  MessageFlags,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  type ModalSubmitInteraction,
} from "discord.js";
import { DateTime } from "luxon";
import type { AppContext } from "../context.js";
import { listGames } from "../db/repos/games.js";
import { createDraftNight } from "../db/repos/nights.js";
import {
  TimeParseError,
  assertSessionFitsWindow,
  expandDays,
  parseDays,
  parseDeadline,
  parseWindow,
} from "../domain/timeblocks.js";
import { requireTimezone } from "../discord/timezonePicker.js";
import { buildGameSetupComponents, librarySelectNote } from "./setup.js";

const MIN_SESSION_HOURS_DEFAULT = 2;

export function buildGameNightCreateModal(): ModalBuilder {
  return new ModalBuilder()
    .setCustomId("gn:createmodal")
    .setTitle("Start a game night")
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("days")
          .setLabel("Days (e.g. fri,sat or 2026-08-28)")
          .setStyle(TextInputStyle.Short)
          .setMaxLength(100)
          .setRequired(true),
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("window")
          .setLabel("Window (e.g. 6pm-1am)")
          .setStyle(TextInputStyle.Short)
          .setMaxLength(40)
          .setRequired(true),
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("deadline")
          .setLabel("Deadline (e.g. thu 9pm or 24h)")
          .setStyle(TextInputStyle.Short)
          .setMaxLength(40)
          .setRequired(true),
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("minhours")
          .setLabel("Shortest session in hours (default 2)")
          .setStyle(TextInputStyle.Short)
          .setPlaceholder("2")
          .setRequired(false),
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("title")
          .setLabel("Title for the post (optional)")
          .setStyle(TextInputStyle.Short)
          .setMaxLength(80)
          .setRequired(false),
      ),
    );
}

export async function handleGameNightCreateModal(
  interaction: ModalSubmitInteraction,
  ctx: AppContext,
): Promise<void> {
  // The command that showed this modal already checked guild/channel, but
  // that was a different interaction — TypeScript has no way to know these
  // are still non-null on this one, so the guard is real, not decorative.
  if (!interaction.guildId || !interaction.channelId) {
    await interaction.reply({
      content: "Game nights only work inside a server channel.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  const guildId = interaction.guildId;
  const channelId = interaction.channelId;

  const tz = await requireTimezone(interaction, ctx);
  if (!tz) return;

  const now = DateTime.now().setZone(tz);
  const daysText = interaction.fields.getTextInputValue("days");
  const windowText = interaction.fields.getTextInputValue("window");
  const deadlineText = interaction.fields.getTextInputValue("deadline");
  const minhoursText = interaction.fields.getTextInputValue("minhours").trim();
  const titleText = interaction.fields.getTextInputValue("title").trim();

  let days, window, deadlineUtc;
  try {
    days = parseDays(daysText, tz, now);
    window = parseWindow(windowText);
    deadlineUtc = parseDeadline(deadlineText, tz, now);
  } catch (error) {
    if (error instanceof TimeParseError) {
      await interaction.reply({ content: error.message, flags: MessageFlags.Ephemeral });
      return;
    }
    throw error;
  }

  let minSessionHours = MIN_SESSION_HOURS_DEFAULT;
  if (minhoursText !== "") {
    const parsed = Number(minhoursText);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 12) {
      await interaction.reply({
        content: `"${minhoursText}" has to be a whole number from 1 to 12, or blank for the default of ${MIN_SESSION_HOURS_DEFAULT}.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    minSessionHours = parsed;
  }

  // The range check above only says the number is sane on its own. A session
  // longer than the window can never be scheduled at all, and left to the
  // deadline it surfaces as a bare "no viable night" after everyone has
  // already answered — so it is caught here, while the host can still fix it.
  try {
    assertSessionFitsWindow(minSessionHours, window);
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

  const library = listGames(ctx.db, guildId);
  if (library.length === 0) {
    await interaction.reply({
      content: "The game library is empty. Add a few with `/games add` first.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const nightId = createDraftNight(ctx.db, {
    guildId,
    channelId,
    hostId: interaction.user.id,
    title: titleText || "Game Night",
    displayTz: tz,
    minSessionHours,
    deadlineUtc,
    voiceChannelId: null,
    days: expanded,
    createdUtc: now.toUnixInteger(),
  });

  await interaction.reply({
    content: `Pick the games for this night — attach a voice channel if you want one — then post it.${librarySelectNote(library.length)}`,
    flags: MessageFlags.Ephemeral,
    components: buildGameSetupComponents(nightId, library, [], null),
  });
}
