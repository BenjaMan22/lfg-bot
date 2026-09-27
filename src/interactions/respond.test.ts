import { beforeEach, describe, expect, it } from "vitest";
import { openDatabase } from "../db/index.js";
import { cancelNight, createDraftNight, publishNight } from "../db/repos/nights.js";
import type { AppContext } from "../context.js";
import type { Config } from "../config.js";
import { availabilityPicker } from "./respond.js";

let ctx: AppContext;
const CONFIG: Config = { token: "", applicationId: "", devGuildId: null, databasePath: ":memory:" };

function openNight(): number {
  const id = createDraftNight(ctx.db, {
    guildId: "g1",
    channelId: "c1",
    hostId: "u1",
    title: "Game Night",
    displayTz: "America/Chicago",
    minSessionHours: 2,
    deadlineUtc: 1000,
    voiceChannelId: null,
    // 7:30pm–10:30pm Chicago on Oct 6 2026: six half-hour slots.
    days: [{ dayIndex: 0, startUtc: 1791333000, endUtc: 1791343800 }],
    createdUtc: 0,
  });
  publishNight(ctx.db, id, "m1");
  return id;
}

beforeEach(() => {
  ctx = { db: openDatabase(":memory:"), config: CONFIG };
});

describe("availabilityPicker", () => {
  it("offers one dropdown per day, in the person's timezone", () => {
    const picker = availabilityPicker(ctx, openNight(), "u2", "America/New_York");
    expect(picker.content).toContain("**America/New_York**");
    expect(picker.components).toHaveLength(1);
    const options = picker.components[0].toJSON().components[0].options;
    expect(options.map((o) => o.label)).toEqual(["8:30p", "9p", "9:30p", "10p", "10:30p", "11p"]);
  });

  it("says the poll is over instead of offering a picker", () => {
    const id = openNight();
    cancelNight(ctx.db, id);
    const picker = availabilityPicker(ctx, id, "u2", "America/New_York");
    expect(picker.components).toEqual([]);
    expect(picker.content).toMatch(/closed/i);
  });
});
