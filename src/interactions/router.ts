import { MessageFlags, type Interaction } from "discord.js";
import type { AppContext } from "../context.js";
import { log } from "../log.js";
import { commandsByName } from "../commands/index.js";
import {
  handleTimezoneModal,
  handleTimezoneOtherButton,
  handleTimezoneSelect,
} from "../discord/timezonePicker.js";
import { handlePostButton, handleSetupSelect, handleSetupVoiceSelect } from "./setup.js";
import {
  handleAvailabilityButton,
  handleDaySelect,
  handleInButton,
  handleOutButton,
  handleSuggestButton,
  handleSuggestModal,
  handleTrashButton,
  handleVotesButton,
  handleVotesSelect,
} from "./respond.js";
import { handleGameAddModal } from "./games.js";
import { handleGameNightCreateModal } from "./gamenightCreate.js";

export function parseCustomId(id: string): { action: string; args: string[] } {
  const [namespace, action, ...args] = id.split(":");
  if (namespace !== "gn" || !action) {
    return { action: "", args: [] };
  }
  return { action, args };
}

/**
 * Discord gives a bot 3 seconds to acknowledge an interaction. Past that the
 * user sees "interaction failed" — inside the form, for a modal — no matter
 * what the handler does afterwards. Warn a little before the hard limit so a
 * slow-but-successful handler is visible before it becomes a failing one.
 */
const SLOW_RESPONSE_MS = 2500;

/** Who did what, where — enough to find the interaction in Discord. */
function describeInteraction(interaction: Interaction): Record<string, unknown> {
  let what: string;
  if (interaction.isChatInputCommand()) {
    const sub = interaction.options.getSubcommand(false);
    what = `/${interaction.commandName}${sub ? ` ${sub}` : ""}`;
  } else if (interaction.isMessageComponent() || interaction.isModalSubmit()) {
    what = interaction.customId;
  } else {
    what = `type ${interaction.type}`;
  }
  return {
    what,
    user: `${interaction.user.tag} (${interaction.user.id})`,
    guild: interaction.guildId,
    channel: interaction.channelId,
  };
}

/** Reply with a message the user can act on, whether or not we already deferred. */
async function replyError(interaction: Interaction, message: string): Promise<void> {
  if (!interaction.isRepliable()) return;
  const payload = { content: message, flags: MessageFlags.Ephemeral } as const;
  try {
    if (interaction.deferred || interaction.replied) {
      await interaction.followUp(payload);
    } else {
      await interaction.reply(payload);
    }
  } catch (error) {
    // This is the "red error in the modal" case: the handler failed AND
    // telling the user so failed too — usually because the 3-second window
    // (or the 15-minute token) had already expired. Say so rather than
    // swallowing it, since it's the one failure the user cannot report.
    log.error("Could not even send the error reply", {
      ...describeInteraction(interaction),
      error,
    });
  }
}

export async function routeInteraction(
  interaction: Interaction,
  ctx: AppContext,
): Promise<void> {
  // Autocomplete fires on every keystroke; logging it would drown everything
  // else. Its failures are still logged, inside dispatch.
  const verbose = !interaction.isAutocomplete();
  const described = describeInteraction(interaction);
  const started = performance.now();
  if (verbose) log.info("Interaction received", described);

  try {
    const matched = await dispatch(interaction, ctx);
    const elapsedMs = Math.round(performance.now() - started);

    if (!matched) {
      // Previously silent: no handler, no reply, no log — the user just saw
      // "interaction failed". Usually a button from an older version of the
      // bot, or a customId typo.
      log.warn("No handler matched this interaction", { ...described, elapsedMs });
      await replyError(
        interaction,
        "I don't know how to handle that — it may be from an older version of this message. Try running the command again.",
      );
      return;
    }

    // showModal, reply, deferReply and deferUpdate all set one of these.
    if (interaction.isRepliable() && !interaction.replied && !interaction.deferred) {
      log.warn("Handler finished without responding — the user sees 'interaction failed'", {
        ...described,
        elapsedMs,
      });
      await replyError(interaction, "Something went wrong handling that. It has been logged — try again.");
      return;
    }

    if (elapsedMs > SLOW_RESPONSE_MS) {
      log.warn(`Handler took ${elapsedMs}ms — Discord only allows 3000ms to respond`, described);
    } else if (verbose) {
      log.info(`Interaction handled in ${elapsedMs}ms`, { what: described.what });
    }
  } catch (error) {
    // The night id encoded in customId — gn:<action>:<nightId>[:...] for
    // every handler that has one — points straight at the actual poll.
    const customId =
      interaction.isMessageComponent() || interaction.isModalSubmit()
        ? interaction.customId
        : null;
    const nightId = customId ? (parseCustomId(customId).args[0] ?? null) : null;
    log.error("Interaction failed", {
      ...described,
      nightId,
      elapsedMs: Math.round(performance.now() - started),
      error,
    });
    await replyError(
      interaction,
      "Something went wrong handling that. It has been logged — try again.",
    );
  }
}

