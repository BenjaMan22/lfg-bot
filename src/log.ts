import { inspect } from "node:util";

/**
 * Console logging with timestamps and full-depth objects.
 *
 * Plain `console.error(obj)` stops two levels deep, so a Discord API error's
 * `requestBody` prints as `json: [Object]` — hiding exactly the payload that
 * explains why Discord rejected it. Everything here is inspected in full.
 */
function write(
  sink: (line: string) => void,
  level: string,
  message: string,
  details?: unknown,
): void {
  const stamp = new Date().toISOString();
  const body =
    details === undefined
      ? ""
      : ` ${inspect(details, { depth: null, colors: false, breakLength: 120 })}`;
  sink(`${stamp} ${level} ${message}${body}`);
}

export const log = {
  info: (message: string, details?: unknown) => write(console.log, "INFO ", message, details),
  warn: (message: string, details?: unknown) => write(console.warn, "WARN ", message, details),
  error: (message: string, details?: unknown) => write(console.error, "ERROR", message, details),
};
