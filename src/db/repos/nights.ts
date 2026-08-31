import type { DatabaseSync } from "node:sqlite";
import type { NightDay } from "../../domain/timeblocks.js";
import { allRows, withTransaction } from "../index.js";

export type NightStatus = "draft" | "open" | "locked" | "failed" | "cancelled";

/**
 * Why a night ended up `failed`. `no_viable` is the domain outcome — the
 * ranking found no combination clearing any game's minimum. `lock_error` is
 * an infrastructure give-up: the lock kept throwing past its retry window.
 * The two say very different things to a channel, so they are stored rather
 * than inferred at render time.
 */
export type NightFailureReason = "no_viable" | "lock_error";

export interface NightRow {
  id: number;
  guildId: string;
  channelId: string;
  messageId: string | null;
  hostId: string;
  title: string;
  displayTz: string;
  minSessionHours: number;
  deadlineUtc: number;
  status: NightStatus;
  voiceChannelId: string | null;
  lockedStartUtc: number | null;
  lockedEndUtc: number | null;
  lockedGameId: number | null;
  eventId: string | null;
  failureReason: NightFailureReason | null;
}

export interface CreateNightInput {
  guildId: string;
  channelId: string;
  hostId: string;
  title: string;
  displayTz: string;
  minSessionHours: number;
  deadlineUtc: number;
  voiceChannelId: string | null;
  days: NightDay[];
  createdUtc: number;
}

interface NightDbRow {
  id: number;
  guild_id: string;
  channel_id: string;
  message_id: string | null;
  host_id: string;
  title: string;
  display_tz: string;
  min_session_hours: number;
  deadline_utc: number;
  status: NightStatus;
  voice_channel_id: string | null;
  locked_start_utc: number | null;
  locked_end_utc: number | null;
  locked_game_id: number | null;
  event_id: string | null;
  failure_reason: NightFailureReason | null;
}

const toNight = (r: NightDbRow): NightRow => ({
  id: r.id,
  guildId: r.guild_id,
  channelId: r.channel_id,
  messageId: r.message_id,
  hostId: r.host_id,
  title: r.title,
  displayTz: r.display_tz,
  minSessionHours: r.min_session_hours,
  deadlineUtc: r.deadline_utc,
  status: r.status,
  voiceChannelId: r.voice_channel_id,
  lockedStartUtc: r.locked_start_utc,
  lockedEndUtc: r.locked_end_utc,
  lockedGameId: r.locked_game_id,
  eventId: r.event_id,
  failureReason: r.failure_reason,
});

const NIGHT_COLUMNS = `SELECT id, guild_id, channel_id, message_id, host_id, title,
  display_tz, min_session_hours, deadline_utc, status, voice_channel_id,
  locked_start_utc, locked_end_utc, locked_game_id, event_id, failure_reason
  FROM nights`;

export function createDraftNight(db: DatabaseSync, input: CreateNightInput): number {
  return withTransaction(db, () => {
    const result = db
      .prepare(
        `INSERT INTO nights (guild_id, channel_id, host_id, title, display_tz,
          min_session_hours, deadline_utc, status, voice_channel_id, created_utc)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?)`,
      )
      .run(
        input.guildId,
        input.channelId,
        input.hostId,
        input.title,
        input.displayTz,
        input.minSessionHours,
        input.deadlineUtc,
        input.voiceChannelId,
        input.createdUtc,
      );
    const nightId = Number(result.lastInsertRowid);
    const insertDay = db.prepare(
      `INSERT INTO night_days (night_id, day_index, window_start_utc, window_end_utc)
       VALUES (?, ?, ?, ?)`,
    );
    for (const day of input.days) {
      insertDay.run(nightId, day.dayIndex, day.startUtc, day.endUtc);
    }
    return nightId;
  });
}

/**
 * Only meaningful pre-publish: the setup screen where this fires is never
 * shown again after Post it, but its ephemeral message can still receive a
 * click within Discord's ~15-minute interaction-token window even after the
 * night moves on. Scoped to 'draft' so a late click can't silently rewrite
 * the voice channel of a night that's already open or locked.
 */
export function setVoiceChannel(
  db: DatabaseSync,
  nightId: number,
  voiceChannelId: string | null,
): void {
  db.prepare(
    "UPDATE nights SET voice_channel_id = ? WHERE id = ? AND status = 'draft'",
  ).run(voiceChannelId, nightId);
}

