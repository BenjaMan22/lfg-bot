import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
} from "discord.js";
import { MIN_SESSION_HOURS } from "../domain/pickers.js";
import type { Game, SchedulingResult } from "../domain/scheduling.js";
import {
  SLOT_SECONDS,
  formatDayLabel,
  slotsIn,
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
  /** False hides Suggest a game — the host chose this on the setup screen. */
  allowSuggestions: boolean;
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
 * and throws SYNCHRONOUSLY past FIELD_LIMIT. When the poll still listed
 * non-responders, "channel visible to 47+ people" was enough to stop it ever
 * being posted; rosters are capped for the same reason.
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
  return slotsIn(day).map((slot) => {
    let count = 0;
    for (const slots of availability.values()) if (slots.has(slot)) count += 1;
    return count;
  });
}

interface InRange {
  startUtc: number;
  endUtc: number;
  count: number;
}

/**
 * A day's half-hour slots merged into runs with the same headcount. Slots
 * nobody picked are left out, so a gap splits two runs even when the counts
 * either side match.
 */
function inRanges(day: NightDay, availability: Map<string, Set<number>>): InRange[] {
  const counts = countsFor(day, availability);
  const ranges: InRange[] = [];
  slotsIn(day).forEach((slot, i) => {
    const count = counts[i];
    if (count === 0) return;
    const last = ranges.at(-1);
    if (last && last.count === count && last.endUtc === slot) {
      last.endUtc = slot + SLOT_SECONDS;
    } else {
      ranges.push({ startUtc: slot, endUtc: slot + SLOT_SECONDS, count });
    }
  });
  return ranges;
}

/** Ranges shown per day, loosest first, until the whole field fits. */
const RANGES_PER_DAY = [Infinity, 6, 4, 2, 1];

function dayBlock(label: string, ranges: InRange[], limit: number): string {
  if (ranges.length === 0) return `**${label}** · _nobody yet_`;
  // Over the limit, keep the busiest ranges — those are the ones worth
  // planning around — then put them back in time order.
  const shown =
    ranges.length <= limit
      ? ranges
      : [...ranges]
          .sort((a, b) => b.count - a.count || a.startUtc - b.startUtc)
          .slice(0, limit)
          .sort((a, b) => a.startUtc - b.startUtc);
  const lines = shown.map(
    (r) => `${clock(r.startUtc)} – ${clock(r.endUtc)} · **${r.count} in**`,
  );
  const hidden = ranges.length - shown.length;
  if (hidden > 0) lines.push(`_+${hidden} more_`);
  return [`**${label}**`, ...lines].join("\n");
}

/**
 * Timestamps rather than a monospace grid: Discord shows each one in the
 * viewer's own timezone, and a line per range reads without a key. The cost
 * is length — a timestamped line is ~45 characters — so a scattered set of
 * answers is trimmed per day rather than left to overflow the field.
 */
function whoIsIn(view: PollView): string {
  const days = view.days.map((day) => ({
    label: formatDayLabel(day, view.displayTz),
    ranges: inRanges(day, view.availability),
  }));
  let text = "";
  for (const limit of RANGES_PER_DAY) {
    text = days.map((d) => dayBlock(d.label, d.ranges, limit)).join("\n");
    if (text.length <= FIELD_LIMIT) break;
  }
  return text;
}

/**
 * A game's name, as a masked link when it has one, so voters can look up a
 * game they don't know. Brackets in the name are escaped (they would close
 * the link text early) and a `)` in the URL is encoded (it would end it).
 */
function gameName(game: Game): string {
  if (!game.link) return game.name;
  const text = game.name.replace(/[[\]]/g, (c) => `\\${c}`);
  return `[${text}](${game.link.replace(/\)/g, "%29")})`;
}

function gameLine(view: PollView): string {
  if (view.games.length === 0) return "_No games yet._";
  const line = (name: (game: Game) => string) =>
    view.games
      .map((game) => {
        let count = 0;
        for (const chosen of view.votes.values()) if (chosen.has(game.id)) count += 1;
        return `${name(game)} (${count})`;
      })
      .join(" · ");
  // A link costs ~60 characters, so a long shortlist of linked games can
  // pass the field limit. Every name plain beats a line cut off mid-link.
  const linked = line(gameName);
  return linked.length <= FIELD_LIMIT ? linked : line((game) => game.name);
}

