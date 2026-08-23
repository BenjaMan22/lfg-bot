import type { DatabaseSync } from "node:sqlite";

export function getTimezone(db: DatabaseSync, userId: string): string | null {
  const row = db
    .prepare("SELECT timezone FROM users WHERE user_id = ?")
    .get(userId) as { timezone: string } | undefined;
  return row?.timezone ?? null;
}

export function setTimezone(db: DatabaseSync, userId: string, timezone: string): void {
  db.prepare(
    `INSERT INTO users (user_id, timezone) VALUES (?, ?)
     ON CONFLICT(user_id) DO UPDATE SET timezone = excluded.timezone`,
  ).run(userId, timezone);
}
