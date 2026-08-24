import { DatabaseSync, type StatementSync, type SQLInputValue } from "node:sqlite";
import { readFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const schemaPath = fileURLToPath(new URL("./schema.sql", import.meta.url));

/**
 * schema.sql is all `CREATE ... IF NOT EXISTS`, which creates missing tables
 * but never alters an existing one — so a column added to a CREATE TABLE
 * never reaches a database that already exists. These are the additive
 * column migrations, applied idempotently on every open.
 */
const ADDED_COLUMNS: { table: string; column: string; definition: string }[] = [
  { table: "nights", column: "failure_reason", definition: "TEXT" },
];

function applyAddedColumns(db: DatabaseSync): void {
  for (const { table, column, definition } of ADDED_COLUMNS) {
    const existing = db.prepare(`PRAGMA table_info(${table})`).all() as unknown as {
      name: string;
    }[];
    if (existing.some((c) => c.name === column)) continue;
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

export function openDatabase(path: string): DatabaseSync {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(readFileSync(schemaPath, "utf8"));
  applyAddedColumns(db);
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
