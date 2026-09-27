import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

describe("openDatabase", () => {
  it("drops the old one-open-night-per-channel rule from an existing database", () => {
    const path = join(mkdtempSync(join(tmpdir(), "gn-")), "old.db");
    // A database as an older version left it: the unique index in place.
    const old = openDatabase(path);
    old.exec(
      "CREATE UNIQUE INDEX nights_one_open_per_channel ON nights (channel_id) WHERE status = 'open'",
    );
    old.close();

    const db = openDatabase(path);
    const index = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?")
      .get("nights_one_open_per_channel");
    expect(index).toBeUndefined();
    db.close();
  });
});
