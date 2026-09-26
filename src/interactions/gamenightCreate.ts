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
import { MAX_DAYS, expandDays } from "../domain/timeblocks.js";
import {
  LENGTH_OPTIONS,
  MIN_SESSION_HOURS,
  SELECT_OPTION_LIMIT,
  START_TIME_OPTIONS,
  dayOptions,
  lockIsStillAhead,
  lockTimeFor,
  windowFromStartAndLength,
  type PickerOption,
} from "../domain/pickers.js";
import { playerCountLabel } from "../domain/playerCounts.js";
import { requireTimezone } from "../discord/timezonePicker.js";
import { log } from "../log.js";
import { buildGameSetupComponents, librarySelectNote } from "./setup.js";

/** A picker option as a select-menu option; values travel as strings. */
function selectOption(option: PickerOption<string | number>) {
  return {
    label: option.label,
    value: String(option.value),
    ...(option.description ? { description: option.description } : {}),
  };
}

/**
 * The whole poll in one screen: title, games, days, start time, length.
 *
 * Built from `LabelBuilder` rather than `ActionRowBuilder` because a modal
 * action row only accepts a text input — a select menu has to be wrapped in a
 * label, which is also the API discord.js now wants.
 *
 * Everything but the title is a dropdown. Discord has no date or time picker,
 * so dropdowns are the closest thing — and they make a malformed date or time
 * impossible to submit, rather than something to parse and reject. Five
 * components is Discord's modal maximum, so this is full: the voice channel
 * picker stays on the setup screen, and there is no deadline field — the bot
 * locks the night an hour before the first chosen day starts.
 */
export function buildGameNightCreateModal(
  library: Game[],
  tz: string,
  now: DateTime,
): ModalBuilder {
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
                description: playerCountLabel(g.maxPlayers),
                value: String(g.id),
              })),
            ),
        ),
      new LabelBuilder()
        .setLabel("Days")
        .setDescription(`Up to ${MAX_DAYS}. Friends mark which of these they're free.`)
        .setStringSelectMenuComponent(
          new StringSelectMenuBuilder()
            .setCustomId("days")
            .setPlaceholder("Pick the days you could play")
            .setMinValues(1)
            .setMaxValues(MAX_DAYS)
            .addOptions(dayOptions(tz, now).map(selectOption)),
        ),
      new LabelBuilder()
        .setLabel("Start time")
        .setDescription(`Each day, in ${tz}.`)
        .setStringSelectMenuComponent(
          new StringSelectMenuBuilder()
            .setCustomId("start")
            .setPlaceholder("When it could start")
            .addOptions(START_TIME_OPTIONS.map(selectOption)),
        ),
      new LabelBuilder()
        .setLabel("Length")
        .setDescription("How long you could play, each day.")
        .setStringSelectMenuComponent(
          new StringSelectMenuBuilder()
            .setCustomId("length")
            .setPlaceholder("How long")
            .addOptions(LENGTH_OPTIONS.map(selectOption)),
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
  if (!tz) {
    log.info("Create form paused: host has no timezone yet, showed the picker", {
      user: interaction.user.id,
    });
    return;
  }

  const now = DateTime.now().setZone(tz);
  const titleText = interaction.fields.getTextInputValue("title").trim();
  const pickedGameIds = interaction.fields.getStringSelectValues("games").map(Number);
  // Sorted because the first day decides the lock time, and a select returns
  // values in the order they were clicked.
  const pickedDays = [...interaction.fields.getStringSelectValues("days")].sort();
  const startMinutes = Number(interaction.fields.getStringSelectValues("start")[0]);
  const lengthMinutes = Number(interaction.fields.getStringSelectValues("length")[0]);

  const submitted = {
    title: titleText,
    gameIds: pickedGameIds,
    days: pickedDays,
    startMinutes,
    lengthMinutes,
    timezone: tz,
  };
  log.info("Create form submitted", submitted);

  const expanded = expandDays(
    pickedDays,
    windowFromStartAndLength(startMinutes, lengthMinutes),
    tz,
  );
  const lockUtc = lockTimeFor(expanded);

  // The only input a picker cannot rule out: time passing. A first day
  // starting within the hour leaves nobody time to answer — and a modal left
  // open past midnight offers a "today" that has become yesterday.
  if (!lockIsStillAhead(lockUtc, now.toUnixInteger())) {
    const reason =
      "Your first day starts in less than an hour — pick a later start time or day, so people have time to answer.";
    log.warn("Create form rejected", { reason, ...submitted });
    await interaction.reply({ content: reason, flags: MessageFlags.Ephemeral });
    return;
  }

  const nightId = createDraftNight(ctx.db, {
    guildId,
    channelId,
    hostId: interaction.user.id,
    title: titleText || "Game Night",
    displayTz: tz,
    minSessionHours: MIN_SESSION_HOURS,
    deadlineUtc: lockUtc,
    voiceChannelId: null,
    days: expanded,
    createdUtc: now.toUnixInteger(),
  });

  // The modal's picks seed the night, so the setup screen opens with them
  // already selected — it is there to adjust, attach a voice channel, and
  // post, not to ask the same question a second time.
  setNightGames(ctx.db, nightId, pickedGameIds);
  log.info("Draft night created", { nightId, days: expanded.length, lockUtc });

  const library = listGames(ctx.db, guildId);
  await interaction.reply({
    content: `Attach a voice channel if you want one, then post it.${librarySelectNote(library.length)}`,
    flags: MessageFlags.Ephemeral,
    components: buildGameSetupComponents(nightId, library, pickedGameIds, null),
  });
}
