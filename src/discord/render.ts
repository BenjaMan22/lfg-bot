import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
} from "discord.js";
import type { Game, SchedulingResult } from "../domain/scheduling.js";
import {
  formatDayLabel,
  formatHourLabel,
  hoursIn,
  type NightDay,
} from "../domain/timeblocks.js";

export interface LockedDetails {
  startUtc: number;
  endUtc: number;
  game: Game;
  roster: string[];
}

interface PollViewBase {
  nightId: number;
  title: string;
  displayTz: string;
  deadlineUtc: number;
  days: NightDay[];
  games: Game[];
  availability: Map<string, Set<number>>;
  votes: Map<string, Set<number>>;
  responderIds: Set<string>;
  pendingIds: string[];
  result: SchedulingResult;
}

export interface OpenPollView extends PollViewBase {
  status: "open";
}

/** The only variant that carries locked details — required, not optional. */
export interface LockedPollView extends PollViewBase {
  status: "locked";
  locked: LockedDetails;
}

export interface FailedPollView extends PollViewBase {
  status: "failed";
}

export interface CancelledPollView extends PollViewBase {
  status: "cancelled";
}

/**
 * Discriminated on `status`. Only `LockedPollView` carries `locked`, and it is
 * required there — a locked view without details, or a non-locked view with
 * one, is a compile error rather than a runtime `null` check.
 */
export type PollView = OpenPollView | LockedPollView | FailedPollView | CancelledPollView;

const mention = (id: string) => `<@${id}>`;
/** Discord renders these in each viewer's own local time. */
const clock = (utc: number) => `<t:${utc}:t>`;

function countsFor(day: NightDay, availability: Map<string, Set<number>>): number[] {
  return hoursIn(day).map((hour) => {
    let count = 0;
    for (const hours of availability.values()) if (hours.has(hour)) count += 1;
    return count;
  });
}

function grid(view: PollView): string {
  const lines: string[] = [];
  for (const day of view.days) {
    const hours = hoursIn(day);
    const labels = hours.map((h) => formatHourLabel(h, view.displayTz));
    const counts = countsFor(day, view.availability).map((c) => (c === 0 ? "·" : String(c)));
    const width = labels.map((label, i) => Math.max(label.length, counts[i].length));
    const pad = (cells: string[]) =>
      cells.map((cell, i) => cell.padStart(width[i])).join(" ");
    lines.push(`${formatDayLabel(day, view.displayTz).padEnd(12)} ${pad(labels)}`);
    lines.push(`${" ".repeat(12)} ${pad(counts)}`);
  }
  return `\`\`\`\n${lines.join("\n")}\n\`\`\``;
}

function gameLine(view: PollView): string {
  if (view.games.length === 0) return "_No games yet._";
  return view.games
    .map((game) => {
      let count = 0;
      for (const chosen of view.votes.values()) if (chosen.has(game.id)) count += 1;
      return `${game.name} (${count})`;
    })
    .join(" · ");
}

function suggestionLines(view: PollView): string {
  if (view.result.top.length > 0) {
    return view.result.top
      .map((s, index) => {
        const flag = s.oversubscribed
          ? ` — ${s.roster.length} in, plays ${s.game.maxPlayers}, split lobbies?`
          : "";
        return [
          `**${index + 1}. ${clock(s.startUtc)}–${clock(s.endUtc)} · ${s.game.name}** · ${s.roster.length} players${flag}`,
          s.roster.map(mention).join(" "),
        ].join("\n");
      })
      .join("\n\n");
  }
  if (view.result.nearMisses.length > 0) {
    return view.result.nearMisses
      .map(
        (m) =>
          `${clock(m.startUtc)}–${clock(m.endUtc)} · **${m.game.name}** had ${m.rosterSize}; needs ${m.game.minPlayers}.`,
      )
      .join("\n");
  }
  return "_Nothing yet — no responses yet._";
}

export function renderPoll(view: PollView): {
  embeds: EmbedBuilder[];
  components: ActionRowBuilder<ButtonBuilder>[];
} {
  const embed = new EmbedBuilder()
    .setTitle(`🎲 ${view.title}`)
    .setFooter({ text: `Grid shown in ${view.displayTz}` });

  if (view.status === "locked") {
    embed
      .setColor(0x2ecc71)
      .setDescription(
        `**Locked in.** ${clock(view.locked.startUtc)}–${clock(view.locked.endUtc)} · **${view.locked.game.name}**`,
      )
      .addFields({
        name: `Playing (${view.locked.roster.length})`,
        value: view.locked.roster.map(mention).join(" ") || "_nobody yet_",
      });
    return {
      embeds: [embed],
      components: [
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder()
            .setCustomId(`gn:in:${view.nightId}`)
            .setLabel("I'm in")
            .setStyle(ButtonStyle.Success),
          new ButtonBuilder()
            .setCustomId(`gn:out:${view.nightId}`)
            .setLabel("I'm out")
            .setStyle(ButtonStyle.Secondary),
        ),
      ],
    };
  }

  if (view.status === "failed" || view.status === "cancelled") {
    embed
      .setColor(0x95a5a6)
      .setDescription(
        view.status === "cancelled"
          ? "**Cancelled** by the host."
          : "**No viable night.** Closest misses:",
      );
    if (view.status === "failed") {
      embed.addFields({ name: "Near misses", value: suggestionLines(view) });
    }
    return { embeds: [embed], components: [] };
  }

  embed
    .setColor(0x5865f2)
    .setDescription(`Deadline <t:${view.deadlineUtc}:R>`)
    .addFields(
      { name: "Availability", value: grid(view) },
      { name: "Games", value: gameLine(view) },
      { name: "Best right now", value: suggestionLines(view) },
      {
        name: `Responded: ${view.responderIds.size}`,
        value:
          view.pendingIds.length > 0
            ? `No response: ${view.pendingIds.map(mention).join(" ")}`
            : "Everyone has answered.",
      },
    );

  return {
    embeds: [embed],
    components: [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(`gn:avail:${view.nightId}`)
          .setLabel("Set availability")
          .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
          .setCustomId(`gn:votes:${view.nightId}`)
          .setLabel("Pick games")
          .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
          .setCustomId(`gn:suggest:${view.nightId}`)
          .setLabel("Suggest a game")
          .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId(`gn:out:${view.nightId}`)
          .setLabel("I'm out")
          .setStyle(ButtonStyle.Secondary),
      ),
    ],
  };
}
