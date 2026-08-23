import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
  ModalBuilder,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
  type ButtonInteraction,
  type InteractionReplyOptions,
  type ModalSubmitInteraction,
  type RepliableInteraction,
  type StringSelectMenuInteraction,
} from "discord.js";
import { IANAZone } from "luxon";
import type { AppContext } from "../context.js";
import { getTimezone, setTimezone } from "../db/repos/users.js";

export const COMMON_ZONES: { label: string; value: string }[] = [
  { label: "Pacific (Los Angeles)", value: "America/Los_Angeles" },
  { label: "Mountain (Denver)", value: "America/Denver" },
  { label: "Arizona (no DST)", value: "America/Phoenix" },
  { label: "Central (Chicago)", value: "America/Chicago" },
  { label: "Eastern (New York)", value: "America/New_York" },
  { label: "Atlantic (Halifax)", value: "America/Halifax" },
  { label: "Brazil (Sao Paulo)", value: "America/Sao_Paulo" },
  { label: "UK (London)", value: "Europe/London" },
  { label: "Central Europe (Berlin)", value: "Europe/Berlin" },
  { label: "Eastern Europe (Athens)", value: "Europe/Athens" },
  { label: "India (Kolkata)", value: "Asia/Kolkata" },
  { label: "Singapore", value: "Asia/Singapore" },
  { label: "Japan (Tokyo)", value: "Asia/Tokyo" },
  { label: "Sydney", value: "Australia/Sydney" },
  { label: "New Zealand (Auckland)", value: "Pacific/Auckland" },
];

export function isValidZone(zone: string): boolean {
  return IANAZone.isValidZone(zone);
}

export function timezonePrompt(reason: string): InteractionReplyOptions {
  return {
    content: `${reason}\n\nPick the closest one, or use **Other** for any IANA zone name.`,
    flags: MessageFlags.Ephemeral,
    components: [
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId("gn:tz")
          .setPlaceholder("Your timezone")
          .addOptions(COMMON_ZONES),
      ),
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId("gn:tzother")
          .setLabel("Other")
          .setStyle(ButtonStyle.Secondary),
      ),
    ],
  };
}

/**
 * Returns the caller's timezone, or replies with the picker and returns null.
 *
 * Contract every later handler depends on: a caller that receives null MUST
 * return immediately without replying again — this function has already sent
 * a reply (the picker), and a second reply/defer on the same interaction throws.
 */
export async function requireTimezone(
  interaction: RepliableInteraction,
  ctx: AppContext,
): Promise<string | null> {
  const zone = getTimezone(ctx.db, interaction.user.id);
  if (zone) return zone;
  await interaction.reply(
    timezonePrompt("I need your timezone first — I only ask once."),
  );
  return null;
}

async function confirm(
  interaction: StringSelectMenuInteraction | ModalSubmitInteraction,
  zone: string,
): Promise<void> {
  const payload = {
    content: `Timezone set to **${zone}**. If you were setting up a game night, run the command again — I'll use your local time. If you were answering a poll, click the button again.`,
    components: [],
  };
  if (interaction.isModalSubmit()) {
    await interaction.reply({ ...payload, flags: MessageFlags.Ephemeral });
  } else {
    await interaction.update(payload);
  }
}

export async function handleTimezoneSelect(
  interaction: StringSelectMenuInteraction,
  ctx: AppContext,
): Promise<void> {
  const zone = interaction.values[0];
  setTimezone(ctx.db, interaction.user.id, zone);
  await confirm(interaction, zone);
}

export async function handleTimezoneOtherButton(
  interaction: ButtonInteraction,
): Promise<void> {
  await interaction.showModal(
    new ModalBuilder()
      .setCustomId("gn:tzmodal")
      .setTitle("Set your timezone")
      .addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder()
            .setCustomId("zone")
            .setLabel("IANA timezone name")
            .setPlaceholder("Europe/Lisbon")
            .setStyle(TextInputStyle.Short)
            .setRequired(true),
        ),
      ),
  );
}

export async function handleTimezoneModal(
  interaction: ModalSubmitInteraction,
  ctx: AppContext,
): Promise<void> {
  const zone = interaction.fields.getTextInputValue("zone").trim();
  if (!isValidZone(zone)) {
    await interaction.reply({
      content: `**${zone}** is not an IANA timezone name. They look like \`Europe/Lisbon\` or \`America/Chicago\` — the full list is on Wikipedia under "List of tz database time zones".`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  setTimezone(ctx.db, interaction.user.id, zone);
  await confirm(interaction, zone);
}
