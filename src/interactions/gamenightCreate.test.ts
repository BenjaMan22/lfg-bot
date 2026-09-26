import { DateTime } from "luxon";
import { describe, expect, it } from "vitest";
import { buildGameNightCreateModal } from "./gamenightCreate.js";
import type { Game } from "../domain/scheduling.js";

const CHI = "America/Chicago";
// Saturday afternoon.
const NOW = DateTime.fromISO("2026-09-26T15:00:00", { zone: CHI });

const library: Game[] = [
  { id: 1, name: "Catan", maxPlayers: 4 },
  { id: 2, name: "Deep Rock", maxPlayers: null },
];

interface FieldJson {
  custom_id?: string;
  min_values?: number;
  max_values?: number;
  options?: { value: string; label: string; description?: string }[];
}

/** Each field's inner component, in the order the host sees them. */
function fields(lib: Game[] = library): FieldJson[] {
  const json = buildGameNightCreateModal(lib, CHI, NOW).toJSON() as {
    components: { component?: FieldJson }[];
  };
  return json.components.map((c) => c.component ?? {});
}

const field = (id: string) => fields().find((f) => f.custom_id === id);

describe("buildGameNightCreateModal", () => {
  it("asks for title, games, days, start time and length, in that order", () => {
    expect(fields().map((f) => f.custom_id)).toEqual(["title", "games", "days", "start", "length"]);
  });

  it("has no free-text date, time or deadline field left", () => {
    const ids = fields().map((f) => f.custom_id);
    expect(ids).not.toContain("day");
    expect(ids).not.toContain("hours");
    expect(ids).not.toContain("deadline");
  });

  it("labels games by their maximum player count", () => {
    expect(field("games")?.options?.map((o) => [o.value, o.description])).toEqual([
      ["1", "up to 4 players"],
      ["2", "any number of players"],
    ]);
  });

  it("offers 25 days starting today, and lets the host pick up to five", () => {
    const days = field("days");
    expect(days?.options).toHaveLength(25);
    expect(days?.options?.[0]).toMatchObject({
      value: "2026-09-26",
      label: "Sat Sep 26",
      description: "Today",
    });
    expect(days?.min_values).toBe(1);
    expect(days?.max_values).toBe(5);
  });

  it("offers start times from noon to 11:30pm", () => {
    const start = field("start");
    expect(start?.options).toHaveLength(24);
    expect(start?.options?.[0]).toMatchObject({ value: "720", label: "12pm" });
    expect(start?.options?.at(-1)).toMatchObject({ value: "1410", label: "11:30pm" });
  });

  it("offers lengths from 2 to 12 hours", () => {
    const length = field("length");
    expect(length?.options).toHaveLength(21);
    expect(length?.options?.[0]).toMatchObject({ value: "120", label: "2 hours" });
    expect(length?.options?.at(-1)).toMatchObject({ value: "720", label: "12 hours" });
  });

  it("stays within Discord's 25-option select limit for games", () => {
    const big: Game[] = Array.from({ length: 30 }, (_, i) => ({
      id: i + 1,
      name: `Game ${i + 1}`,
      maxPlayers: null,
    }));
    expect(fields(big).find((f) => f.custom_id === "games")?.options).toHaveLength(25);
  });
});
