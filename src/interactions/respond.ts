import {
  ActionRowBuilder,
  MessageFlags,
  ModalBuilder,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
  type ButtonInteraction,
  type ModalSubmitInteraction,
  type StringSelectMenuInteraction,
} from "discord.js";
import type { AppContext } from "../context.js";
import { addGame, findGameByName, getGamesByIds, listGames } from "../db/repos/games.js";
import { buildGameSetupComponents, librarySelectNote } from "./setup.js";
import {
  clearUserResponses,
  getAvailability,
  getNight,
  getNightDays,
  getNightGameIds,
  getVotes,
  setAttendance,
  setAvailabilityForDay,
  addNightGame,
  setVotes,
} from "../db/repos/nights.js";
import {
  formatDayLabel,
  slotLabels,
  slotsIn,
} from "../domain/timeblocks.js";
import { GameLinkError, parseGameLink } from "../domain/gameLink.js";
import { PlayerCountError, parsePlayerCounts } from "../domain/playerCounts.js";
import { queueRender } from "../discord/updateQueue.js";
import { requireTimezone } from "../discord/timezonePicker.js";
import { performCancel } from "../nights/cancel.js";

const EXPIRED = "That poll is closed. Nothing to change.";

/** Discord's select-menu limit: games on a night, and slots in a day. */
const SELECT_OPTION_LIMIT = 25;
const NIGHT_GAME_LIMIT = 25;

function openNightOrNull(ctx: AppContext, nightId: number) {
  const night = getNight(ctx.db, nightId);
  return night && night.status === "open" ? night : null;
}

/**
 * A night that still accepts attendance changes. Deliberately wider than
 * `openNightOrNull`: the **I'm in** / **I'm out** buttons live on the locked
 * message too, so those handlers cannot use the open-only guard — but they
 * must not accept writes to a night that was cancelled or failed either.
 */
function liveNightOrNull(ctx: AppContext, nightId: number) {
  const night = getNight(ctx.db, nightId);
  return night && (night.status === "open" || night.status === "locked") ? night : null;
}

