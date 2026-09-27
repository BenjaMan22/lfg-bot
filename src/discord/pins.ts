import type { Message } from "discord.js";
import type { DatabaseSync } from "node:sqlite";
import { nightsToUnpin, setNightPinned } from "../db/repos/nights.js";
import { log } from "../log.js";

/** Removes one message's pin. The real one is a Discord REST call. */
export type Unpin = (channelId: string, messageId: string) => Promise<void>;

/**
 * A 4xx other than a rate limit — a deleted message, a missing permission —
 * fails the same way every time, so retrying every sweep would only spam the
 * log. Anything else (5xx, network) is worth another try.
 */
export function isPermanentDiscordError(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("status" in error)) return false;
  const { status } = error;
  return typeof status === "number" && status >= 400 && status < 500 && status !== 429;
}

/**
 * Best-effort: a poll that could not be pinned is still a working poll, so a
 * failure (usually a missing Pin Messages permission) is logged, not thrown.
 */
export async function pinPoll(db: DatabaseSync, nightId: number, message: Message): Promise<void> {
  try {
    await message.pin();
    setNightPinned(db, nightId, true);
  } catch (error) {
    log.warn("Could not pin the poll", { nightId, error });
  }
}

/**
 * Runs on every sweep. Tracking the pin in the database, rather than
 * unpinning inline at cancel or lock, means one place covers every way a
 * night ends — and a restart or a failed call is simply retried next time.
 */
export async function unpinFinishedNights(
  db: DatabaseSync,
  nowUtc: number,
  unpin: Unpin,
): Promise<void> {
  for (const night of nightsToUnpin(db, nowUtc)) {
    try {
      if (night.messageId) await unpin(night.channelId, night.messageId);
      setNightPinned(db, night.id, false);
    } catch (error) {
      if (isPermanentDiscordError(error)) {
        log.warn("Could not unpin a finished poll; giving up", { nightId: night.id, error });
        setNightPinned(db, night.id, false);
      } else {
        log.error("Could not unpin a finished poll; will retry", { nightId: night.id, error });
      }
    }
  }
}