/**
 * Hands the interaction to its handler. Returns false when nothing matched,
 * so the caller can say so instead of the interaction failing silently.
 */
async function dispatch(interaction: Interaction, ctx: AppContext): Promise<boolean> {
  /** Awaits a handler and reports the route as matched. */
  const ran = async (work: Promise<void>): Promise<true> => {
    await work;
    return true;
  };

  if (interaction.isChatInputCommand()) {
    const command = commandsByName.get(interaction.commandName);
    if (!command) return false;
    return ran(command.execute(interaction, ctx));
  }
  if (interaction.isAutocomplete()) {
    // Autocomplete has no user-visible failure mode: it cannot reply with a
    // message, and an unanswered one just shows "loading" forever. So it
    // never reaches routeInteraction's catch — a command without an
    // autocomplete handler, or one that throws, answers with an empty list.
    const command = commandsByName.get(interaction.commandName);
    try {
      if (command?.autocomplete) await command.autocomplete(interaction);
      else await interaction.respond([]);
    } catch (error) {
      log.error("Autocomplete failed", { command: interaction.commandName, error });
      await interaction.respond([]).catch(() => {});
    }
    return true;
  }
  if (interaction.isStringSelectMenu()) {
    const { action, args } = parseCustomId(interaction.customId);
    if (action === "tz") return ran(handleTimezoneSelect(interaction, ctx));
    if (action === "setup") return ran(handleSetupSelect(interaction, ctx, Number(args[0])));
    if (action === "day") {
      return ran(handleDaySelect(interaction, ctx, Number(args[0]), Number(args[1])));
    }
    if (action === "voteselect") return ran(handleVotesSelect(interaction, ctx, Number(args[0])));
  }
  if (interaction.isChannelSelectMenu()) {
    const { action, args } = parseCustomId(interaction.customId);
    if (action === "setupvoice") {
      return ran(handleSetupVoiceSelect(interaction, ctx, Number(args[0])));
    }
  }
  if (interaction.isButton()) {
    const { action, args } = parseCustomId(interaction.customId);
    if (action === "tzother") return ran(handleTimezoneOtherButton(interaction));
    if (action === "post") return ran(handlePostButton(interaction, ctx, Number(args[0])));
    if (action === "setupadd") return ran(handleSuggestButton(interaction, Number(args[0])));
    if (action === "avail") return ran(handleAvailabilityButton(interaction, ctx, Number(args[0])));
    if (action === "votes") return ran(handleVotesButton(interaction, ctx, Number(args[0])));
    if (action === "suggest") return ran(handleSuggestButton(interaction, Number(args[0])));
    if (action === "out") return ran(handleOutButton(interaction, ctx, Number(args[0])));
    if (action === "in") return ran(handleInButton(interaction, ctx, Number(args[0])));
    if (action === "trash") return ran(handleTrashButton(interaction, ctx, Number(args[0])));
  }
  if (interaction.isModalSubmit()) {
    const { action, args } = parseCustomId(interaction.customId);
    if (action === "tzmodal") return ran(handleTimezoneModal(interaction, ctx));
    if (action === "suggestmodal") return ran(handleSuggestModal(interaction, ctx, Number(args[0])));
    if (action === "gameaddmodal") return ran(handleGameAddModal(interaction, ctx));
    if (action === "createmodal") return ran(handleGameNightCreateModal(interaction, ctx));
  }
  return false;
}
