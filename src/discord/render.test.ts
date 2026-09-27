import { describe, expect, it } from "vitest";
import {
  renderPoll,
  type FailureReason,
  type LockedDetails,
  type PollView,
} from "./render.js";
import { expandDays } from "../domain/timeblocks.js";
import { rankNight } from "../domain/scheduling.js";
import type { Game, SchedulingResult } from "../domain/scheduling.js";

const CHI = "America/Chicago";
const lethal: Game = { id: 2, name: "Lethal Company", maxPlayers: 4 };
const days = expandDays(["2026-08-28"], { startMinutes: 18 * 60, endMinutes: 23 * 60 }, CHI);

/**
 * The four half-hour slots making up a two-hour block — enough to clear the
 * two-hour minimum session these fixtures rely on.
 */
const twoHours = (start: number) => [start, start + 1800, start + 3600, start + 5400];

interface BaseOverrides {
  availability?: Map<string, Set<number>>;
  votes?: Map<string, Set<number>>;
  games?: Game[];
  result?: SchedulingResult;
}

/** Fields common to every PollView status. */
function baseFields(over: BaseOverrides = {}) {
  const availability = over.availability ?? new Map<string, Set<number>>();
  const votes = over.votes ?? new Map<string, Set<number>>();
  const games = over.games ?? [lethal];
  return {
    nightId: 7,
    title: "Game Night",
    displayTz: CHI,
    deadlineUtc: 1_800_000_000,
    days,
    games,
    availability,
    votes,
    responderIds: new Set(availability.keys()),
    result: over.result ?? rankNight({ days, minSessionHours: 2, games, availability, votes }),
  };
}

function openView(over: BaseOverrides = {}): PollView {
  return { ...baseFields(over), status: "open" };
}

function failedView(
  over: BaseOverrides = {},
  failureReason: FailureReason | null = "no_viable",
): PollView {
  return { ...baseFields(over), status: "failed", failureReason };
}

function lockedView(locked: LockedDetails, over: BaseOverrides = {}): PollView {
  return { ...baseFields(over), status: "locked", locked };
}

