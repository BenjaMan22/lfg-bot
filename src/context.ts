import type { DatabaseSync } from "node:sqlite";
import type { Config } from "./config.js";

export interface AppContext {
  db: DatabaseSync;
  config: Config;
}