export async function handleAvailabilityButton(
  interaction: ButtonInteraction,
  ctx: AppContext,
  nightId: number,
): Promise<void> {
  const night = openNightOrNull(ctx, nightId);
  if (!night) {
    await interaction.reply({ content: EXPIRED, flags: MessageFlags.Ephemeral });
    return;
  }
  const tz = await requireTimezone(interaction, ctx);
  if (!tz) return;

  const days = getNightDays(ctx.db, nightId);
  // A night created before availability moved to half hours may have a window
  // longer than the current maximum, which at 30-minute granularity needs more
  // options than a select menu can hold. discord.js throws on that, so say
  // what is actually wrong instead of surfacing the router's generic error.
  if (days.some((day) => slotsIn(day).length > SELECT_OPTION_LIMIT)) {
    await interaction.reply({
      content:
        "This poll's window is too long to answer now that availability moves in half hours. Cancel it with `/gamenight cancel` and start a new one — a window of 12 hours or less.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const chosen = getAvailability(ctx.db, nightId).get(interaction.user.id) ?? new Set();
  const rows = days.map((day) => {
    const slots = slotsIn(day);
    // slotLabels, not formatSlotLabel per slot: on a DST fall-back night two
    // real slots read the same on the clock, and two identical options are
    // not a choice the player can actually make.
    const labels = slotLabels(slots, tz);
    return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId(`gn:day:${nightId}:${day.dayIndex}`)
        .setPlaceholder(formatDayLabel(day, tz))
        .setMinValues(0)
        .setMaxValues(slots.length)
        .addOptions(
          slots.map((slot, index) => ({
            label: labels[index],
            value: String(slot),
            default: chosen.has(slot),
          })),
        ),
    );
  });

  await interaction.reply({
    content: `Pick the half-hour blocks you are free, in **${tz}**. Each change saves as you make it — just dismiss this when you are done.`,
    flags: MessageFlags.Ephemeral,
    components: rows,
  });
}

export async function handleDaySelect(
  interaction: StringSelectMenuInteraction,
  ctx: AppContext,
  nightId: number,
  dayIndex: number,
): Promise<void> {
  const night = openNightOrNull(ctx, nightId);
  if (!night) {
    await interaction.reply({ content: EXPIRED, flags: MessageFlags.Ephemeral });
    return;
  }
  const day = getNightDays(ctx.db, nightId).find((d) => d.dayIndex === dayIndex);
  if (!day) throw new Error(`Night ${nightId} has no day ${dayIndex}`);

  setAvailabilityForDay(
    ctx.db,
    nightId,
    interaction.user.id,
    slotsIn(day),
    interaction.values.map(Number),
  );
  await interaction.deferUpdate();
  queueRender(interaction.client, ctx.db, nightId);
}

export async function handleVotesButton(
  interaction: ButtonInteraction,
  ctx: AppContext,
  nightId: number,
): Promise<void> {
  const night = openNightOrNull(ctx, nightId);
  if (!night) {
    await interaction.reply({ content: EXPIRED, flags: MessageFlags.Ephemeral });
    return;
  }
  const games = getGamesByIds(ctx.db, getNightGameIds(ctx.db, nightId));
  const chosen = getVotes(ctx.db, nightId).get(interaction.user.id) ?? new Set();

  await interaction.reply({
    content: "Which of these would you play? Saves as you pick.",
    flags: MessageFlags.Ephemeral,
    components: [
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(`gn:voteselect:${nightId}`)
          .setPlaceholder("Games you'd play")
          .setMinValues(0)
          .setMaxValues(games.length)
          .addOptions(
            games.map((g) => ({
              label: g.name.slice(0, 100),
              description: `${g.minPlayers}–${g.maxPlayers ?? "∞"} players`,
              value: String(g.id),
              default: chosen.has(g.id),
            })),
          ),
      ),
    ],
  });
}

export async function handleVotesSelect(
  interaction: StringSelectMenuInteraction,
  ctx: AppContext,
  nightId: number,
): Promise<void> {
  const night = openNightOrNull(ctx, nightId);
  if (!night) {
    await interaction.reply({ content: EXPIRED, flags: MessageFlags.Ephemeral });
    return;
  }
  setVotes(ctx.db, nightId, interaction.user.id, interaction.values.map(Number));
  await interaction.deferUpdate();
  queueRender(interaction.client, ctx.db, nightId);
}

export async function handleSuggestButton(
  interaction: ButtonInteraction,
  nightId: number,
): Promise<void> {
  await interaction.showModal(
    new ModalBuilder()
      .setCustomId(`gn:suggestmodal:${nightId}`)
      .setTitle("Suggest a game")
      .addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder()
            .setCustomId("name")
            .setLabel("Game name")
            .setStyle(TextInputStyle.Short)
            .setMaxLength(80)
            .setRequired(true),
        ),
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder()
            .setCustomId("min")
            .setLabel("Fewest players (optional)")
            .setStyle(TextInputStyle.Short)
            .setPlaceholder("Leave blank for 1")
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
          new TextInputBuilder()
            .setCustomId("link")
            .setLabel("Link (optional)")
            .setStyle(TextInputStyle.Short)
            .setPlaceholder("https://store.steampowered.com/...")
            .setRequired(false),
        ),
      ),
  );
}