export function getNight(db: DatabaseSync, id: number): NightRow | null {
  const row = db.prepare(`${NIGHT_COLUMNS} WHERE id = ?`).get(id) as
    | NightDbRow
    | undefined;
  return row ? toNight(row) : null;
}

export function getOpenNightForChannel(
  db: DatabaseSync,
  channelId: string,
): NightRow | null {
  const row = db
    .prepare(`${NIGHT_COLUMNS} WHERE channel_id = ? AND status = 'open' LIMIT 1`)
    .get(channelId) as NightDbRow | undefined;
  return row ? toNight(row) : null;
}

/**
 * Like `getOpenNightForChannel`, but also matches a night that has already
 * locked and has not yet finished. `/gamenight cancel` needs this: a locked
 * night still has a live Scheduled Event and roster to retract, and
 * `getOpenNightForChannel` means exactly "open" for its other callers — this
 * is a separate read, not a loosening of that one.
 *
 * Ordering is load-bearing, not incidental. Locked nights are terminal and
 * accumulate in a channel forever, so an unordered `status IN ('open',
 * 'locked')` lets SQLite walk the nights_due(status, ...) index and hand back
 * the oldest *locked* row — cancelling last week's night instead of the live
 * one. Open always wins; among locked, the newest; and a locked night whose
 * window has already ended is not cancellable at all, because there is
 * nothing left to retract.
 *
 * `nowUtc` is epoch seconds, taken as an argument rather than read from the
 * clock here so the query stays testable.
 */
export function getCancellableNightForChannel(
  db: DatabaseSync,
  channelId: string,
  nowUtc: number,
): NightRow | null {
  const row = db
    .prepare(
      `${NIGHT_COLUMNS}
       WHERE channel_id = ?
         AND (status = 'open' OR (status = 'locked' AND locked_end_utc > ?))
       ORDER BY CASE status WHEN 'open' THEN 0 ELSE 1 END, id DESC
       LIMIT 1`,
    )
    .get(channelId, nowUtc) as NightDbRow | undefined;
  return row ? toNight(row) : null;
}

interface NightDayDbRow {
  day_index: number;
  window_start_utc: number;
  window_end_utc: number;
}

export function getNightDays(db: DatabaseSync, nightId: number): NightDay[] {
  const rows = allRows<NightDayDbRow>(
    db.prepare(
      `SELECT day_index, window_start_utc, window_end_utc FROM night_days
       WHERE night_id = ? ORDER BY day_index`,
    ),
    nightId,
  );
  return rows.map((r) => ({
    dayIndex: r.day_index,
    startUtc: r.window_start_utc,
    endUtc: r.window_end_utc,
  }));
}

/**
 * Replace a draft's game set wholesale. Scoped to 'draft' for the same reason
 * `setVoiceChannel` is: the ephemeral setup message stays clickable for
 * Discord's ~15-minute interaction-token window, long after Post it. Without
 * the guard a late touch of the games dropdown rewrites a live poll — and
 * dropping a game people have already voted for silently stops those
 * `game_votes` rows from counting toward anything.
 *
 * Returns false when the night was not a draft, so the caller can tell the
 * host their setup screen is stale rather than silently doing nothing.
 * Appending to a live poll is `addNightGame`, which is a different operation
 * with different rules — not this one with a looser guard.
 */
export function setNightGames(
  db: DatabaseSync,
  nightId: number,
  gameIds: number[],
): boolean {
  return withTransaction(db, () => {
    const status = db
      .prepare("SELECT status FROM nights WHERE id = ?")
      .get(nightId) as { status: NightStatus } | undefined;
    if (status?.status !== "draft") return false;
    db.prepare("DELETE FROM night_games WHERE night_id = ?").run(nightId);
    const insert = db.prepare(
      "INSERT INTO night_games (night_id, game_id) VALUES (?, ?)",
    );
    for (const gameId of gameIds) insert.run(nightId, gameId);
    return true;
  });
}

/**
 * Add one game to a night that is still taking responses. This is what
 * "Suggest a game" does, and unlike `setNightGames` it has to keep working
 * once the poll is open — so it appends rather than replaces, and never
 * removes a game somebody may already have voted for.
 *
 * Returns false when the night has finished or already carries the game.
 */
