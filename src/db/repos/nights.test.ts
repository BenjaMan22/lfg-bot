import { beforeEach, describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { openDatabase } from "../index.js";
import { addGame } from "./games.js";
import {
  clearUserResponses,
  createDraftNight,
  dueNights,
  deleteStaleDrafts,
  getAvailability,
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
const DAYS = [
  { dayIndex: 0, startUtc: 1_000_000 * 3600, endUtc: 1_000_005 * 3600 },
  { dayIndex: 1, startUtc: 1_000_024 * 3600, endUtc: 1_000_029 * 3600 },
];

function makeDraft(): number {
  return createDraftNight(db, {
    guildId: "g1",
    channelId: "c1",
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

  it("deletes stale drafts and nothing else", () => {
    const draft = makeDraft();
    const published = makeDraft();
    publishNight(db, published, "m1");
    deleteStaleDrafts(db, 1_000_000 * 3600);
    expect(getNight(db, draft)).toBeNull();
    expect(getNight(db, published)).not.toBeNull();
  });
});
