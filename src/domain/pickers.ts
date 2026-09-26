import { DateTime } from "luxon";
import { MAX_WINDOW_HOURS, type DayWindow, type NightDay } from "./timeblocks.js";

/**
 * Every night ranks runs of at least this many hours. Fixed rather than a
 * form field: it is a detail of how the engine searches, not a decision the
 * host has context to make. It is also the shortest option in the length
 * picker, so a chosen window can never be too short to hold one session.
 */
export const MIN_SESSION_HOURS = 2;

/**
 * How long before the first chosen day starts the bot locks the night in —
 * enough notice for the winning roster to actually show up.
 */
export const LOCK_LEAD_SECONDS = 3600;

/** Discord's hard limit on the number of options in one select menu. */
export const SELECT_OPTION_LIMIT = 25;

const MINUTES_PER_DAY = 24 * 60;
const STEP_MINUTES = 30;
const FIRST_START_MINUTES = 12 * 60;
const LAST_START_MINUTES = 23 * 60 + 30;

/** One entry in a dropdown: what is stored, and what the host sees. */
export interface PickerOption<T> {
  value: T;
  label: string;
  description?: string;
}

/**
 * Today and the following days, as calendar dates in the host's timezone.
 * Built from the host's local midnight rather than a fixed number of seconds,
 * so a DST change never skips or repeats a date.
 */
export function dayOptions(
  tz: string,
  now: DateTime,
  count: number = SELECT_OPTION_LIMIT,
): PickerOption<string>[] {
  const today = now.setZone(tz).startOf("day");
  return Array.from({ length: count }, (_, i) => {
    const date = today.plus({ days: i });
    const option: PickerOption<string> = {
      value: date.toISODate()!,
      label: date.toFormat("ccc LLL d"),
    };
    if (i === 0) option.description = "Today";
    else if (i === 1) option.description = "Tomorrow";
    return option;
  });
}

/** `6pm`, or `6:30pm` off the hour. */
function clockLabel(minutes: number): string {
  const hour24 = Math.floor(minutes / 60);
  const minute = minutes % 60;
  const hour12 = hour24 % 12 === 0 ? 12 : hour24 % 12;
  const meridiem = hour24 < 12 ? "am" : "pm";
  return minute === 0
    ? `${hour12}${meridiem}`
    : `${hour12}:${String(minute).padStart(2, "0")}${meridiem}`;
}

/** `2 hours`, or `2½ hours` for a half. */
function lengthLabel(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  return minutes % 60 === 0 ? `${hours} hours` : `${hours}½ hours`;
}

function steps(from: number, to: number): number[] {
  const values: number[] = [];
  for (let v = from; v <= to; v += STEP_MINUTES) values.push(v);
  return values;
}

/**
 * Noon to 11:30pm. A select holds 25 options, so a whole day at half-hour
 * precision cannot fit; afternoon-and-evening is where game nights happen.
 */
export const START_TIME_OPTIONS: PickerOption<number>[] = steps(
  FIRST_START_MINUTES,
  LAST_START_MINUTES,
).map((minutes) => ({ value: minutes, label: clockLabel(minutes) }));

/**
 * From one session to the longest window a night may cover. Choosing a length
 * rather than an end time means a window that runs past midnight needs no
 * special handling, and a window too short or too long cannot be picked.
 */
export const LENGTH_OPTIONS: PickerOption<number>[] = steps(
  MIN_SESSION_HOURS * 60,
  MAX_WINDOW_HOURS * 60,
).map((minutes) => ({ value: minutes, label: lengthLabel(minutes) }));

/**
 * The start-and-length the host picked, as the start/end window `expandDays`
 * already understands. An end at or before the start means past midnight.
 */
export function windowFromStartAndLength(
  startMinutes: number,
  lengthMinutes: number,
): DayWindow {
  return { startMinutes, endMinutes: (startMinutes + lengthMinutes) % MINUTES_PER_DAY };
}

/** When the sweep locks a night in. `days` must be non-empty and sorted. */
export function lockTimeFor(days: NightDay[]): number {
  return days[0].startUtc - LOCK_LEAD_SECONDS;
}
