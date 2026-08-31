import { describe, expect, it } from "vitest";
import { buildGameSetupComponents, librarySelectNote } from "./setup.js";
import type { Game } from "../domain/scheduling.js";

const catan: Game = { id: 1, name: "Catan", minPlayers: 3, maxPlayers: 4 };
const lethal: Game = { id: 2, name: "Lethal Company", minPlayers: 2, maxPlayers: 4 };
const added: Game = { id: 3, name: "Added Later", minPlayers: 2, maxPlayers: null };

describe("buildGameSetupComponents", () => {
  it("offers every library game as an option", () => {
    const [gameRow] = buildGameSetupComponents(1, [catan, lethal], [], null);
    const select = gameRow.toJSON().components[0];
    expect(select.options.map((o) => o.value)).toEqual(["1", "2"]);
  });

  it("includes a game added after the select was first built", () => {
    // Regression for I5: the setup select used to be built once at
    // /gamenight create time and never rebuilt, so a game suggested later
    // via "Add a game" was never among its options and silently vanished
    // the next time the host adjusted their picks.
    const [gameRow] = buildGameSetupComponents(1, [catan, lethal, added], [], null);
    const select = gameRow.toJSON().components[0];
    expect(select.options.map((o) => o.value)).toContain("3");
  });

  it("pre-selects the host's current picks with default:true", () => {
    const [gameRow] = buildGameSetupComponents(
      1,
      [catan, lethal, added],
      [lethal.id, added.id],
      null,
    );
    const select = gameRow.toJSON().components[0];
    const byValue = new Map(select.options.map((o) => [o.value, o.default ?? false]));
    expect(byValue.get(String(catan.id))).toBe(false);
    expect(byValue.get(String(lethal.id))).toBe(true);
    expect(byValue.get(String(added.id))).toBe(true);
  });

  it("caps the select at Discord's 25-option limit", () => {
    const library: Game[] = Array.from({ length: 30 }, (_, i) => ({
      id: i + 1,
      name: `Game ${i + 1}`,
      minPlayers: 1,
      maxPlayers: null,
    }));
    const [gameRow] = buildGameSetupComponents(1, library, [], null);
    const select = gameRow.toJSON().components[0];
    expect(select.options).toHaveLength(25);
  });

  it("says nothing when the whole library fits in the select", () => {
    expect(librarySelectNote(25)).toBe("");
  });

  it("warns when the library is too big for the select to show it all", () => {
    // Regression: the select silently sliced the library at 25, so in a guild
    // with more games the alphabetical tail simply was not offerable and the
    // host had no way to know why.
    const note = librarySelectNote(30);
    expect(note).toMatch(/25/);
    expect(note).toMatch(/5/);
  });

  it("includes the add-a-game and post-it buttons", () => {
    const [, , buttonRow] = buildGameSetupComponents(9, [catan], [], null);
    const customIds = buttonRow
      .toJSON()
      .components.map((c) => ("custom_id" in c ? c.custom_id : undefined));
    expect(customIds).toEqual(["gn:setupadd:9", "gn:post:9"]);
  });

  it("leaves the voice channel unselected when none is stored", () => {
    const [, voiceRow] = buildGameSetupComponents(9, [catan], [], null);
    const select = voiceRow.toJSON().components[0];
    expect(select.default_values ?? []).toEqual([]);
  });

  it("pre-selects the currently stored voice channel", () => {
    const [, voiceRow] = buildGameSetupComponents(9, [catan], [], "voice-42");
    const select = voiceRow.toJSON().components[0];
    expect(select.default_values).toEqual([{ id: "voice-42", type: "channel" }]);
  });
});
