import { beforeEach, describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { openDatabase } from "../index.js";
import {
  addGame,
  findGameByName,
  getGamesByIds,
  listGames,
  removeGame,
} from "./games.js";

let db: DatabaseSync;
beforeEach(() => {
  db = openDatabase(":memory:");
});

describe("games repository", () => {
  it("adds and reads back a game", () => {
    const game = addGame(db, "g1", "Deep Rock", 2, 4, "u1");
    expect(game).toEqual({ id: game.id, name: "Deep Rock", minPlayers: 2, maxPlayers: 4 });
    expect(listGames(db, "g1")).toEqual([game]);
  });

  it("stores an unlimited maximum as null", () => {
    const game = addGame(db, "g1", "Valheim", 1, null, "u1");
    expect(game.maxPlayers).toBeNull();
  });

  it("keeps guilds separate", () => {
    addGame(db, "g1", "Deep Rock", 2, 4, "u1");
    expect(listGames(db, "g2")).toEqual([]);
  });

  it("finds a game case-insensitively", () => {
    addGame(db, "g1", "Deep Rock", 2, 4, "u1");
    expect(findGameByName(db, "g1", "  deep ROCK ")?.name).toBe("Deep Rock");
  });

  it("rejects a duplicate name in the same guild", () => {
    addGame(db, "g1", "Deep Rock", 2, 4, "u1");
    expect(() => addGame(db, "g1", "deep rock", 3, 5, "u2")).toThrow();
  });

  it("rejects a maximum below the minimum", () => {
    expect(() => addGame(db, "g1", "Bad", 4, 2, "u1")).toThrow();
  });

  it("rejects a minimum below one", () => {
    expect(() => addGame(db, "g1", "Bad", 0, 4, "u1")).toThrow();
  });

  it("lists games alphabetically", () => {
    addGame(db, "g1", "Zomboid", 1, null, "u1");
    addGame(db, "g1", "Astroneer", 1, null, "u1");
    expect(listGames(db, "g1").map((g) => g.name)).toEqual(["Astroneer", "Zomboid"]);
  });

  it("fetches a set of games by id", () => {
    const a = addGame(db, "g1", "A", 1, null, "u1");
    const b = addGame(db, "g1", "B", 1, null, "u1");
    addGame(db, "g1", "C", 1, null, "u1");
    expect(getGamesByIds(db, [a.id, b.id]).map((g) => g.name)).toEqual(["A", "B"]);
  });

  it("returns an empty list for no ids rather than failing", () => {
    expect(getGamesByIds(db, [])).toEqual([]);
  });

  it("lets the creator remove their own game", () => {
    addGame(db, "g1", "Deep Rock", 2, 4, "u1");
    expect(removeGame(db, "g1", "Deep Rock", "u1", false)).toBe("removed");
    expect(listGames(db, "g1")).toEqual([]);
  });

  it("refuses removal by another member without force", () => {
    addGame(db, "g1", "Deep Rock", 2, 4, "u1");
    expect(removeGame(db, "g1", "Deep Rock", "u2", false)).toBe("forbidden");
    expect(listGames(db, "g1")).toHaveLength(1);
  });

  it("allows a moderator to force removal", () => {
    addGame(db, "g1", "Deep Rock", 2, 4, "u1");
    expect(removeGame(db, "g1", "Deep Rock", "u2", true)).toBe("removed");
  });

  it("reports not_found for a game that was never added", () => {
    expect(removeGame(db, "g1", "Nonexistent", "u1", false)).toBe("not_found");
  });
});
