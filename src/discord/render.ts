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

/**
 * Mirrors the repository's NightFailureReason. Declared here rather than
 * imported because render.ts must not depend on src/db — the same reason
 * `status` is a local literal union too. Null covers a night failed before
 * the column existed.
 */
export type FailureReason = "no_viable" | "lock_error";

export interface FailedPollView extends PollViewBase {
  status: "failed";
  failureReason: FailureReason | null;
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
/**
 * Discord renders both in each viewer's own local time. A range needs the
 * DAY on its start — with `:t` on both ends, two suggestions 24 hours apart
 * read identically as "8:00 PM – 11:00 PM" and nobody can tell which night is
 * which. The end keeps the bare time, since a range that restates the date is
 * just noise.
 */
const dayAndClock = (utc: number) => `<t:${utc}:f>`;
const clock = (utc: number) => `<t:${utc}:t>`;

/** Discord's hard limit on one embed field value. */
const FIELD_LIMIT = 1024;
/** Roughly 21 characters per mention, so 20 is about 440 characters. */
const MENTION_CAP = 20;
/** Three suggestions share one field, so their rosters get a tighter cap. */
const SUGGESTION_MENTION_CAP = 8;

/**
 * A mention is ~21 characters, so an unbounded roster is a crash waiting for
 * a big enough channel: discord.js validates field values at `addFields` time
 * and throws SYNCHRONOUSLY past FIELD_LIMIT. At **Post it** every member but
 * the host is a non-responder, so "channel visible to 47+ people" was enough
 * to stop the poll ever being posted.
 */
function mentionList(ids: string[], cap: number): string {
  const shown = ids.slice(0, cap).map(mention).join(" ");
  const hidden = ids.length - cap;
  return hidden > 0 ? `${shown} …and ${hidden} others` : shown;
}

/**
 * The structural guarantee behind the caps above: whatever a field ends up
 * containing, it can never be long enough to throw. Cuts on a space where it
 * can, so a truncated list does not end mid-mention.
 */
function fitField(value: string): string {
  if (value.length <= FIELD_LIMIT) return value;
  const cut = value.slice(0, FIELD_LIMIT - 1);
  const boundary = cut.lastIndexOf(" ");
  const kept = boundary > FIELD_LIMIT / 2 ? cut.slice(0, boundary) : cut;
  return `${kept.trimEnd()}…`;
}

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
          `**${index + 1}. ${dayAndClock(s.startUtc)}–${clock(s.endUtc)} · ${s.game.name}** · ${s.roster.length} players${flag}`,
          mentionList(s.roster, SUGGESTION_MENTION_CAP),
        ].join("\n");
      })
      .join("\n\n");
  }
  if (view.result.nearMisses.length > 0) {
    return view.result.nearMisses
      .map(
        (m) =>
          `${dayAndClock(m.startUtc)}–${clock(m.endUtc)} · **${m.game.name}** had ${m.rosterSize}; needs ${m.game.minPlayers}.`,
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
        `**Locked in.** ${dayAndClock(view.locked.startUtc)}–${clock(view.locked.endUtc)} · **${view.locked.game.name}**`,
      )
      .addFields({
        name: `Playing (${view.locked.roster.length})`,
        value: fitField(mentionList(view.locked.roster, MENTION_CAP)) || "_nobody yet_",
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
    embed.setColor(0x95a5a6);
    if (view.status === "cancelled") {
      embed.setDescription("**Cancelled** by the host.");
    } else if (view.failureReason === "lock_error") {
      // An infrastructure give-up, not a scheduling outcome. Saying "no
      // viable night" here would be a lie about the players' answers.
      embed.setDescription(
        "**I could not lock this night in.** Something kept going wrong talking to Discord at the deadline, and I stopped retrying. Nothing was scheduled — start a fresh one with `/gamenight create`.",
      );
    } else if (view.responderIds.size === 0) {
      // Distinct from "we computed some near misses and none worked" — here
      // there is nothing to compute from at all, so say that plainly rather
      // than falling through to the near-miss placeholder.
      embed.setDescription("**No viable night.** Nobody responded before the deadline.");
    } else {
      embed.setDescription("**No viable night.** Closest misses:");
      embed.addFields({ name: "Near misses", value: fitField(suggestionLines(view)) });
    }
    return { embeds: [embed], components: [] };
  }

  embed
    .setColor(0x5865f2)
    .setDescription(`Deadline <t:${view.deadlineUtc}:R>`)
    .addFields(
      { name: "Availability", value: fitField(grid(view)) },
      { name: "Games", value: fitField(gameLine(view)) },
      { name: "Best right now", value: fitField(suggestionLines(view)) },
      {
        name: `Responded: ${view.responderIds.size}`,
        value:
          view.pendingIds.length > 0
            ? fitField(`No response: ${mentionList(view.pendingIds, MENTION_CAP)}`)
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