describe("renderPoll", () => {
  it("names the display timezone so the grid is unambiguous", () => {
    const embed = renderPoll(openView()).embeds[0].toJSON();
    expect(JSON.stringify(embed)).toContain(CHI);
  });

  it("renders a grid row per day with hour labels", () => {
    const embed = renderPoll(openView()).embeds[0].toJSON();
    const text = JSON.stringify(embed);
    expect(text).toContain("Fri Aug 28");
    expect(text).toContain("6p");
  });

  it("uses a dynamic timestamp for the deadline so each viewer sees local time", () => {
    const embed = renderPoll(openView()).embeds[0].toJSON();
    expect(JSON.stringify(embed)).toContain("<t:1800000000:R>");
  });

  it("says nobody has answered yet when the poll is empty", () => {
    const embed = renderPoll(openView()).embeds[0].toJSON();
    expect(JSON.stringify(embed)).toMatch(/no (responses|answers) yet/i);
  });

  it("lists suggestions with dynamic timestamps and the roster", () => {
    const hours = twoHours(days[0].startUtc);
    const availability = new Map([
      ["a", new Set(hours)],
      ["b", new Set(hours)],
    ]);
    const votes = new Map([
      ["a", new Set([2])],
      ["b", new Set([2])],
    ]);
    const embed = renderPoll(openView({ availability, votes })).embeds[0].toJSON();
    const text = JSON.stringify(embed);
    expect(text).toContain("Lethal Company");
    expect(text).toContain("<@a>");
    // `:f` on the start carries the date, so two suggestions a day apart are
    // told apart; `:t` on the end keeps the range from restating it.
    expect(text).toContain(`<t:${days[0].startUtc}:f>`);
    expect(text).toContain(`<t:${days[0].startUtc + 2 * 3600}:t>`);
  });

  it("dates the locked night rather than giving a bare time", () => {
    const locked: LockedDetails = {
      startUtc: days[0].startUtc,
      endUtc: days[0].startUtc + 3 * 3600,
      game: lethal,
      roster: ["a", "b"],
    };
    const text = JSON.stringify(renderPoll(lockedView(locked)).embeds[0].toJSON());
    expect(text).toContain(`<t:${days[0].startUtc}:f>`);
  });

  it("flags an oversubscribed roster", () => {
    const hours = twoHours(days[0].startUtc);
    const users = ["a", "b", "c", "d", "e"];
    const availability = new Map(users.map((u) => [u, new Set(hours)]));
    const votes = new Map(users.map((u) => [u, new Set([2])]));
    const text = JSON.stringify(
      renderPoll(openView({ availability, votes })).embeds[0].toJSON(),
    );
    expect(text).toMatch(/plays 4/);
  });

  it("shows how many have responded, without naming who hasn't", () => {
    const hours = twoHours(days[0].startUtc);
    const availability = new Map(["a", "b", "c"].map((u) => [u, new Set(hours)]));
    const embed = renderPoll(openView({ availability })).embeds[0].toJSON();
    expect(embed.description).toBe("Picks the night <t:1800000000:R> · 3 responded");
    expect(embed.fields?.some((f) => f.name.startsWith("Responded"))).toBe(false);
    expect(JSON.stringify(embed)).not.toContain("No response");
  });

  it("says nobody has responded yet on a fresh poll", () => {
    const embed = renderPoll(openView()).embeds[0].toJSON();
    expect(embed.description).toBe("Picks the night <t:1800000000:R> · no responses yet");
  });

  it("caps a suggestion roster instead of overflowing the field", () => {
    const hours = twoHours(days[0].startUtc);
    const users = Array.from({ length: 40 }, (_, i) => `98765432109876${1000 + i}`);
    const availability = new Map(users.map((u) => [u, new Set(hours)]));
    const votes = new Map(users.map((u) => [u, new Set([2])]));
    const embed = renderPoll(openView({ availability, votes })).embeds[0].toJSON();
    const best = embed.fields?.find((f) => f.name === "Best right now");
    expect(best?.value.length).toBeLessThanOrEqual(1024);
    expect(best?.value).toContain("and 32 others");
  });

  it("offers the four response buttons while open", () => {
    const [row] = renderPoll(openView()).components;
    const ids = row.toJSON().components.map((c) => (c as { custom_id: string }).custom_id);
    expect(ids).toEqual([
      "gn:avail:7",
      "gn:votes:7",
      "gn:suggest:7",
      "gn:out:7",
      "gn:trash:7",
    ]);
  });

  it("swaps to in/out buttons once locked", () => {
    const locked: LockedDetails = {
      startUtc: days[0].startUtc,
      endUtc: days[0].startUtc + 3 * 3600,
      game: lethal,
      roster: ["a", "b"],
    };
    const rendered = renderPoll(lockedView(locked));
    const ids = rendered.components[0]
      .toJSON()
      .components.map((c) => (c as { custom_id: string }).custom_id);
    expect(ids).toEqual(["gn:in:7", "gn:out:7", "gn:trash:7"]);
    expect(JSON.stringify(rendered.embeds[0].toJSON())).toMatch(/locked/i);
  });

  it("plainly says nobody answered when a night fails with zero responses", () => {
    // Previously this fell through to the near-miss placeholder text
    // ("Closest misses:" followed by "Nothing yet — no responses yet."),
    // which reads oddly stacked and conflates "nobody answered" with "we
    // computed near misses and none worked."
    const text = JSON.stringify(renderPoll(failedView()).embeds[0].toJSON());
    expect(text).toMatch(/nobody responded/i);
    expect(text).not.toMatch(/nothing yet/i);
  });

  it("explains a failed night that did get answers", () => {
    const availability = new Map([["a", new Set<number>()]]);
    const text = JSON.stringify(renderPoll(failedView({ availability })).embeds[0].toJSON());
    expect(text).toMatch(/nobody who answered was free for 2 hours in a row/i);
    expect(text).not.toMatch(/closest misses/i);
  });

  it("does not claim there are no responses on an open poll that has some", () => {
    const availability = new Map([["a", new Set<number>()]]);
    const text = JSON.stringify(renderPoll(openView({ availability })).embeds[0].toJSON());
    expect(text).toMatch(/nobody is free for 2 hours in a row with a game picked/i);
    expect(text).not.toMatch(/no responses yet/i);
  });

  it("says the lock failed, not that nothing was viable, after a lock error", () => {
    const text = JSON.stringify(
      renderPoll(failedView({}, "lock_error")).embeds[0].toJSON(),
    );
    expect(text).toMatch(/could not lock/i);
    expect(text).not.toMatch(/no viable night/i);
  });

  it("shows no buttons at all on a failed night", () => {
    expect(renderPoll(failedView()).components).toEqual([]);
  });

  it("says when the bot will pick the night", () => {
    const text = JSON.stringify(renderPoll(openView()).embeds[0].toJSON());
    expect(text).toContain("Picks the night <t:1800000000:R>");
  });
});

