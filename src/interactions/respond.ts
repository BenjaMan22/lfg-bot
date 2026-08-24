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
import { buildGameSetupComponents } from "./setup.js";
import {
  clearUserResponses,
  getAvailability,
  getNight,
  getNightDays,
  getNightGameIds,
  getVotes,
  setAttendance,
  setAvailabilityForDay,
  setNightGames,
  setVotes,
} from "../db/repos/nights.js";
import {
  formatDayLabel,
  formatHourLabel,
  hoursIn,
} from "../domain/timeblocks.js";
import { queueRender } from "../discord/updateQueue.js";
import { requireTimezone } from "../discord/timezonePicker.js";

const EXPIRED = "That poll is closed. Nothing to change.";

function openNightOrNull(ctx: AppContext, nightId: number) {
  const night = getNight(ctx.db, nightId);
  return night && night.status === "open" ? night : null;
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

  const chosen = getAvailability(ctx.db, nightId).get(interaction.user.id) ?? new Set();
  const rows = getNightDays(ctx.db, nightId).map((day) => {
    const hours = hoursIn(day);
    return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId(`gn:day:${nightId}:${day.dayIndex}`)
        .setPlaceholder(formatDayLabel(day, tz))
        .setMinValues(0)
        .setMaxValues(hours.length)
        .addOptions(
          hours.map((hour) => ({
            label: formatHourLabel(hour, tz),
            value: String(hour),
            default: chosen.has(hour),
          })),
        ),
    );
  });

  await interaction.reply({
    content: `Pick the hours you are free, in **${tz}**. Each change saves as you make it — just dismiss this when you are done.`,
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
    hoursIn(day),
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
  const minText = interaction.fields.getTextInputValue("min").trim();
  const maxText = interaction.fields.getTextInputValue("max").trim();
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

  // Reuse an existing library entry rather than creating a near-duplicate.
  const game =
    findGameByName(ctx.db, night.guildId, name) ??
    addGame(ctx.db, night.guildId, name, min, max, interaction.user.id);

  const gameIds = getNightGameIds(ctx.db, nightId);
  if (!gameIds.includes(game.id)) {
    if (gameIds.length >= 25) {
      await interaction.reply({
        content: "This night already has 25 games, which is Discord's dropdown limit.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    setNightGames(ctx.db, nightId, [...gameIds, game.id]);
  }

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
      content: `${confirmation}\n\nPick the games for this night, then post it.`,
      components: buildGameSetupComponents(nightId, library, chosenIds),
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
  clearUserResponses(ctx.db, nightId, interaction.user.id);
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
  setAttendance(ctx.db, nightId, interaction.user.id, "in");
  await interaction.reply({
    content: "You're on the roster.",
    flags: MessageFlags.Ephemeral,
  });
  queueRender(interaction.client, ctx.db, nightId);
}
