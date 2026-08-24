import { beforeEach, describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { openDatabase } from "../index.js";
import { addGame } from "./games.js";
import {
  clearUserResponses,
  createDraftNight,
  dueNights,
  deleteStaleDrafts,
  failNight,
  getAvailability,
  getCancellableNightForChannel,
  getNight,
  getNightDays,
  getNightGameIds,
  getOpenNightForChannel,
  getResponderIds,
  getVotes,
  lockNight,
  publishNight,
  setAttendance,
  setAvailabilityForDay,
  setNightGames,
  setVotes,
} from "./nights.js";

let db: DatabaseSync;
const HOUR = 3600;
/** A fixed "now" for the cancellable-night tests, well after DAYS. */
const NOW = 2_000_000 * HOUR;
const DAYS = [
  { dayIndex: 0, startUtc: 1_000_000 * 3600, endUtc: 1_000_005 * 3600 },
  { dayIndex: 1, startUtc: 1_000_024 * 3600, endUtc: 1_000_029 * 3600 },
];

function makeDraftIn(channelId: string): number {
  return createDraftNight(db, {
    guildId: "g1",
    channelId,
    hostId: "u1",
    title: "Game Night",
    displayTz: "America/Chicago",
    minSessionHours: 2,
    deadlineUtc: 1_000_000 * 3600 - 3600,
    voiceChannelId: null,
    days: DAYS,
    createdUtc: 1_000_000 * 3600 - 7200,
  });
}

function makeDraft(): number {
  return makeDraftIn("c1");
}

beforeEach(() => {
  db = openDatabase(":memory:");
});

describe("nights repository", () => {
  it("creates a draft that is not yet the channel's open night", () => {
    const id = makeDraft();
    expect(getNight(db, id)?.status).toBe("draft");
    expect(getOpenNightForChannel(db, "c1")).toBeNull();
  });

  it("stores the days", () => {
    const id = makeDraft();
    expect(getNightDays(db, id)).toEqual(DAYS);
  });

  it("publishing makes it the channel's open night", () => {
    const id = makeDraft();
    publishNight(db, id, "m1");
    const night = getOpenNightForChannel(db, "c1");
    expect(night?.id).toBe(id);
    expect(night?.messageId).toBe("m1");
  });

  it("refuses to publish the same draft twice", () => {
    const id = makeDraft();
    expect(publishNight(db, id, "m1")).toBe(true);
    expect(publishNight(db, id, "m2")).toBe(false);
    expect(getNight(db, id)?.messageId).toBe("m1");
  });

  it("refuses a second open night in the same channel", () => {
    const first = makeDraftIn("c5");
    const second = makeDraftIn("c5");
    publishNight(db, first, "m1");
    expect(() => publishNight(db, second, "m2")).toThrow();
    expect(getOpenNightForChannel(db, "c5")?.id).toBe(first);
  });

  it("lets a channel open a new night once the previous one is finished", () => {
    const game = addGame(db, "g1", "A", 1, null, "u1");
    const first = makeDraftIn("c5");
    publishNight(db, first, "m1");
    lockNight(db, first, DAYS[0].startUtc, DAYS[0].endUtc, game.id, "e1");
    const second = makeDraftIn("c5");
    expect(publishNight(db, second, "m2")).toBe(true);
    expect(getOpenNightForChannel(db, "c5")?.id).toBe(second);
  });

  it("replaces the game set rather than appending", () => {
    const id = makeDraft();
    const a = addGame(db, "g1", "A", 1, null, "u1");
    const b = addGame(db, "g1", "B", 1, null, "u1");
    setNightGames(db, id, [a.id, b.id]);
    setNightGames(db, id, [b.id]);
    expect(getNightGameIds(db, id)).toEqual([b.id]);
  });

  it("records availability for one day without touching another", () => {
    const id = makeDraft();
    const day0 = [DAYS[0].startUtc, DAYS[0].startUtc + 3600];
    const day1 = [DAYS[1].startUtc, DAYS[1].startUtc + 3600];
    setAvailabilityForDay(db, id, "u1", day0, day0);
    setAvailabilityForDay(db, id, "u1", day1, [DAYS[1].startUtc]);
    setAvailabilityForDay(db, id, "u1", day0, [DAYS[0].startUtc]);
    expect([...getAvailability(db, id).get("u1")!].sort()).toEqual(
      [DAYS[0].startUtc, DAYS[1].startUtc].sort(),
    );
  });

  it("clearing a day's selection removes only that day", () => {
    const id = makeDraft();
    const day0 = [DAYS[0].startUtc];
    const day1 = [DAYS[1].startUtc];
    setAvailabilityForDay(db, id, "u1", day0, day0);
    setAvailabilityForDay(db, id, "u1", day1, day1);
    setAvailabilityForDay(db, id, "u1", day0, []);
    expect([...getAvailability(db, id).get("u1")!]).toEqual(day1);
  });

  it("replaces votes wholesale", () => {
    const id = makeDraft();
    const a = addGame(db, "g1", "A", 1, null, "u1");
    const b = addGame(db, "g1", "B", 1, null, "u1");
    setVotes(db, id, "u1", [a.id, b.id]);
    setVotes(db, id, "u1", [a.id]);
    expect([...getVotes(db, id).get("u1")!]).toEqual([a.id]);
  });

  it("counts availability, votes, or attendance as having responded", () => {
    const id = makeDraft();
    const game = addGame(db, "g1", "A", 1, null, "u1");
    setAvailabilityForDay(db, id, "avail", [DAYS[0].startUtc], [DAYS[0].startUtc]);
    setVotes(db, id, "voter", [game.id]);
    setAttendance(db, id, "opted", "out");
    expect(getResponderIds(db, id)).toEqual(new Set(["avail", "voter", "opted"]));
  });

  it("does not count an empty availability submission as a response", () => {
    const id = makeDraft();
    setAvailabilityForDay(db, id, "u1", [DAYS[0].startUtc], []);
    expect(getResponderIds(db, id).has("u1")).toBe(false);
  });

  it("clears every trace of a user's response", () => {
    const id = makeDraft();
    const game = addGame(db, "g1", "A", 1, null, "u1");
    setAvailabilityForDay(db, id, "u1", [DAYS[0].startUtc], [DAYS[0].startUtc]);
    setVotes(db, id, "u1", [game.id]);
    clearUserResponses(db, id, "u1");
    expect(getAvailability(db, id).has("u1")).toBe(false);
    expect(getVotes(db, id).has("u1")).toBe(false);
  });

  it("returns only open nights past their deadline", () => {
    const id = makeDraft();
    publishNight(db, id, "m1");
    const deadline = getNight(db, id)!.deadlineUtc;
    expect(dueNights(db, deadline - 1)).toEqual([]);
    expect(dueNights(db, deadline).map((n) => n.id)).toEqual([id]);
  });

  it("stops returning a night once it is locked", () => {
    const id = makeDraft();
    publishNight(db, id, "m1");
    const game = addGame(db, "g1", "A", 1, null, "u1");
    lockNight(db, id, DAYS[0].startUtc, DAYS[0].endUtc, game.id, "e1");
    expect(dueNights(db, DAYS[0].endUtc)).toEqual([]);
    expect(getNight(db, id)?.status).toBe("locked");
    expect(getNight(db, id)?.eventId).toBe("e1");
  });

  it("records why a night failed", () => {
    const id = makeDraft();
    publishNight(db, id, "m1");
    failNight(db, id, "lock_error");
    expect(getNight(db, id)?.status).toBe("failed");
    expect(getNight(db, id)?.failureReason).toBe("lock_error");
  });

  it("never downgrades a locked night to failed", () => {
    const id = makeDraft();
    publishNight(db, id, "m1");
    const game = addGame(db, "g1", "A", 1, null, "u1");
    lockNight(db, id, DAYS[0].startUtc, DAYS[0].endUtc, game.id, "e1");
    failNight(db, id, "lock_error");
    expect(getNight(db, id)?.status).toBe("locked");
    expect(getNight(db, id)?.failureReason).toBeNull();
  });

  it("deletes stale drafts and nothing else", () => {
    const draft = makeDraft();
    const published = makeDraft();
    publishNight(db, published, "m1");
    deleteStaleDrafts(db, 1_000_000 * 3600);
    expect(getNight(db, draft)).toBeNull();
    expect(getNight(db, published)).not.toBeNull();
  });

  it("finds the live open night, not an old finished one, to cancel", () => {
    const game = addGame(db, "g1", "A", 1, null, "u1");
    const finished = makeDraftIn("c9");
    publishNight(db, finished, "m-old");
    lockNight(db, finished, NOW - 10 * HOUR, NOW - 8 * HOUR, game.id, "e-old");
    const live = makeDraftIn("c9");
    publishNight(db, live, "m-live");

    expect(getCancellableNightForChannel(db, "c9", NOW)?.id).toBe(live);
  });

  it("can cancel a locked night whose window has not ended yet", () => {
    const game = addGame(db, "g1", "A", 1, null, "u1");
    const id = makeDraftIn("c9");
    publishNight(db, id, "m1");
    lockNight(db, id, NOW - HOUR, NOW + 2 * HOUR, game.id, "e1");

    expect(getCancellableNightForChannel(db, "c9", NOW)?.id).toBe(id);
  });

  it("has nothing to cancel once the only locked night has finished", () => {
    const game = addGame(db, "g1", "A", 1, null, "u1");
    const id = makeDraftIn("c9");
    publishNight(db, id, "m1");
    lockNight(db, id, NOW - 4 * HOUR, NOW - HOUR, game.id, "e1");

    expect(getCancellableNightForChannel(db, "c9", NOW)).toBeNull();
  });

  it("prefers the open night even when a locked one is newer", () => {
    const game = addGame(db, "g1", "A", 1, null, "u1");
    const open = makeDraftIn("c9");
    publishNight(db, open, "m-open");
    // Locked straight from draft: publishing it first would mean two open
    // nights in one channel, which the schema forbids.
    const newerLocked = makeDraftIn("c9");
    lockNight(db, newerLocked, NOW, NOW + 3 * HOUR, game.id, "e-new");
    expect(newerLocked).toBeGreaterThan(open);

    expect(getCancellableNightForChannel(db, "c9", NOW)?.id).toBe(open);
  });

  it("rolls back the whole night when a day insert fails", () => {
    expect(() =>
      createDraftNight(db, {
        guildId: "g1",
        channelId: "c1",
        hostId: "u1",
        title: "Game Night",
        displayTz: "America/Chicago",
        minSessionHours: 2,
        deadlineUtc: 1_000_000 * 3600 - 3600,
        voiceChannelId: null,
        // Duplicate dayIndex violates night_days' primary key.
        days: [
          { dayIndex: 0, startUtc: 1_000_000 * 3600, endUtc: 1_000_005 * 3600 },
          { dayIndex: 0, startUtc: 1_000_024 * 3600, endUtc: 1_000_029 * 3600 },
        ],
        createdUtc: 1_000_000 * 3600 - 7200,
      }),
    ).toThrow();
    expect(getOpenNightForChannel(db, "c1")).toBeNull();
    const count = db.prepare("SELECT COUNT(*) AS c FROM nights").get() as {
      c: number;
    };
    expect(count.c).toBe(0);
  });
});
