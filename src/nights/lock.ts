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
import { createScheduledEvent, deleteScheduledEvent } from "../discord/events.js";

const SWEEP_MS = 30_000;
const DRAFT_TTL_SECONDS = 3600;
/**
 * How long past its deadline a night keeps being retried when locking throws
 * for infrastructure reasons. A wall-clock window rather than an attempt
 * counter because it needs no extra state and, unlike an in-memory counter,
 * it survives a restart — a bot that crash-loops at a deadline would
 * otherwise reset its budget on every boot and retry forever.
 */
const LOCK_RETRY_GRACE_SECONDS = 30 * 60;

/**
 * Whether processDueNights should stop retrying an infrastructure failure
 * and mark the night failed. The grace window is anchored to whichever is
 * later: the night's own deadline, or processStartUtc (when this sweep
 * first attempted the night, captured once in startSweep). Anchoring to the
 * deadline alone would let the boot-time catch-up pass give up on its very
 * first attempt whenever the bot was down past a night's deadline for
 * longer than the grace window — exactly the scenario that pass exists to
 * handle. Anchoring to processStartUtc alone (with no deadline floor) would
 * let a bug that always throws retry forever across restarts, since a fresh
 * boot resets processStartUtc; Math.max keeps the 30-minute ceiling in that
 * case while still giving a night that came due during downtime a full
 * retry budget from when the sweep first saw it.
 */
export function shouldGiveUp(
  deadlineUtc: number,
  processStartUtc: number,
  nowUtc: number,
  graceSeconds: number,
): boolean {
  return nowUtc > Math.max(deadlineUtc, processStartUtc) + graceSeconds;
}

async function lockOne(client: Client, db: DatabaseSync, night: NightRow): Promise<void> {
  const view = await buildPollView(client, db, night.id);
  if (!view) return;
  const winner = view.result.top[0];

  if (!winner) {
    // The one genuine domain failure: the ranking cleared no game's minimum.
    failNight(db, night.id, "no_viable");
    await renderNightNow(client, db, night.id);
    return;
  }

  const eventId = await createScheduledEvent(client, night, winner);
  const locked = lockNight(
    db,
    night.id,
    winner.startUtc,
    winner.endUtc,
    winner.game.id,
    eventId,
  );

  if (!locked) {
    // The night stopped being open while we were talking to Discord — in
    // practice a /gamenight cancel between buildPollView and here. The
    // canceller has already been told it is off, so the decision is void:
    // do not seed a roster, do not ping anyone. Retract the Scheduled Event
    // we just created, since cancel read event_id while it was still null
    // and cannot have deleted it.
    console.error("Night stopped being open mid-lock; discarding the decision", {
      nightId: night.id,
    });
    if (eventId) await deleteScheduledEvent(client, night.guildId, eventId);
    await renderNightNow(client, db, night.id).catch((error) =>
      console.error("Could not re-render a night that was cancelled mid-lock", {
        nightId: night.id,
        error,
      }),
    );
    return;
  }

  // Everything below is post-commit: the night is locked in the database now.
  // A failure here is a delivery problem (roster seeding, the render, the
  // announcement), not a reason to fail the night — it must not propagate to
  // processDueNights' catch-all, which would call failNight and undo an
  // already-announced decision.
  try {
    // The winning roster starts as attending; they can drop with the button.
    for (const userId of winner.roster) setAttendance(db, night.id, userId, "in");

    await renderNightNow(client, db, night.id);

    const channel = await client.channels.fetch(night.channelId);
    if (channel?.isTextBased() && "send" in channel) {
      // eventId is null whenever createScheduledEvent gave up — a missing
      // Manage Events permission, an API error, or a window that had already
      // started by lock time. The night itself is still locked correctly;
      // only the Scheduled Event is missing, so say so rather than staying
      // silent about it.
      const eventNote = eventId
        ? ""
        : "\nI couldn't create the Scheduled Event — check my Manage Events permission.";
      await channel.send({
        content: `${winner.roster.map((id) => `<@${id}>`).join(" ")} — **${winner.game.name}**, <t:${winner.startUtc}:F>. Locked in.${eventNote}`,
        allowedMentions: { users: winner.roster },
      });
    }
  } catch (error) {
    console.error("Locked but could not finish rostering or announcing", {
      nightId: night.id,
      error,
    });
  }
}

export async function processDueNights(
  client: Client,
  db: DatabaseSync,
  nowUtc: number,
  processStartUtc: number,
): Promise<void> {
  deleteStaleDrafts(db, nowUtc - DRAFT_TTL_SECONDS);
  for (const night of dueNights(db, nowUtc)) {
    try {
      await lockOne(client, db, night);
    } catch (error) {
      // Everything reaching here is an INFRASTRUCTURE error. "Nothing is
      // viable" is a domain result from rankNight and lockOne handles it
      // above without throwing, so this catch never sees it. The reachable
      // trigger is pendingMemberIds -> guild.members.fetch(), a gateway op
      // that rejects on GuildMembersTimeout or a reconnect. One hiccup at a
      // deadline must not discard a correctly-computed decision, so leave the
      // night 'open' and let the next 30-second sweep retry it.
      const giveUp = shouldGiveUp(night.deadlineUtc, processStartUtc, nowUtc, LOCK_RETRY_GRACE_SECONDS);
      console.error(giveUp ? "Locking failed; giving up" : "Locking failed; will retry", {
        nightId: night.id,
        deadlineUtc: night.deadlineUtc,
        processStartUtc,
        nowUtc,
        error,
      });
      if (!giveUp) continue;

      // Past the retry window. Stop, and say what actually happened rather
      // than telling the channel nothing was viable. failNight is scoped to
      // status='open', so this cannot downgrade a night lockOne already
      // committed as locked.
      failNight(db, night.id, "lock_error");
      // Best-effort: tell the channel the poll is dead rather than leaving it
      // showing a live countdown and response buttons. If the render is what
      // failed, this must not throw again.
      await renderNightNow(client, db, night.id).catch((renderError) =>
        console.error("Could not render failed night", { nightId: night.id, error: renderError }),
      );
    }
  }
}

export function startSweep(client: Client, db: DatabaseSync): NodeJS.Timeout {
  // Captured once, not inside run(): this is when the sweep first attempted
  // each night, which is what the retry grace window in shouldGiveUp needs
  // to anchor to. Recomputing it every tick would reset the budget on every
  // sweep and defeat the whole point.
  const processStartUtc = Math.floor(Date.now() / 1000);
  let running = false;
  const run = () => {
    // A pass does several Discord round trips (including full member
    // fetches); skip a tick that overlaps a still-running one rather than
    // double-lock a night that hasn't committed yet.
    if (running) return;
    running = true;
    processDueNights(client, db, Math.floor(Date.now() / 1000), processStartUtc)
      .catch((error) => console.error("Sweep failed", error))
      .finally(() => {
        running = false;
      });
  };
  run(); // Catch up on anything that came due while the bot was down.
  return setInterval(run, SWEEP_MS);
}
