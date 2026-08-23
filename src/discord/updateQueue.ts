import type { Client } from "discord.js";
import type { DatabaseSync } from "node:sqlite";
import { rankNight } from "../domain/scheduling.js";
import { getGamesByIds } from "../db/repos/games.js";
import {
  getAttendance,
  getAvailability,
  getNight,
  getNightDays,
  getNightGameIds,
  getResponderIds,
  getVotes,
} from "../db/repos/nights.js";
import { renderPoll, type PollView } from "./render.js";

const DEBOUNCE_MS = 1500;
const pending = new Map<number, NodeJS.Timeout>();

async function pendingMemberIds(
  client: Client,
  guildId: string,
  channelId: string,
  responders: Set<string>,
): Promise<string[]> {
  const guild = await client.guilds.fetch(guildId);
  const channel = await guild.channels.fetch(channelId);
  if (!channel) return [];
  const members = await guild.members.fetch();
  return members
    .filter(
      (m) =>
        !m.user.bot &&
        !responders.has(m.id) &&
        channel.permissionsFor(m)?.has("ViewChannel") === true,
    )
    .map((m) => m.id);
}

export async function buildPollView(
  client: Client,
  db: DatabaseSync,
  nightId: number,
): Promise<PollView | null> {
  const night = getNight(db, nightId);
  if (!night) return null;

  const days = getNightDays(db, nightId);
  const games = getGamesByIds(db, getNightGameIds(db, nightId));
  const availability = getAvailability(db, nightId);
  const votes = getVotes(db, nightId);
  const responderIds = getResponderIds(db, nightId);
  const result = rankNight({
    days,
    minSessionHours: night.minSessionHours,
    games,
    availability,
    votes,
  });

  const base = {
    nightId,
    title: night.title,
    displayTz: night.displayTz,
    deadlineUtc: night.deadlineUtc,
    days,
    games,
    availability,
    votes,
    responderIds,
    result,
  };

  if (night.status === "locked") {
    // Build (and validate) the locked details before any Discord API call —
    // fail loudly here rather than render a half-built locked view. A missing
    // game is currently unreachable (FK protects the reference, lockNight is
    // the only writer), but that is accidental, not designed; do not trust it.
    if (night.lockedGameId === null || night.lockedStartUtc === null || night.lockedEndUtc === null) {
      throw new Error(`Night ${nightId} is locked but is missing its locked fields`);
    }
    const [game] = getGamesByIds(db, [night.lockedGameId]);
    if (!game) {
      throw new Error(`Night ${nightId} locked game ${night.lockedGameId} was not found`);
    }
    const attendance = getAttendance(db, nightId);
    const roster = [...attendance.entries()]
      .filter(([, status]) => status === "in")
      .map(([userId]) => userId);

    const pendingIds = await pendingMemberIds(client, night.guildId, night.channelId, responderIds);
    return {
      ...base,
      status: "locked",
      pendingIds,
      locked: { startUtc: night.lockedStartUtc, endUtc: night.lockedEndUtc, game, roster },
    };
  }

  const pendingIds = await pendingMemberIds(client, night.guildId, night.channelId, responderIds);
  const status = night.status === "draft" ? "open" : night.status;
  return { ...base, status, pendingIds };
}

export async function renderNightNow(
  client: Client,
  db: DatabaseSync,
  nightId: number,
): Promise<void> {
  const night = getNight(db, nightId);
  if (!night?.messageId) return;
  const view = await buildPollView(client, db, nightId);
  if (!view) return;

  const channel = await client.channels.fetch(night.channelId);
  if (!channel?.isTextBased() || !("messages" in channel)) return;
  const message = await channel.messages.fetch(night.messageId);
  await message.edit(renderPoll(view));
}

/** Coalesce a burst of responses into a single message edit. */
export function queueRender(client: Client, db: DatabaseSync, nightId: number): void {
  clearTimeout(pending.get(nightId));
  pending.set(
    nightId,
    setTimeout(() => {
      pending.delete(nightId);
      renderNightNow(client, db, nightId).catch((error) =>
        console.error("Render failed", { nightId, error }),
      );
    }, DEBOUNCE_MS),
  );
}
