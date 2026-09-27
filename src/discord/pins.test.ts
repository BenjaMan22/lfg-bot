import { beforeEach, describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { openDatabase } from "../db/index.js";
import {
  cancelNight,
  createDraftNight,
  getNight,
  publishNight,
  setNightPinned,
} from "../db/repos/nights.js";
import { isPermanentDiscordError, unpinFinishedNights } from "./pins.js";

let db: DatabaseSync;

function cancelledPinnedNight(): number {
  const id = createDraftNight(db, {
    guildId: "g1",
    channelId: "c1",
    hostId: "u1",
    title: "Game Night",
    displayTz: "America/Chicago",
    minSessionHours: 2,
    deadlineUtc: 1000,
    voiceChannelId: null,
    days: [{ dayIndex: 0, startUtc: 5000, endUtc: 9000 }],
    createdUtc: 0,
  });
  publishNight(db, id, "m1");
  setNightPinned(db, id, true);
  cancelNight(db, id);
  return id;
}

beforeEach(() => {
  db = openDatabase(":memory:");
});

describe("isPermanentDiscordError", () => {
  it("gives up on a client error that retrying cannot fix", () => {
    expect(isPermanentDiscordError({ status: 404 })).toBe(true);
    expect(isPermanentDiscordError({ status: 403 })).toBe(true);
  });

  it("retries a rate limit, a server error, or anything else", () => {
    expect(isPermanentDiscordError({ status: 429 })).toBe(false);
    expect(isPermanentDiscordError({ status: 503 })).toBe(false);
    expect(isPermanentDiscordError(new Error("socket hang up"))).toBe(false);
  });
});

describe("unpinFinishedNights", () => {
  it("unpins a finished night's poll and stops tracking it", async () => {
    const id = cancelledPinnedNight();
    const calls: string[] = [];
    await unpinFinishedNights(db, 0, async (channelId, messageId) => {
      calls.push(`${channelId}/${messageId}`);
    });
    expect(calls).toEqual(["c1/m1"]);
    expect(getNight(db, id)?.pinned).toBe(false);
  });

  it("stops trying when the message is gone", async () => {
    const id = cancelledPinnedNight();
    await unpinFinishedNights(db, 0, () => Promise.reject({ status: 404 }));
    expect(getNight(db, id)?.pinned).toBe(false);
  });

  it("tries again next sweep after a passing failure", async () => {
    const id = cancelledPinnedNight();
    await unpinFinishedNights(db, 0, () => Promise.reject({ status: 503 }));
    expect(getNight(db, id)?.pinned).toBe(true);
  });
});
