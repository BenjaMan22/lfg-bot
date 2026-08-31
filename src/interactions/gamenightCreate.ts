import {
  LabelBuilder,
  MessageFlags,
  ModalBuilder,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
  type ModalSubmitInteraction,
} from "discord.js";
import { DateTime } from "luxon";
import type { AppContext } from "../context.js";
import type { Game } from "../domain/scheduling.js";
import { listGames } from "../db/repos/games.js";
import { createDraftNight, setNightGames } from "../db/repos/nights.js";
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

/**
 * Every night ranks runs of at least this many hours. Fixed rather than a
 * modal field: it is a detail of how the engine searches, not a decision the
 * host has context to make, and asking cost a whole component in a modal
 * limited to five.
 */
export const MIN_SESSION_HOURS = 2;

/** Discord's hard limit on the number of options in one select menu. */
const SELECT_OPTION_LIMIT = 25;

/**
 * The whole poll in one screen: title, games, days, hours, deadline.
 *
 * Built from `LabelBuilder` rather than `ActionRowBuilder` because a modal
 * action row only accepts a text input — a select menu has to be wrapped in a
 * label, which is also the API discord.js now wants (`addComponents` with a
 * row is deprecated). That is what lets the game picker live here instead of
 * only on the setup screen that follows.
 *
 * Five components is Discord's modal maximum, so this is full: a voice
 * channel picker cannot also fit, and stays on the setup screen.
 */
export function buildGameNightCreateModal(library: Game[]): ModalBuilder {
  return new ModalBuilder()
    .setCustomId("gn:createmodal")
    .setTitle("Start a game night")
    .addLabelComponents(
      new LabelBuilder()
        .setLabel("Title for the post (optional)")
        .setTextInputComponent(
          new TextInputBuilder()
            .setCustomId("title")
            .setStyle(TextInputStyle.Short)
            .setMaxLength(80)
            .setRequired(false),
        ),
      new LabelBuilder()
        .setLabel("Games")
        .setDescription("Everything you would be happy to play that night.")
        .setStringSelectMenuComponent(
          new StringSelectMenuBuilder()
            .setCustomId("games")
            .setPlaceholder("Pick at least one")
            .setMinValues(1)
            .setMaxValues(Math.min(library.length, SELECT_OPTION_LIMIT))
            .addOptions(
              library.slice(0, SELECT_OPTION_LIMIT).map((g) => ({
                label: g.name.slice(0, 100),
                description: `${g.minPlayers}–${g.maxPlayers ?? "∞"} players`,
                value: String(g.id),
              })),
            ),
        ),
      new LabelBuilder()
        .setLabel("Days")
        .setDescription("Up to five, comma separated.")
        .setTextInputComponent(
          new TextInputBuilder()
            .setCustomId("day")
            .setPlaceholder("fri,sat or 2026-08-28")
            .setStyle(TextInputStyle.Short)
            .setMaxLength(100)
            .setRequired(true),
        ),
      new LabelBuilder()
        .setLabel("Hours")
        .setDescription("The evening window each of those days.")
        .setTextInputComponent(
          new TextInputBuilder()
            .setCustomId("hours")
            .setPlaceholder("6pm-1am")
            .setStyle(TextInputStyle.Short)
            .setMaxLength(40)
            .setRequired(true),
        ),
      new LabelBuilder()
        .setLabel("Deadline")
        .setDescription("When I decide and lock it in.")
        .setTextInputComponent(
          new TextInputBuilder()
            .setCustomId("deadline")
            .setPlaceholder("thu 9pm or 24h")
            .setStyle(TextInputStyle.Short)
            .setMaxLength(40)
            .setRequired(true),
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
  const daysText = interaction.fields.getTextInputValue("day");
  const windowText = interaction.fields.getTextInputValue("hours");
  const deadlineText = interaction.fields.getTextInputValue("deadline");
  const titleText = interaction.fields.getTextInputValue("title").trim();
  const pickedGameIds = interaction.fields.getStringSelectValues("games").map(Number);

  let days, window, deadlineUtc;
  try {
    days = parseDays(daysText, tz, now);
    window = parseWindow(windowText);
    deadlineUtc = parseDeadline(deadlineText, tz, now);
    // The session length is no longer something the host sets, so the only
    // way this fails now is a window shorter than one session — which the
    // message says, since widening it is the only fix available.
    assertSessionFitsWindow(MIN_SESSION_HOURS, window);
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

  const nightId = createDraftNight(ctx.db, {
    guildId,
    channelId,
    hostId: interaction.user.id,
    title: titleText || "Game Night",
    displayTz: tz,
    minSessionHours: MIN_SESSION_HOURS,
    deadlineUtc,
    voiceChannelId: null,
    days: expanded,
    createdUtc: now.toUnixInteger(),
  });

  // The modal's picks seed the night, so the setup screen opens with them
  // already selected — it is there to adjust, attach a voice channel, and
  // post, not to ask the same question a second time.
  setNightGames(ctx.db, nightId, pickedGameIds);

  const library = listGames(ctx.db, guildId);
  await interaction.reply({
    content: `Attach a voice channel if you want one, then post it.${librarySelectNote(library.length)}`,
    flags: MessageFlags.Ephemeral,
    components: buildGameSetupComponents(nightId, library, pickedGameIds, null),
  });
}
