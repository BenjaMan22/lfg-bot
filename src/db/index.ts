import { DatabaseSync, type StatementSync, type SQLInputValue } from "node:sqlite";
import { readFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const schemaPath = fileURLToPath(new URL("./schema.sql", import.meta.url));

export function openDatabase(path: string): DatabaseSync {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(readFileSync(schemaPath, "utf8"));
  return db;
}

/**
 * node:sqlite types every row from `.all()` as Record<string, SQLOutputValue>,
 * which is not narrow enough for TypeScript to cast directly to a repository's
 * row shape. Every repository knows its own row shape, so the cast is
 * centralized here rather than repeated (through `unknown`) at each call site.
 */
export function allRows<T>(statement: StatementSync, ...params: SQLInputValue[]): T[] {
  return statement.all(...params) as unknown as T[];
}

/** Run `work` inside a transaction, rolling back if it throws. */
export function withTransaction<T>(db: DatabaseSync, work: () => T): T {
  db.exec("BEGIN");
  try {
    const result = work();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