function suggestionLines(view: PollView): string {
  if (view.result.top.length === 0) {
    // Near misses used to fill this space whenever anyone had answered, so
    // the "no responses" wording only ever showed on an empty poll. Without
    // them, it has to check — a poll with answers must not claim it has none.
    return view.responderIds.size === 0
      ? "_Nothing yet — no responses yet._"
      : `_Nothing yet — nobody is free for ${MIN_SESSION_HOURS} hours in a row with a game picked._`;
  }
  return view.result.top
    .map((s, index) => {
      const flag = s.oversubscribed
        ? ` — ${s.roster.length} in, plays ${s.game.maxPlayers}, split lobbies?`
        : "";
      return [
        `**${index + 1}. ${dayAndClock(s.startUtc)}–${clock(s.endUtc)} · ${gameName(s.game)}** · ${s.roster.length} players${flag}`,
        mentionList(s.roster, SUGGESTION_MENTION_CAP),
      ].join("\n");
    })
    .join("\n\n");
}

export function renderPoll(view: PollView): {
  embeds: EmbedBuilder[];
  components: ActionRowBuilder<ButtonBuilder>[];
} {
  const embed = new EmbedBuilder()
    .setTitle(`🎲 ${view.title}`)
    .setFooter({ text: `Dates in ${view.displayTz} · times in your own timezone` });

  if (view.status === "locked") {
    embed
      .setColor(0x2ecc71)
      .setDescription(
        `**Locked in.** ${dayAndClock(view.locked.startUtc)}–${clock(view.locked.endUtc)} · **${gameName(view.locked.game)}**`,
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
          new ButtonBuilder()
            .setCustomId(`gn:trash:${view.nightId}`)
            .setEmoji("🗑️")
            .setStyle(ButtonStyle.Danger),
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
        "**I could not lock this night in.** Something kept going wrong talking to Discord when it was time to pick the night, and I stopped retrying. Nothing was scheduled — start a fresh one with `/gamenight create`.",
      );
    } else if (view.responderIds.size === 0) {
      // Distinct from "we computed some near misses and none worked" — here
      // there is nothing to compute from at all, so say that plainly rather
      // than falling through to the near-miss placeholder.
      embed.setDescription("**No viable night.** Nobody responded before the night was picked.");
    } else {
      // With no per-game minimum, one person is enough — so the only way to
      // fail with answers in hand is that nobody had both a full session
      // free and a game picked.
      embed.setDescription(
        `**No viable night.** Nobody who answered was free for ${MIN_SESSION_HOURS} hours in a row and also picked a game.`,
      );
    }
    return { embeds: [embed], components: [] };
  }

  // A count, not a list of who hasn't answered: in a big server that list
  // ran to dozens of mentions and dwarfed the poll itself.
  const responded =
    view.responderIds.size === 0 ? "no responses yet" : `${view.responderIds.size} responded`;
  embed
    .setColor(0x5865f2)
    .setDescription(`Picks the night <t:${view.deadlineUtc}:R> · ${responded}`)
    .addFields(
      { name: "Who's in?", value: fitField(whoIsIn(view)) },
      { name: "Games", value: fitField(gameLine(view)) },
      { name: "Best right now", value: fitField(suggestionLines(view)) },
    );

  const buttons = [
    new ButtonBuilder()
      .setCustomId(`gn:avail:${view.nightId}`)
      .setLabel("Set availability")
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(`gn:votes:${view.nightId}`)
      .setLabel("Pick games")
      .setStyle(ButtonStyle.Primary),
  ];
  if (view.allowSuggestions) {
    buttons.push(
      new ButtonBuilder()
        .setCustomId(`gn:suggest:${view.nightId}`)
        .setLabel("Suggest a game")
        .setStyle(ButtonStyle.Secondary),
    );
  }
  buttons.push(
    new ButtonBuilder()
      .setCustomId(`gn:out:${view.nightId}`)
      .setLabel("I'm out")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`gn:trash:${view.nightId}`)
      .setEmoji("🗑️")
      .setStyle(ButtonStyle.Danger),
  );

  return {
    embeds: [embed],
    components: [new ActionRowBuilder<ButtonBuilder>().addComponents(buttons)],
  };
}
