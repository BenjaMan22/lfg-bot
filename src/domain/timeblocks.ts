import { DateTime } from "luxon";

/**
 * An evening window, as minutes from local midnight. Minutes rather than
 * hours because availability moves in half hours; `endMinutes` at or before
 * `startMinutes` means the window crosses into the next day.
 */
export interface DayWindow {
  startMinutes: number;
  endMinutes: number;
}

/** How long one availability slot is. Everything downstream derives from this. */
export const SLOT_SECONDS = 1800;

export interface NightDay {
  dayIndex: number;
  startUtc: number;
  endUtc: number;
}

/**
 * Most days one night may offer. Each day becomes its own availability
 * dropdown, and Discord allows only five in one message.
 */
export const MAX_DAYS = 5;
/**
 * Longest evening window a night may cover. Not an arbitrary tidiness rule:
 * every slot becomes an option in that day's availability dropdown, and a
 * Discord select menu holds 25 options. At half-hour granularity that is 24
 * slots for a 12-hour window — the longest that can still be answered. It
 * also keeps the availability grid inside the 1024-character limit on an
 * embed field, which discord.js enforces by throwing, so an oversized poll
 * would never post at all.
 */
export const MAX_WINDOW_HOURS = 12;

export function expandDays(
  isoDates: string[],
  window: DayWindow,
  tz: string,
): NightDay[] {
  const at = (base: DateTime, minutes: number) =>
    base.set({ hour: Math.floor(minutes / 60), minute: minutes % 60 });

  return isoDates.map((iso, dayIndex) => {
    const base = DateTime.fromISO(iso, { zone: tz }).startOf("day");
    const start = at(base, window.startMinutes);
    const crossesMidnight = window.endMinutes <= window.startMinutes;
    const end = at(crossesMidnight ? base.plus({ days: 1 }) : base, window.endMinutes);
    return { dayIndex, startUtc: start.toUnixInteger(), endUtc: end.toUnixInteger() };
  });
}

/** Every half-hour slot the day offers, as epoch seconds at the slot start. */
export function slotsIn(day: NightDay): number[] {
  const slots: number[] = [];
  for (let t = day.startUtc; t < day.endUtc; t += SLOT_SECONDS) slots.push(t);
  return slots;
}

/** `6p`, or `6:30p` for a slot that does not land on the hour. */
export function formatSlotLabel(utcSlot: number, tz: string): string {
  const local = DateTime.fromSeconds(utcSlot, { zone: tz });
  const hour12 = local.hour % 12 === 0 ? 12 : local.hour % 12;
  const meridiem = local.hour < 12 ? "a" : "p";
  return local.minute === 0
    ? `${hour12}${meridiem}`
    : `${hour12}:${String(local.minute).padStart(2, "0")}${meridiem}`;
}

export function formatDayLabel(day: NightDay, tz: string): string {
  return DateTime.fromSeconds(day.startUtc, { zone: tz }).toFormat("ccc LLL d");
}

/**
 * Slot labels for a set of instants, guaranteed distinct.
 *
 * On a DST fall-back night the clock repeats an hour, so two different
 * instants format identically — "1a" and "1a". `slotsIn` correctly yields
 * both, because both are real playable slots, but a dropdown offering two
 * identical options is unusable: whichever the player picks, they have a 50%
 * chance of claiming an hour they did not mean. Marking the repeat keeps the
 * options tellable apart, in the order they actually happen.
 */
export function slotLabels(slots: number[], tz: string): string[] {
  const seen = new Map<string, number>();
  return slots.map((slot) => {
    const label = formatSlotLabel(slot, tz);
    const previous = seen.get(label) ?? 0;
    seen.set(label, previous + 1);
    return previous === 0 ? label : `${label} (again)`;
  });
}
