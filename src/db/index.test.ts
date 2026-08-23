import { describe, expect, it } from "vitest";
import { openDatabase, withTransaction } from "./index.js";

// Uses the `games` table from schema.sql as a convenient real table to
// exercise commit/rollback against, rather than inventing a throwaway one.

describe("withTransaction", () => {
  it("commits and returns the work's value when work succeeds", () => {
    const db = openDatabase(":memory:");
    const result = withTransaction(db, () => {
      db.prepare(
        "INSERT INTO games (guild_id, name, min_players, max_players, created_by) VALUES (?, ?, ?, ?, ?)",
      ).run("g1", "A", 1, null, "u1");
      return "ok";
    });
    expect(result).toBe("ok");
    expect(db.prepare("SELECT COUNT(*) AS c FROM games").get()).toEqual({ c: 1 });
  });

  it("rolls back and propagates the error when work throws", () => {
    const db = openDatabase(":memory:");
    expect(() =>
      withTransaction(db, () => {
        db.prepare(
          "INSERT INTO games (guild_id, name, min_players, max_players, created_by) VALUES (?, ?, ?, ?, ?)",
        ).run("g1", "A", 1, null, "u1");
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(db.prepare("SELECT COUNT(*) AS c FROM games").get()).toEqual({ c: 0 });
  });
});