export async function handleSuggestModal(
  interaction: ModalSubmitInteraction,
  ctx: AppContext,
  nightId: number,
): Promise<void> {
  const night = getNight(ctx.db, nightId);
  if (!night || (night.status !== "open" && night.status !== "draft")) {
    await interaction.reply({ content: EXPIRED, flags: MessageFlags.Ephemeral });
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

  // Reuse an existing library entry rather than creating a near-duplicate.
  const existing = findGameByName(ctx.db, night.guildId, name);
  const gameIds = getNightGameIds(ctx.db, nightId);
  const alreadyOnNight = existing !== null && gameIds.includes(existing.id);

  // Checked before the game is created, not after: the library write is
  // permanent, so rejecting here once it had already happened left an orphan
  // entry behind for a suggestion that never made it onto any night.
  if (!alreadyOnNight && gameIds.length >= NIGHT_GAME_LIMIT) {
    await interaction.reply({
      content: `This night already has ${NIGHT_GAME_LIMIT} games, which is Discord's dropdown limit.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const game =
    existing ?? addGame(ctx.db, night.guildId, name, min, max, interaction.user.id, link);
  if (!alreadyOnNight) addNightGame(ctx.db, nightId, game.id);

  const votes = getVotes(ctx.db, nightId).get(interaction.user.id) ?? new Set<number>();
  setVotes(ctx.db, nightId, interaction.user.id, [...new Set([...votes, game.id])]);

  const confirmation = `Added **${game.name}** (${game.minPlayers}–${game.maxPlayers ?? "∞"}) and voted you for it.`;

  // The setup select's options are built from the library at the moment
  // /gamenight create ran and never rebuilt on their own — so a game added
  // here, mid-setup, would otherwise never appear in it, and the host's next
  // pick would silently drop it. While the night is still a draft, rebuild
  // the select (with the host's current picks preserved) into the same
  // ephemeral setup message rather than leaving it stale.
  if (night.status === "draft" && interaction.isFromMessage()) {
    const library = listGames(ctx.db, night.guildId);
    const chosenIds = getNightGameIds(ctx.db, nightId);
    await interaction.update({
      content: `${confirmation}\n\nPick the games for this night, then post it.${librarySelectNote(library.length)}`,
      components: buildGameSetupComponents(nightId, library, chosenIds, night.voiceChannelId),
    });
    return;
  }

  await interaction.reply({ content: confirmation, flags: MessageFlags.Ephemeral });
  queueRender(interaction.client, ctx.db, nightId);
}

export async function handleOutButton(
  interaction: ButtonInteraction,
  ctx: AppContext,
  nightId: number,
): Promise<void> {
  const night = liveNightOrNull(ctx, nightId);
  if (!night) {
    await interaction.reply({ content: EXPIRED, flags: MessageFlags.Ephemeral });
    return;
  }
  // Only while the poll is still open does dropping out mean withdrawing the
  // answers too. After lock those rows are the record of how the decision was
  // reached, and deleting them would rewrite that history — the roster is
  // what changes, so change only the roster.
  if (night.status === "open") clearUserResponses(ctx.db, nightId, interaction.user.id);
  setAttendance(ctx.db, nightId, interaction.user.id, "out");
  await interaction.reply({
    content: "Marked you out for this one.",
    flags: MessageFlags.Ephemeral,
  });
  queueRender(interaction.client, ctx.db, nightId);
}

export async function handleInButton(
  interaction: ButtonInteraction,
  ctx: AppContext,
  nightId: number,
): Promise<void> {
  if (!liveNightOrNull(ctx, nightId)) {
    await interaction.reply({ content: EXPIRED, flags: MessageFlags.Ephemeral });
    return;
  }
  setAttendance(ctx.db, nightId, interaction.user.id, "in");
  await interaction.reply({
    content: "You're on the roster.",
    flags: MessageFlags.Ephemeral,
  });
  queueRender(interaction.client, ctx.db, nightId);
}

/**
 * Unlike `/gamenight cancel`, which has to look up "the channel's live
 * night" because the command carries no argument, this button already knows
 * exactly which night it's for — it's the ID baked into its own customId.
 */
export async function handleTrashButton(
  interaction: ButtonInteraction,
  ctx: AppContext,
  nightId: number,
): Promise<void> {
  const night = getNight(ctx.db, nightId);
  if (!night || (night.status !== "open" && night.status !== "locked")) {
    await interaction.reply({ content: EXPIRED, flags: MessageFlags.Ephemeral });
    return;
  }
  await performCancel(interaction, ctx, night);
}
