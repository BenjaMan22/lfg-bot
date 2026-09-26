# Picker-Based Create Form — Design

**Date:** 2026-09-26
**Status:** Approved for planning

## Purpose

Hosts kept hitting free-text parse failures when creating a game night (e.g.
`2026-10-06 6:00pm` is rejected as a deadline). The goal of the bot is simple:
tell friends "we want to play on an upcoming day and time" and see who joins.
This change replaces every free-text date and time field with dropdowns,
removes the deadline field entirely, and removes minimum player counts.

## Decisions

| Question | Decision |
|---|---|
| Date input | Dropdown of the next 25 days, pick up to 5. Discord has no date-picker component; a button grid or web Activity was considered and rejected as out of proportion. |
| Hours input | Two dropdowns: **start time** and **length**. |
| Start-time range | Noon to 11:30pm, every half hour (24 options — the 25-option dropdown limit rules out a full day at half-hour precision). |
| Length range | 2 to 12 hours, every half hour (21 options). |
| Deadline | Removed as an input. The bot locks the night **1 hour before the first chosen day's window starts.** |
| Min players | Removed from every form and from ranking. Max players stays. |
| Polling | Unchanged: availability grid, game votes, ranking, auto-lock, Scheduled Event. |

## User-facing behaviour

### `/gamenight create` modal — five fields, all but Title are pickers

1. **Title** — optional text, unchanged.
2. **Games** — dropdown, unchanged except each option reads "up to N players" or "any number of players".
3. **Days** — dropdown, min 1 / max 5. Options are today plus the next 24 days in the host's timezone, labelled like `Sat Sep 26`; today and tomorrow carry a "Today" / "Tomorrow" description.
4. **Start time** — dropdown, `12pm`, `12:30pm`, … `11:30pm`.
5. **Length** — dropdown, `2 hours`, `2½ hours`, … `12 hours`.

The setup screen that follows is **unchanged**: games adjuster, voice channel,
Add a game, Post it.

### Validation at submit

Because every field is a picker, the only input that can still be invalid is
timing. One rule:

- **The lock time must still be in the future**: accepted only when
  `lockTimeFor(days) > now`, i.e. the first chosen day's window starts more
  than 1 hour from now. This also catches a modal left open past midnight,
  whose "today" has become yesterday. Rejected with: *"Your
  first day starts in less than an hour — pick a later start time or day, so
  people have time to answer."*

Days are sorted ascending on submit regardless of pick order. A window is
never shorter than a session or longer than 12 hours, because the length
dropdown cannot express either.

### The poll

- `Deadline <t:…:R>` becomes `Picks the night <t:…:R>`.
- A failed night with responses reads *"No viable night. Nobody was free for
  the same 2 hours with a game in common."* The zero-response and lock-error
  messages are unchanged. "Closest misses" is removed.
- The oversubscription note ("6 in, plays 4 — split lobbies?") is unchanged.

### Adding games

`/games add` and the Suggest-a-game modal drop the "Fewest players" field.
Remaining fields: name, max players (optional, blank = any number), link
(optional). Confirmations and `/games list` read "up to N players" or "any
number of players".

## Implementation shape

### New pure module: `src/domain/pickers.ts`

No discord.js or db imports, same as the rest of `src/domain/`.

- `dayOptions(tz, now, count = 25)` → `{ value: isoDate, label, description? }[]`, starting today in `tz`.
- `START_TIME_OPTIONS` → `{ value: minutesSinceMidnight, label }[]` for 720…1410.
- `LENGTH_OPTIONS` → `{ value: minutes, label }[]` for 120…720, step 30.
- `windowFromStartAndLength(startMinutes, lengthMinutes): DayWindow` — `endMinutes = (start + length) % 1440`, so a window crossing midnight falls out naturally and feeds the existing `expandDays` unchanged.
- `LOCK_LEAD_SECONDS = 3600` and `lockTimeFor(days: NightDay[]): number` → `days[0].startUtc - LOCK_LEAD_SECONDS`.

### Storage

No schema change. `nights.deadline_utc` keeps its meaning (when the sweep
locks) and is set at creation to `lockTimeFor(expanded)`, so `lock.ts` and the
sweep are untouched. `games.min_players` stays in the schema — SQLite will not
drop a column referenced by a CHECK constraint without rebuilding the table —
and is always written as `1` and never read.

### Removals

- `parseDays`, `parseWindow`, `parseDeadline`, `assertSessionFitsWindow`, and any helper left unused by their removal (e.g. weekday parsing), with their tests. This also removes the date-plus-12-hour deadline bug rather than fixing it.
- `Game.minPlayers`; `NearMiss`, `shortfall`, and `SchedulingResult.nearMisses`; near-miss rendering; `parsePlayerCounts` in favour of a max-only parser.
- `addGame` loses its `minPlayers` parameter.

Ranking keeps its order (most players, longest window, earliest start, most
votes); a combination is viable whenever its roster is non-empty.

### Documentation

`README.md`'s command reference and walkthrough are updated to describe the
picker fields, the automatic lock time, and games without a minimum.
Slash-command *definitions* do not change, so `npm run deploy` is not needed.

## Error handling

Rejections reply ephemerally with the reason and are logged through the
existing `log.warn("Create form rejected", …)` path. Unexpected throws reach
the router's full-depth error logging.

## Testing

- `pickers.ts`: day options in the host's timezone (including across a DST change and a month boundary), start-time and length labels and counts, window conversion including midnight crossing, lock time.
- Max-players parsing: blank, valid, zero, negative, non-integer.
- Ranking: a single-player roster is viable; no near misses exist in results.
- Rendering: the new failure sentence and "Picks the night" line.
- `addGame` without min players writes `min_players = 1`.
- The modal and setup flow get a live click-through in Discord.

## Out of scope

A calendar-styled picker (button grid or Discord Activity), host-chosen lock
times, and any change to the setup screen.
