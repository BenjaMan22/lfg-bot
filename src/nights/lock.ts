import type { Client } from "discord.js";
import type { DatabaseSync } from "node:sqlite";
import {
  deleteStaleDrafts,
  dueNights,
  failNight,
  lockNight,
  setAttendance,
  type NightRow,
} from "../db/repos/nights.js";
import { buildPollView, renderNightNow } from "../discord/updateQueue.js";
import { createScheduledEvent } from "../discord/events.js";

const SWEEP_MS = 30_000;
const DRAFT_TTL_SECONDS = 3600;

async function lockOne(client: Client, db: DatabaseSync, night: NightRow): Promise<void> {
  const view = await buildPollView(client, db, night.id);
  if (!view) return;
  const winner = view.result.top[0];

  if (!winner) {
    failNight(db, night.id);
    await renderNightNow(client, db, night.id);
    return;
  }

  const eventId = await createScheduledEvent(client, night, winner);
  lockNight(db, night.id, winner.startUtc, winner.endUtc, winner.game.id, eventId);
  // The winning roster starts as attending; they can drop with the button.
  for (const userId of winner.roster) setAttendance(db, night.id, userId, "in");

  await renderNightNow(client, db, night.id);

  const channel = await client.channels.fetch(night.channelId);
  if (channel?.isTextBased() && "send" in channel) {
    await channel.send({
      content: `${winner.roster.map((id) => `<@${id}>`).join(" ")} — **${winner.game.name}**, <t:${winner.startUtc}:F>. Locked in.`,
      allowedMentions: { users: winner.roster },
    });
  }
}

export async function processDueNights(
  client: Client,
  db: DatabaseSync,
  nowUtc: number,
): Promise<void> {
  deleteStaleDrafts(db, nowUtc - DRAFT_TTL_SECONDS);
  for (const night of dueNights(db, nowUtc)) {
    try {
      await lockOne(client, db, night);
    } catch (error) {
      // One bad night must not stop the others, and must not retry forever.
      console.error("Locking failed", { nightId: night.id, error });
      failNight(db, night.id);
    }
  }
}

export function startSweep(client: Client, db: DatabaseSync): NodeJS.Timeout {
  const run = () =>
    processDueNights(client, db, Math.floor(Date.now() / 1000)).catch((error) =>
      console.error("Sweep failed", error),
    );
  run(); // Catch up on anything that came due while the bot was down.
  return setInterval(run, SWEEP_MS);
}
