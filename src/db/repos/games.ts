import type { DatabaseSync } from "node:sqlite";
import type { Game } from "../../domain/scheduling.js";
import { allRows } from "../index.js";

interface GameRow {
  id: number;
  name: string;
  max_players: number | null;
  link: string | null;
}

const toGame = (row: GameRow): Game => ({
  id: row.id,
  name: row.name,
  maxPlayers: row.max_players,
  link: row.link,
});

const SELECT = "SELECT id, name, max_players, link FROM games";

/**
 * `min_players` is written as a literal 1: the column outlived the feature,
 * and SQLite cannot drop a column referenced by a CHECK constraint without
 * rebuilding the table. Nothing reads it.
 */
export function addGame(
  db: DatabaseSync,
  guildId: string,
  name: string,
  maxPlayers: number | null,
  createdBy: string,
  link: string | null = null,
): Game {
  const trimmed = name.trim();
  const result = db
    .prepare(
      `INSERT INTO games (guild_id, name, min_players, max_players, created_by, link)
       VALUES (?, ?, 1, ?, ?, ?)`,
    )
    .run(guildId, trimmed, maxPlayers, createdBy, link);
  return {
    id: Number(result.lastInsertRowid),
    name: trimmed,
    maxPlayers,
    link,
  };
}

export function findGameByName(
  db: DatabaseSync,
  guildId: string,
  name: string,
): Game | null {
  const row = db
    .prepare(`${SELECT} WHERE guild_id = ? AND lower(name) = lower(?)`)
    .get(guildId, name.trim()) as GameRow | undefined;
  return row ? toGame(row) : null;
}

export function listGames(db: DatabaseSync, guildId: string): Game[] {
  const rows = allRows<GameRow>(
    db.prepare(`${SELECT} WHERE guild_id = ? ORDER BY name COLLATE NOCASE`),
    guildId,
  );
  return rows.map(toGame);
}

export function getGamesByIds(db: DatabaseSync, ids: number[]): Game[] {
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => "?").join(",");
  const rows = allRows<GameRow>(
    db.prepare(`${SELECT} WHERE id IN (${placeholders}) ORDER BY name COLLATE NOCASE`),
    ...ids,
  );
  return rows.map(toGame);
}

export type RemoveGameResult = "removed" | "not_found" | "forbidden" | "in_use";

/**
 * night_games.game_id, game_votes.game_id, and nights.locked_game_id all
 * reference games(id) with foreign keys enforced and no ON DELETE — by
 * design, so a night's history can't quietly lose the game it was about.
 * That means a game that has ever been in a poll raises SQLITE_CONSTRAINT_
 * FOREIGNKEY on delete; callers should not see that as a generic failure.
 */
/** SQLITE_CONSTRAINT_FOREIGNKEY, the extended result code node:sqlite exposes as `errcode`. */
const SQLITE_CONSTRAINT_FOREIGNKEY = 787;

function isForeignKeyConstraintError(error: unknown): boolean {
  // The numeric code rather than the message text: `errcode` is SQLite's own
  // stable extended result code, whereas the message is driver prose that can
  // be reworded between Node releases without warning.
  return (
    error instanceof Error &&
    (error as { errcode?: number }).errcode === SQLITE_CONSTRAINT_FOREIGNKEY
  );
}

export function removeGame(
  db: DatabaseSync,
  guildId: string,
  name: string,
  actorId: string,
  force: boolean,
): RemoveGameResult {
  const row = db
    .prepare("SELECT id, created_by FROM games WHERE guild_id = ? AND lower(name) = lower(?)")
    .get(guildId, name.trim()) as { id: number; created_by: string } | undefined;
  if (!row) return "not_found";
  if (!force && row.created_by !== actorId) return "forbidden";
  try {
    db.prepare("DELETE FROM games WHERE id = ?").run(row.id);
  } catch (error) {
    if (isForeignKeyConstraintError(error)) return "in_use";
    throw error;
  }
  return "removed";
}
