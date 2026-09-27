import { beforeEach, describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { openDatabase } from "../index.js";
import { addGame } from "./games.js";
import {
  addNightGame,
  cancelNight,
  clearUserResponses,
  createDraftNight,
  dueNights,
  deleteStaleDrafts,
  failNight,
  getAvailability,
  getNight,
  getNightDays,
  getNightGameIds,
  getResponderIds,
  getVotes,
  lockNight,
  publishNight,
  setAttendance,
  setAvailabilityForDay,
  setNightGames,
  nightsToUnpin,
  setAllowSuggestions,
  setNightPinned,
  setVoiceChannel,
  setVotes,
} from "./nights.js";

let db: DatabaseSync;
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
  it("creates a draft", () => {
    const id = makeDraft();
    expect(getNight(db, id)?.status).toBe("draft");
  });

  it("stores the days", () => {
    const id = makeDraft();
    expect(getNightDays(db, id)).toEqual(DAYS);
  });

  it("publishing opens the night with its message", () => {
    const id = makeDraft();
    publishNight(db, id, "m1");
    const night = getNight(db, id);
    expect(night?.status).toBe("open");
    expect(night?.messageId).toBe("m1");
  });

  it("sets the voice channel on a draft night", () => {
    const id = makeDraft();
    setVoiceChannel(db, id, "voice-1");
    expect(getNight(db, id)?.voiceChannelId).toBe("voice-1");
  });

  it("clears the voice channel back to null", () => {
    const id = makeDraft();
    setVoiceChannel(db, id, "voice-1");
    setVoiceChannel(db, id, null);
    expect(getNight(db, id)?.voiceChannelId).toBeNull();
  });

  it("does not touch a night that is no longer a draft", () => {
    const id = makeDraft();
    publishNight(db, id, "m1");
    setVoiceChannel(db, id, "voice-1");
    expect(getNight(db, id)?.voiceChannelId).toBeNull();
  });

  it("allows suggestions by default", () => {
    expect(getNight(db, makeDraft())?.allowSuggestions).toBe(true);
  });

  it("switches suggestions off and back on while a draft", () => {
    const id = makeDraft();
    expect(setAllowSuggestions(db, id, false)).toBe(true);
    expect(getNight(db, id)?.allowSuggestions).toBe(false);
    setAllowSuggestions(db, id, true);
    expect(getNight(db, id)?.allowSuggestions).toBe(true);
  });

  it("does not change suggestions once the night is posted", () => {
    const id = makeDraft();
    publishNight(db, id, "m1");
    expect(setAllowSuggestions(db, id, false)).toBe(false);
    expect(getNight(db, id)?.allowSuggestions).toBe(true);
  });

  it("refuses to publish the same draft twice", () => {
    const id = makeDraft();
    expect(publishNight(db, id, "m1")).toBe(true);
    expect(publishNight(db, id, "m2")).toBe(false);
    expect(getNight(db, id)?.messageId).toBe("m1");
  });

  it("allows several open nights in the same channel", () => {
    const first = makeDraftIn("c5");
    const second = makeDraftIn("c5");
    expect(publishNight(db, first, "m1")).toBe(true);
    expect(publishNight(db, second, "m2")).toBe(true);
    expect(getNight(db, first)?.status).toBe("open");
    expect(getNight(db, second)?.status).toBe("open");
  });

  it("replaces the game set rather than appending", () => {
    const id = makeDraft();
    const a = addGame(db, "g1", "A", null, "u1");
    const b = addGame(db, "g1", "B", null, "u1");
    setNightGames(db, id, [a.id, b.id]);
    setNightGames(db, id, [b.id]);
    expect(getNightGameIds(db, id)).toEqual([b.id]);
  });

  it("does not replace the game set of a night that is already open", () => {
    // Regression: the ephemeral setup message stays clickable for ~15
    // minutes after Post it. A late touch of its games dropdown used to
    // rewrite a live poll's games — dropping ones people had already voted
    // for, whose votes then silently stopped counting.
    const id = makeDraft();
    const a = addGame(db, "g1", "A", null, "u1");
    setNightGames(db, id, [a.id]);
    publishNight(db, id, "m1");
    expect(setNightGames(db, id, [])).toBe(false);
    expect(getNightGameIds(db, id)).toEqual([a.id]);
  });

  it("reports whether the replacement applied", () => {
    const id = makeDraft();
    const a = addGame(db, "g1", "A", null, "u1");
    expect(setNightGames(db, id, [a.id])).toBe(true);
  });

  it("appends a suggested game to a night that is already open", () => {
    // "Suggest a game" adds to a live poll, so appending must stay allowed
    // even though wholesale replacement is now draft-only.
    const id = makeDraft();
    const a = addGame(db, "g1", "A", null, "u1");
    const b = addGame(db, "g1", "B", null, "u1");
    setNightGames(db, id, [a.id]);
    publishNight(db, id, "m1");
    expect(addNightGame(db, id, b.id)).toBe(true);
    expect(getNightGameIds(db, id)).toEqual([a.id, b.id]);
  });

  it("appends a suggested game to a draft", () => {
    const id = makeDraft();
    const a = addGame(db, "g1", "A", null, "u1");
    expect(addNightGame(db, id, a.id)).toBe(true);
    expect(getNightGameIds(db, id)).toEqual([a.id]);
  });

  it("ignores a game the night already carries", () => {
    const id = makeDraft();
    const a = addGame(db, "g1", "A", null, "u1");
    addNightGame(db, id, a.id);
    expect(addNightGame(db, id, a.id)).toBe(false);
    expect(getNightGameIds(db, id)).toEqual([a.id]);
  });

  it("does not append to a night that is no longer taking responses", () => {
    const id = makeDraft();
    const a = addGame(db, "g1", "A", null, "u1");
    setNightGames(db, id, [a.id]);
    publishNight(db, id, "m1");
    const b = addGame(db, "g1", "B", null, "u1");
    cancelNight(db, id);
    expect(addNightGame(db, id, b.id)).toBe(false);
    expect(getNightGameIds(db, id)).toEqual([a.id]);
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
    const a = addGame(db, "g1", "A", null, "u1");
    const b = addGame(db, "g1", "B", null, "u1");
    setVotes(db, id, "u1", [a.id, b.id]);
    setVotes(db, id, "u1", [a.id]);
    expect([...getVotes(db, id).get("u1")!]).toEqual([a.id]);
  });

  it("counts availability, votes, or attendance as having responded", () => {
    const id = makeDraft();
    const game = addGame(db, "g1", "A", null, "u1");
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
    const game = addGame(db, "g1", "A", null, "u1");
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
    const game = addGame(db, "g1", "A", null, "u1");
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
    const game = addGame(db, "g1", "A", null, "u1");
    lockNight(db, id, DAYS[0].startUtc, DAYS[0].endUtc, game.id, "e1");
    failNight(db, id, "lock_error");
    expect(getNight(db, id)?.status).toBe("locked");
    expect(getNight(db, id)?.failureReason).toBeNull();
  });

  it("never locks a night that was cancelled while the sweep was working", () => {
    // Regression: lockOne does two Discord round trips (the poll view, then
    // the Scheduled Event) between reading a due night and committing the
    // lock. A cancel landing in that window used to be overwritten
    // — the canceller got "Cancelled." and the channel got a roster ping.
    const id = makeDraft();
    publishNight(db, id, "m1");
    const game = addGame(db, "g1", "A", null, "u1");
    cancelNight(db, id);
    const locked = lockNight(db, id, DAYS[0].startUtc, DAYS[0].endUtc, game.id, "e1");
    expect(locked).toBe(false);
    expect(getNight(db, id)?.status).toBe("cancelled");
    expect(getNight(db, id)?.eventId).toBeNull();
  });

  it("reports a successful lock so the caller knows it may announce", () => {
    const id = makeDraft();
    publishNight(db, id, "m1");
    const game = addGame(db, "g1", "A", null, "u1");
    expect(lockNight(db, id, DAYS[0].startUtc, DAYS[0].endUtc, game.id, "e1")).toBe(true);
  });

  it("deletes stale drafts and nothing else", () => {
    const draft = makeDraft();
    const published = makeDraft();
    publishNight(db, published, "m1");
    deleteStaleDrafts(db, 1_000_000 * 3600);
    expect(getNight(db, draft)).toBeNull();
    expect(getNight(db, published)).not.toBeNull();
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
    const count = db.prepare("SELECT COUNT(*) AS c FROM nights").get() as {
      c: number;
    };
    expect(count.c).toBe(0);
  });
});

