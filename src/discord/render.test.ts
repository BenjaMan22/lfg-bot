import { describe, expect, it } from "vitest";
import { renderPoll, type LockedDetails, type PollView } from "./render.js";
import { expandDays } from "../domain/timeblocks.js";
import { rankNight } from "../domain/scheduling.js";
import type { Game, SchedulingResult } from "../domain/scheduling.js";

const CHI = "America/Chicago";
const lethal: Game = { id: 2, name: "Lethal Company", minPlayers: 2, maxPlayers: 4 };
const days = expandDays(["2026-08-28"], { startHour: 18, endHour: 23 }, CHI);

interface BaseOverrides {
  availability?: Map<string, Set<number>>;
  votes?: Map<string, Set<number>>;
  games?: Game[];
  pendingIds?: string[];
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
    pendingIds: over.pendingIds ?? [],
    result: over.result ?? rankNight({ days, minSessionHours: 2, games, availability, votes }),
  };
}

function openView(over: BaseOverrides = {}): PollView {
  return { ...baseFields(over), status: "open" };
}

function failedView(over: BaseOverrides = {}): PollView {
  return { ...baseFields(over), status: "failed" };
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
    const hours = [days[0].startUtc, days[0].startUtc + 3600];
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
    expect(text).toContain(`<t:${days[0].startUtc}:t>`);
  });

  it("flags an oversubscribed roster", () => {
    const hours = [days[0].startUtc, days[0].startUtc + 3600];
    const users = ["a", "b", "c", "d", "e"];
    const availability = new Map(users.map((u) => [u, new Set(hours)]));
    const votes = new Map(users.map((u) => [u, new Set([2])]));
    const text = JSON.stringify(
      renderPoll(openView({ availability, votes })).embeds[0].toJSON(),
    );
    expect(text).toMatch(/plays 4/);
  });

  it("lists who has not responded", () => {
    const text = JSON.stringify(
      renderPoll(openView({ pendingIds: ["taylor"] })).embeds[0].toJSON(),
    );
    expect(text).toContain("<@taylor>");
  });

  it("offers the four response buttons while open", () => {
    const [row] = renderPoll(openView()).components;
    const ids = row.toJSON().components.map((c) => (c as { custom_id: string }).custom_id);
    expect(ids).toEqual([
      "gn:avail:7",
      "gn:votes:7",
      "gn:suggest:7",
      "gn:out:7",
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
    expect(ids).toEqual(["gn:in:7", "gn:out:7"]);
    expect(JSON.stringify(rendered.embeds[0].toJSON())).toMatch(/locked/i);
  });

  it("explains the near misses when nothing was viable", () => {
    const hours = [days[0].startUtc, days[0].startUtc + 3600];
    const availability = new Map([["a", new Set(hours)]]);
    const votes = new Map([["a", new Set([2])]]);
    const result = rankNight({
      days,
      minSessionHours: 2,
      games: [lethal],
      availability,
      votes,
    });
    const text = JSON.stringify(
      renderPoll(failedView({ availability, votes, result })).embeds[0].toJSON(),
    );
    expect(text).toMatch(/needs 2/);
  });

  it("shows no buttons at all on a failed night", () => {
    expect(renderPoll(failedView()).components).toEqual([]);
  });
});
