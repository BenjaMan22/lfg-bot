import type { DatabaseSync } from "node:sqlite";
import type { Game } from "../../domain/scheduling.js";

interface GameRow {
  id: number;
  name: string;
  min_players: number;
  max_players: number | null;
}

const toGame = (row: GameRow): Game => ({
  id: row.id,
  name: row.name,
  minPlayers: row.min_players,
  maxPlayers: row.max_players,
});

const SELECT = "SELECT id, name, min_players, max_players FROM games";

export function addGame(
  db: DatabaseSync,
  guildId: string,
  name: string,
  minPlayers: number,
  maxPlayers: number | null,
  createdBy: string,
): Game {
  const trimmed = name.trim();
  const result = db
    .prepare(
      `INSERT INTO games (guild_id, name, min_players, max_players, created_by)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(guildId, trimmed, minPlayers, maxPlayers, createdBy);
  return {
    id: Number(result.lastInsertRowid),
    name: trimmed,
    minPlayers,
    maxPlayers,
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
  const rows = db
    .prepare(`${SELECT} WHERE guild_id = ? ORDER BY name COLLATE NOCASE`)
    .all(guildId) as unknown as GameRow[];
  return rows.map(toGame);
}

export function getGamesByIds(db: DatabaseSync, ids: number[]): Game[] {
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => "?").join(",");
  const rows = db
    .prepare(`${SELECT} WHERE id IN (${placeholders}) ORDER BY name COLLATE NOCASE`)
    .all(...ids) as unknown as GameRow[];
  return rows.map(toGame);
}

export function removeGame(
  db: DatabaseSync,
  guildId: string,
  name: string,
  actorId: string,
  force: boolean,
): boolean {
  const row = db
    .prepare("SELECT id, created_by FROM games WHERE guild_id = ? AND lower(name) = lower(?)")
    .get(guildId, name.trim()) as { id: number; created_by: string } | undefined;
  if (!row) return false;
  if (!force && row.created_by !== actorId) return false;
  db.prepare("DELETE FROM games WHERE id = ?").run(row.id);
  return true;
}