describe("pinned polls", () => {
  const HOUR = 3600;
  const NOW = 2_000_000 * HOUR;

  function pinnedOpenNight(): number {
    const id = makeDraft();
    publishNight(db, id, "m1");
    setNightPinned(db, id, true);
    return id;
  }

  const toUnpin = () => nightsToUnpin(db, NOW).map((n) => n.id);

  it("starts unpinned and records a pin", () => {
    const id = makeDraft();
    expect(getNight(db, id)?.pinned).toBe(false);
    setNightPinned(db, id, true);
    expect(getNight(db, id)?.pinned).toBe(true);
  });

  it("keeps an open night pinned", () => {
    pinnedOpenNight();
    expect(toUnpin()).toEqual([]);
  });

  it("keeps a locked night pinned until its window ends", () => {
    const game = addGame(db, "g1", "A", null, "u1");
    const running = pinnedOpenNight();
    lockNight(db, running, NOW - HOUR, NOW + HOUR, game.id, "e1");
    const over = pinnedOpenNight();
    lockNight(db, over, NOW - 3 * HOUR, NOW - HOUR, game.id, "e2");
    expect(toUnpin()).toEqual([over]);
  });

  it("unpins a cancelled or failed night straight away", () => {
    const cancelled = pinnedOpenNight();
    cancelNight(db, cancelled);
    const failed = pinnedOpenNight();
    failNight(db, failed, "no_viable");
    expect(toUnpin().sort()).toEqual([cancelled, failed].sort());
  });

  it("forgets a night once it is unpinned", () => {
    const id = pinnedOpenNight();
    cancelNight(db, id);
    setNightPinned(db, id, false);
    expect(toUnpin()).toEqual([]);
  });
});
