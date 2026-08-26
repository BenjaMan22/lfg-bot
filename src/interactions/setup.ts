import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelSelectMenuBuilder,
  ChannelType,
  MessageFlags,
  StringSelectMenuBuilder,
  type ButtonInteraction,
  type ChannelSelectMenuInteraction,
  type StringSelectMenuInteraction,
} from "discord.js";
import type { AppContext } from "../context.js";
import type { Game } from "../domain/scheduling.js";
import {
  getNight,
  getNightGameIds,
  getOpenNightForChannel,
  publishNight,
  setNightGames,
  setVoiceChannel,
} from "../db/repos/nights.js";
import { buildPollView } from "../discord/updateQueue.js";
import { renderPoll } from "../discord/render.js";

/** A jump link to a poll, or a plain description when we never stored one. */
export function messageLink(
  guildId: string,
  channelId: string,
  messageId: string | null,
): string {
  return messageId
    ? `https://discord.com/channels/${guildId}/${channelId}/${messageId}`
    : "(its message is missing)";
}

/** Discord's hard limit on the number of options in one select menu. */
const SELECT_OPTION_LIMIT = 25;

/**
 * A note for the setup message when the library outgrows the select. The
 * options are capped at 25 and `listGames` orders by name, so past that it is
 * the alphabetical tail that silently becomes unofferable — which looks like
 * the bot losing games rather than a Discord limit. "Suggest a game" still
 * reaches them by name, since it reuses an existing library entry.
 */
export function librarySelectNote(libraryLength: number): string {
  const hidden = libraryLength - SELECT_OPTION_LIMIT;
  if (hidden <= 0) return "";
  return `\n\n_Showing the first ${SELECT_OPTION_LIMIT} games alphabetically; ${hidden} more are in the library. Use **Add a game** and type the name to put one of those on this night._`;
}

/**
 * The setup select, an optional voice-channel picker, and the action
 * buttons. Built fresh from the current library and the night's current
 * picks — rather than once at `/gamenight create` time — so a game added
 * later via **Add a game** shows up (and is pre-selected) the next time this
 * message is rendered, instead of being silently dropped the next time the
 * host adjusts their picks. The voice select works the same way: it always
 * reflects whatever is currently stored, not just what was true when the
 * screen first appeared.
 */
export function buildGameSetupComponents(
  nightId: number,
  library: Game[],
  chosenIds: number[],
  currentVoiceChannelId: string | null,
): [
  ActionRowBuilder<StringSelectMenuBuilder>,
  ActionRowBuilder<ChannelSelectMenuBuilder>,
  ActionRowBuilder<ButtonBuilder>,
] {
  const chosen = new Set(chosenIds);
  const voiceSelect = new ChannelSelectMenuBuilder()
    .setCustomId(`gn:setupvoice:${nightId}`)
    .setPlaceholder("Voice channel (optional)")
    .setMinValues(0)
    .setMaxValues(1)
    .addChannelTypes(ChannelType.GuildVoice);
  if (currentVoiceChannelId) voiceSelect.setDefaultChannels(currentVoiceChannelId);

  return [
    new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId(`gn:setup:${nightId}`)
        .setPlaceholder("Games")
        .setMinValues(0)
        .setMaxValues(Math.min(library.length, SELECT_OPTION_LIMIT))
        .addOptions(
          library.slice(0, SELECT_OPTION_LIMIT).map((g) => ({
            label: g.name.slice(0, 100),
            description: `${g.minPlayers}–${g.maxPlayers ?? "∞"} players`,
            value: String(g.id),
            default: chosen.has(g.id),
          })),
        ),
    ),
    new ActionRowBuilder<ChannelSelectMenuBuilder>().addComponents(voiceSelect),
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
  ];
}

export async function handleSetupSelect(
  interaction: StringSelectMenuInteraction,
  ctx: AppContext,
  nightId: number,
): Promise<void> {
  // setNightGames only applies to a draft. This message stays clickable for
  // ~15 minutes after Post it, so a late pick is not an error — it just has
  // nowhere to go, and saying so beats a deferUpdate that looks like a save.
  if (setNightGames(ctx.db, nightId, interaction.values.map(Number))) {
    await interaction.deferUpdate();
    return;
  }
  await interaction.update({
    content:
      "This night has already been posted, so its game list is fixed. Use **Suggest a game** on the poll itself to add one.",
    components: [],
  });
}

export async function handleSetupVoiceSelect(
  interaction: ChannelSelectMenuInteraction,
  ctx: AppContext,
  nightId: number,
): Promise<void> {
  setVoiceChannel(ctx.db, nightId, interaction.values[0] ?? null);
  await interaction.deferUpdate();
}

export async function handlePostButton(
  interaction: ButtonInteraction,
  ctx: AppContext,
  nightId: number,
): Promise<void> {
  const night = getNight(ctx.db, nightId);
  if (!night || night.status !== "draft") {
    await interaction.update({ content: "That draft is gone. Run `/gamenight create` again.", components: [] });
    return;
  }
  if (interaction.user.id !== night.hostId) {
    await interaction.reply({ content: "Only the host can post this.", flags: MessageFlags.Ephemeral });
    return;
  }
  if (getNightGameIds(ctx.db, nightId).length === 0) {
    await interaction.reply({
      content: "Pick at least one game — there is nothing to rank otherwise.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  // Everything past this point does Discord round trips — a channel fetch, a
  // guild fetch and a FULL member fetch inside buildPollView, then the send
  // itself — which on a cold cache runs past Discord's 3-second interaction
  // window. Without deferring, the poll posts and publishNight commits, and
  // only then does update() throw Unknown Interaction, so the host sees
  // "This interaction failed" for an operation that entirely succeeded.
  // The guards above are synchronous database reads, so they answer in time
  // on their own.
  await interaction.deferUpdate();

  // The create-time check is minutes old by now, and drafts deliberately do
  // not count against it — so a host who ran /gamenight create twice is
  // holding two live setups and could post both. Two polls in one channel
  // means two sweeps, two Scheduled Events, two roster pings, and a cancel
  // that can only ever reach one of them.
  const alreadyOpen = getOpenNightForChannel(ctx.db, night.channelId);
  if (alreadyOpen) {
    await interaction.editReply({
      content: `This channel already has a game night running: ${messageLink(night.guildId, night.channelId, alreadyOpen.messageId)}\nCancel that one with \`/gamenight cancel\` before posting another.`,
      components: [],
    });
    return;
  }

  const channel = await interaction.client.channels.fetch(night.channelId);
  if (!channel?.isTextBased() || !("send" in channel)) throw new Error("Channel is not sendable");

  const view = await buildPollView(interaction.client, ctx.db, nightId);
  if (!view) throw new Error(`Night ${nightId} vanished`);
  const message = await channel.send(renderPoll(view));

  // The message is out before the row flips, so if the flip fails the poll
  // has to be taken back down — an unpublished night is never swept, never
  // locks, and never updates, so leaving it visible is worse than deleting it.
  let published: boolean;
  try {
    published = publishNight(ctx.db, nightId, message.id);
  } catch (error) {
    // nights_one_open_per_channel fired: another draft was published between
    // the check above and here.
    console.error("Could not publish night", { nightId, error });
    published = false;
  }
  if (!published) {
    await message.delete().catch((error: unknown) =>
      console.error("Could not remove an unpublished poll", { nightId, error }),
    );
    await interaction.editReply({
      content: "Someone posted a game night in this channel first, so I took that one back down. Cancel theirs, or use this channel's poll.",
      components: [],
    });
    return;
  }

  await interaction.editReply({ content: "Posted.", components: [] });
}
