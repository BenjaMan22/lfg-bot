import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";

const full = {
  DISCORD_TOKEN: "t",
  DISCORD_APPLICATION_ID: "a",
  DISCORD_DEV_GUILD_ID: "g",
  DATABASE_PATH: "data/test.db",
};

describe("loadConfig", () => {
  it("reads every value", () => {
    expect(loadConfig(full)).toEqual({
      token: "t",
      applicationId: "a",
      devGuildId: "g",
      databasePath: "data/test.db",
    });
  });

  it("treats the dev guild as optional", () => {
    const { DISCORD_DEV_GUILD_ID, ...rest } = full;
    expect(loadConfig(rest).devGuildId).toBeNull();
  });

  it("defaults the database path", () => {
    const { DATABASE_PATH, ...rest } = full;
    expect(loadConfig(rest).databasePath).toBe("data/gamenight.db");
  });

  it("names the missing variable when the token is absent", () => {
    const { DISCORD_TOKEN, ...rest } = full;
    expect(() => loadConfig(rest)).toThrow(/DISCORD_TOKEN/);
  });

  it("rejects an empty token rather than accepting it", () => {
    expect(() => loadConfig({ ...full, DISCORD_TOKEN: "  " })).toThrow(/DISCORD_TOKEN/);
  });
});