export function addNightGame(
  db: DatabaseSync,
  nightId: number,
  gameId: number,
): boolean {
  const result = db
    .prepare(
      `INSERT OR IGNORE INTO night_games (night_id, game_id)
       SELECT ?, ? WHERE EXISTS (
         SELECT 1 FROM nights WHERE id = ? AND status IN ('draft', 'open')
       )`,
    )
    .run(nightId, gameId, nightId);
  return Number(result.changes) === 1;
}

export function getNightGameIds(db: DatabaseSync, nightId: number): number[] {
  const rows = allRows<{ game_id: number }>(
    db.prepare("SELECT game_id FROM night_games WHERE night_id = ? ORDER BY game_id"),
    nightId,
  );
  return rows.map((r) => r.game_id);
}

/**
 * Flip a draft to open. Returns false when nothing was updated — the night
 * was already published, cancelled, or swept away as a stale draft — so the
 * caller can undo whatever it did on the assumption this would succeed.
 *
 * The `status = 'draft'` guard is what stops two clicks of **Post it** on the
 * same setup message both publishing. The one-open-night-per-channel index
 * covers the other half (two different drafts racing) by throwing.
 */
export function publishNight(
  db: DatabaseSync,
  nightId: number,
  messageId: string,
): boolean {
  const result = db
    .prepare(
      "UPDATE nights SET status = 'open', message_id = ? WHERE id = ? AND status = 'draft'",
    )
    .run(messageId, nightId);
  // node:sqlite types `changes` as number | bigint, like lastInsertRowid.
  return Number(result.changes) === 1;
}

interface AvailabilityDbRow {
  user_id: string;
  utc_hour: number;
}

export function getAvailability(
  db: DatabaseSync,
  nightId: number,
): Map<string, Set<number>> {
  const rows = allRows<AvailabilityDbRow>(
    db.prepare("SELECT user_id, utc_hour FROM availability WHERE night_id = ?"),
    nightId,
  );
  const map = new Map<string, Set<number>>();
  for (const row of rows) {
    const set = map.get(row.user_id) ?? new Set<number>();
    set.add(row.utc_hour);
    map.set(row.user_id, set);
  }
  return map;
}

/**
 * Replace one day's selection. `dayHours` is every hour that day offers, so the
 * delete stays scoped to that day and other days survive untouched.
 */
export function setAvailabilityForDay(
  db: DatabaseSync,
  nightId: number,
  userId: string,
  dayHours: number[],
  chosen: number[],
): void {
  if (dayHours.length === 0) return;
  withTransaction(db, () => {
    const placeholders = dayHours.map(() => "?").join(",");
    db.prepare(
      `DELETE FROM availability
       WHERE night_id = ? AND user_id = ? AND utc_hour IN (${placeholders})`,
    ).run(nightId, userId, ...dayHours);
    const insert = db.prepare(
      "INSERT INTO availability (night_id, user_id, utc_hour) VALUES (?, ?, ?)",
    );
    for (const hour of chosen) insert.run(nightId, userId, hour);
  });
}

interface VoteDbRow {
  user_id: string;
  game_id: number;
}

export function getVotes(db: DatabaseSync, nightId: number): Map<string, Set<number>> {
  const rows = allRows<VoteDbRow>(
    db.prepare("SELECT user_id, game_id FROM game_votes WHERE night_id = ?"),
    nightId,
  );
  const map = new Map<string, Set<number>>();
  for (const row of rows) {
    const set = map.get(row.user_id) ?? new Set<number>();
    set.add(row.game_id);
    map.set(row.user_id, set);
  }
  return map;
}

export function setVotes(
  db: DatabaseSync,
  nightId: number,
  userId: string,
  gameIds: number[],
): void {
  withTransaction(db, () => {
    db.prepare("DELETE FROM game_votes WHERE night_id = ? AND user_id = ?").run(
      nightId,
      userId,
    );
    const insert = db.prepare(
      "INSERT INTO game_votes (night_id, user_id, game_id) VALUES (?, ?, ?)",
    );
    for (const gameId of gameIds) insert.run(nightId, userId, gameId);
  });
}

