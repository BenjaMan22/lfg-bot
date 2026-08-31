import { describe, expect, it } from "vitest";
import { buildGameNightCreateModal } from "./gamenightCreate.js";
import type { Game } from "../domain/scheduling.js";

const library: Game[] = [
  { id: 1, name: "Catan", minPlayers: 3, maxPlayers: 4 },
  { id: 2, name: "Deep Rock", minPlayers: 2, maxPlayers: null },
];

/** The custom_id of each field, in the order the host sees them. */
function fieldIds(library: Game[]): string[] {
  const json = buildGameNightCreateModal(library).toJSON() as {
    components: { component?: { custom_id?: string } }[];
  };
  return json.components.map((c) => c.component?.custom_id ?? "");
}

describe("buildGameNightCreateModal", () => {
  it("asks for title, game, day, hours and deadline, in that order", () => {
    expect(fieldIds(library)).toEqual(["title", "games", "day", "hours", "deadline"]);
  });

  it("no longer asks for a shortest session length", () => {
    expect(fieldIds(library)).not.toContain("minhours");
  });

  it("offers the library as a multi-select of games", () => {
    const json = buildGameNightCreateModal(library).toJSON() as {
      components: { component?: { custom_id?: string; options?: { value: string }[] } }[];
    };
    const games = json.components.find((c) => c.component?.custom_id === "games");
    expect(games?.component?.options?.map((o) => o.value)).toEqual(["1", "2"]);
  });

  it("stays within Discord's 25-option select limit", () => {
    const big: Game[] = Array.from({ length: 30 }, (_, i) => ({
      id: i + 1,
      name: `Game ${i + 1}`,
      minPlayers: 1,
      maxPlayers: null,
    }));
    const json = buildGameNightCreateModal(big).toJSON() as {
      components: { component?: { custom_id?: string; options?: unknown[] } }[];
    };
    const games = json.components.find((c) => c.component?.custom_id === "games");
    expect(games?.component?.options).toHaveLength(25);
  });
});
