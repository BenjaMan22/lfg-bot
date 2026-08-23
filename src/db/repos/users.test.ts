import { beforeEach, describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { openDatabase } from "../index.js";
import { getTimezone, setTimezone } from "./users.js";

let db: DatabaseSync;
beforeEach(() => {
  db = openDatabase(":memory:");
});

describe("users repository", () => {
  it("returns null before a timezone is set", () => {
    expect(getTimezone(db, "u1")).toBeNull();
  });

  it("stores and reads a timezone", () => {
    setTimezone(db, "u1", "America/Chicago");
    expect(getTimezone(db, "u1")).toBe("America/Chicago");
  });

  it("overwrites on change rather than duplicating", () => {
    setTimezone(db, "u1", "America/Chicago");
    setTimezone(db, "u1", "Europe/London");
    expect(getTimezone(db, "u1")).toBe("Europe/London");
  });
});