interface AttendanceDbRow {
  user_id: string;
  status: "in" | "out";
}

export function getAttendance(
  db: DatabaseSync,
  nightId: number,
): Map<string, "in" | "out"> {
  const rows = allRows<AttendanceDbRow>(
    db.prepare("SELECT user_id, status FROM attendance WHERE night_id = ?"),
    nightId,
  );
  return new Map(rows.map((r) => [r.user_id, r.status]));
}

export function setAttendance(
  db: DatabaseSync,
  nightId: number,
  userId: string,
  status: "in" | "out",
): void {
  db.prepare(
    `INSERT INTO attendance (night_id, user_id, status) VALUES (?, ?, ?)
     ON CONFLICT(night_id, user_id) DO UPDATE SET status = excluded.status`,
  ).run(nightId, userId, status);
}

export function clearUserResponses(
  db: DatabaseSync,
  nightId: number,
  userId: string,
): void {
  // Both deletes or neither: "I'm out" that wiped availability but left votes
  // behind would leave the user counted as a voter for a game they can no
  // longer make, skewing the very ranking they just opted out of.
  withTransaction(db, () => {
    db.prepare("DELETE FROM availability WHERE night_id = ? AND user_id = ?").run(
      nightId,
      userId,
    );
    db.prepare("DELETE FROM game_votes WHERE night_id = ? AND user_id = ?").run(
      nightId,
      userId,
    );
  });
}

export function getResponderIds(db: DatabaseSync, nightId: number): Set<string> {
  const rows = allRows<{ user_id: string }>(
    db.prepare(
      `SELECT user_id FROM availability WHERE night_id = ?
       UNION SELECT user_id FROM game_votes WHERE night_id = ?
       UNION SELECT user_id FROM attendance WHERE night_id = ?`,
    ),
    nightId,
    nightId,
    nightId,
  );
  return new Set(rows.map((r) => r.user_id));
}

export function dueNights(db: DatabaseSync, nowUtc: number): NightRow[] {
  const rows = allRows<NightDbRow>(
    db.prepare(`${NIGHT_COLUMNS} WHERE status = 'open' AND deadline_utc <= ?`),
    nowUtc,
  );
  return rows.map(toNight);
}

export function deleteStaleDrafts(db: DatabaseSync, olderThanUtc: number): void {
  db.prepare("DELETE FROM nights WHERE status = 'draft' AND created_utc < ?").run(
    olderThanUtc,
  );
}

/**
 * Commit a night's decision. Scoped to 'open' — the mirror of `failNight`'s
 * guard below, and for the same reason from the other direction.
 *
 * `lockOne` does two Discord round trips between reading a due night and
 * calling this: building the poll view (which fetches the full member list)
 * and creating the Scheduled Event. A `/gamenight cancel` landing in that
 * window commits 'cancelled' and answers the canceller — so without this
 * guard the sweep flips the row straight back to 'locked', and the channel
 * gets a roster ping for a night its host already called off. Worse, cancel's
 * cleanup read `event_id` while it was still null, so the Scheduled Event
 * created moments later is never retracted.
 *
 * Returns false when the night was no longer open, which the caller must
 * treat as "do not announce".
 */
export function lockNight(
  db: DatabaseSync,
  nightId: number,
  startUtc: number,
  endUtc: number,
  gameId: number,
  eventId: string | null,
): boolean {
  const result = db
    .prepare(
      `UPDATE nights SET status = 'locked', locked_start_utc = ?, locked_end_utc = ?,
        locked_game_id = ?, event_id = ? WHERE id = ? AND status = 'open'`,
    )
    .run(startUtc, endUtc, gameId, eventId, nightId);
  return Number(result.changes) === 1;
}

export function failNight(
  db: DatabaseSync,
  nightId: number,
  reason: NightFailureReason,
): void {
  // Scoped to 'open': a night that already locked (or was cancelled) must
  // never be downgraded to failed by a catch-all error handler.
  db.prepare(
    "UPDATE nights SET status = 'failed', failure_reason = ? WHERE id = ? AND status = 'open'",
  ).run(reason, nightId);
}

export function cancelNight(db: DatabaseSync, nightId: number): void {
  db.prepare("UPDATE nights SET status = 'cancelled' WHERE id = ?").run(nightId);
}
