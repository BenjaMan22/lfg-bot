# Game Night Bot — Design

**Date:** 2026-08-22
**Status:** Approved for planning

## Purpose

A Discord bot that turns "when can we all play, and what?" into a single
self-resolving poll. A host proposes days, an evening window, and a set of
games. Players answer with the hours they are free and the games they would
play. At a deadline the bot picks the best combination on its own, locks it in,
and creates a real Discord Scheduled Event.

The bot decides. Nobody has to chase people or read a wall of replies.

## Context and constraints

- One Discord server, a group of roughly 4–8 people.
- Members are in **mixed timezones**.
- Availability is expressed at **whole-hour granularity**.
- Games persist in a per-server library with player counts, and any member can
  add to it mid-poll.
- Locking is **fully automatic** at the deadline — no host confirmation step.
- TypeScript + discord.js v14 on Node 26, SQLite storage, single process.
- Deployed to one small always-on VPS running several services under Docker
  Compose; storage must not assume a managed database.

## Non-goals

Deliberately excluded to keep the first version shippable:

- Recurring or auto-posted weekly polls.
- Ranked game preferences or vetoes (plain multi-select only).
- Re-running the decision after a night locks.
- Sub-hour granularity, or more than 5 days per night.
- Any web dashboard or cross-server features.

## User-facing behaviour

### Commands

| Command | Who | Effect |
|---|---|---|
| `/gamenight create days: window: deadline: [minhours:] [voice:] [title:]` | anyone | Starts a poll |
| `/gamenight cancel` | host, or Manage Events | Cancels this channel's open night, deletes its event |
| `/games add name: min: [max:]` | anyone | Adds to the server library |
| `/games list` | anyone | Lists the library |
| `/games remove name:` | creator, or Manage Events | Removes from the library |
| `/timezone set` | anyone | Sets or changes personal timezone |

**One open night per channel.** A channel may have at most one night in `open`
status at a time; `/gamenight create` in a channel that already has one is
rejected with a link to the existing poll. This is what makes `/gamenight
cancel` unambiguous — it needs no argument, because it always targets the
channel's open night.

**Player counts.** `min_players` is required and at least 1. `max_players` is
optional; absent means unlimited, and such a game can never be flagged as
oversubscribed.

**Timezone picking** (both `/timezone set` and first-response onboarding) is a
select menu of common IANA zones plus an **Other** button opening a modal that
accepts any IANA zone name, validated before saving.

### Creation flow

1. Host runs `/gamenight create`. If the host has no stored timezone, an
   ephemeral timezone picker appears first and the command resumes after.
2. Host-typed times are interpreted in the **host's** timezone.
3. The bot replies ephemerally with a multi-select of library games, an
   **Add a game** button, and a **Post it** button.
4. **Post it** publishes the public poll embed. It is refused while zero games
   are selected — a night with no games has nothing to rank.

### Input parsing

- **`days`** — comma-separated. Each token is a weekday name (`fri`, `friday`),
  an ISO date (`2026-08-28`), or `MM/DD`. Weekday names resolve to the next
  occurrence on or after today. Duplicates are dropped, results sorted
  ascending. **Maximum 5 days** — a hard limit, because each day needs its own
  dropdown and Discord allows only 5 component rows per message.
- **`window`** — `6pm-1am`, `18-01`, or `6:00pm-1:00am`. Whole hours only;
  anything with non-zero minutes is rejected with an explanatory message. An
  end hour at or before the start hour means the window crosses midnight into
  the following day.
- **`deadline`** — `thu 9pm`, `2026-08-27 21:00`, or relative (`24h`, `2d`).
  Must be in the future and strictly before the first day's window start.
- **`minhours`** — minimum session length in hours, default **2**.
- **`voice`** — optional voice channel to attach the Scheduled Event to.

### The public poll

One embed, edited in place on every response:

- A per-day heatmap: hour labels across, count of people free underneath.
- The current game list with vote counts.
- The current **top 3** suggestions, each as day, time range, game, and the
  named roster.
- Respondent count and a list of who has not answered.
- The deadline as a relative Discord timestamp.

**Timezone rendering rule.** The heatmap grid is a single shared picture of the
schedule, so its hour labels are drawn in the **host's timezone**, and the
embed footer states which timezone that is. The top-3 suggestions and the
deadline instead use Discord's `<t:unix:t>` and `<t:unix:R>` markdown, which
Discord renders in each viewer's own local time automatically. Players
therefore always see the *decisions* in their own time, and the grid is
labelled unambiguously.

Buttons while open: **Set availability**, **Pick games**, **Suggest a game**,
**I'm out**.

### Responding

- **Set availability** — ephemeral message with one string select per day.
  Options are the window's hours **labelled in the responding player's
  timezone**; `min_values: 0`, `max_values: <hour count>`. First-time users get
  a timezone picker before this. Each select change saves immediately; the
  message explains that there is nothing to submit. At the 5-day maximum the
  selects consume all 5 component rows, leaving no room for a confirm button,
  so save-on-change is the only design that works at every day count.
- **Pick games** — ephemeral multi-select of the poll's games. A night carries
  at most 25 games, matching the select-option limit.
- **Suggest a game** — modal with name, min players, max players. The game
  joins the poll immediately, is saved to the server library permanently, and
  the suggester is auto-voted for it. A name already in the library reuses the
  existing entry rather than duplicating it.
- **I'm out** — clears the responder's availability and their votes, and writes
  an `attendance` row with status `out`.

**Who counts as having responded.** A member has responded if they have at
least one `availability` row, at least one `game_vote`, or any `attendance` row
for that night. The "no response" list is the channel members who match none of
those. This single definition serves both the open poll and the locked roster;
`attendance` is not exclusively a post-lock table.

### Locking

At the deadline the bot, with no human input:

- Computes the ranking, and if a viable combination exists: edits the poll to a
  locked state, creates a Discord Scheduled Event, and posts a message pinging
  exactly the winning roster.
- If nothing is viable: edits the poll to say so and lists the closest misses,
  each with why it failed ("Fri 8–10pm had 3 free; Deep Rock needs 4").

The Scheduled Event uses the `voice` channel when one was supplied, otherwise
an external location named after the chosen game (an external event requires an
end time, which the chosen window provides).

After locking, the message keeps **I'm in** / **I'm out** buttons that update
the event roster. **The chosen time and game never change after lock.**

## Scheduling engine

Lives in `src/domain/scheduling.ts` as pure functions with no discord.js
imports. Availability sets and votes in, ranked suggestions out.

1. Availability is stored as `(user, utc_hour)` pairs, where `utc_hour` is
   epoch seconds at the top of an hour. Local time is converted at write time
   and back at render time, so the engine is timezone-free and DST is resolved
   once, when a night's window is expanded at creation.
2. For each day, enumerate every contiguous run of hours of length
   `>= min_session_hours`. For each run, compute the set of users free for
   **every** hour of that run. Partial attendance does not count.
3. Cross each run with each game on the poll. The **roster** is the users who
   are both free for the whole run and voted for that game.
4. A combination is **viable** when `roster >= game.min_players`. This is the
   quorum — it comes from the game, so the host never has to guess a number.
   Rosters exceeding `max_players` remain viable but are flagged
   (`6 in, plays 4 — split lobbies?`).
5. Rank by, in order: most players, then longest window, then earliest start,
   then most total votes for the game. Keep only the best combination per
   `(day, game)`, then select the top 3 greedily: walk the ranked list and skip
   any candidate whose day is already represented, then, if fewer than 3 were
   found, fill the remaining places from the skipped candidates in rank order.
   Three different days when possible, three slices of one evening only when
   that is all there is.
6. When nothing is viable, return the highest-scoring non-viable combinations
   with their shortfall, for the "no viable night" message.

## Data model

SQLite in WAL mode, accessed through repositories in `src/db/repos/` so that no
SQL leaks into command or interaction handlers.

| Table | Columns |
|---|---|
| `users` | `user_id` PK, `timezone` (IANA) |
| `games` | `id` PK, `guild_id`, `name`, `min_players`, `max_players`, `created_by`; unique on `(guild_id, lower(name))` |
| `nights` | `id` PK, `guild_id`, `channel_id`, `message_id`, `host_id`, `title`, `display_tz`, `min_session_hours`, `deadline_utc`, `status`, `voice_channel_id`, `locked_start_utc`, `locked_end_utc`, `locked_game_id`, `event_id` |
| `night_days` | `night_id`, `day_index`, `window_start_utc`, `window_end_utc` |
| `night_games` | `night_id`, `game_id` |
| `availability` | `night_id`, `user_id`, `utc_hour`; PK on all three |
| `game_votes` | `night_id`, `user_id`, `game_id`; PK on all three |
| `attendance` | `night_id`, `user_id`, `status` (`in` / `out`) |

`nights.status` is one of `open`, `locked`, `failed`, `cancelled`.

## Architecture

```
src/
  index.ts              client bootstrap, event wiring, deadline sweep
  config.ts             env parsing, fails loudly on a missing token
  commands/             slash command definitions + handlers
  interactions/         button / select / modal handlers routed by customId
  domain/
    scheduling.ts       PURE: availability + votes -> ranked suggestions
    timeblocks.ts       PURE: window/day/deadline parsing, TZ <-> UTC math
  db/
    schema.sql, index.ts, repos/{nights,games,users}.ts
  discord/
    render.ts           embed + component builders
    events.ts           Scheduled Event create / update / delete
scripts/deploy-commands.ts
```

The boundary that matters: **`domain/` imports nothing from discord.js or the
database.** Everything that could be subtly wrong — overlap maths, timezone
conversion, ranking, tie-breaks — is therefore testable without a network
connection or a bot token.

### Runtime decisions

- **Storage driver:** Node's built-in `node:sqlite`, avoiding native
  compilation entirely, which matters because Node 26 is new enough that
  prebuilt binaries for native modules may be missing. Verified at scaffold
  time; falls back to `better-sqlite3` if it misbehaves. Only
  `src/db/index.ts` would change.
- **Timezone maths:** `luxon`, for IANA zone conversion and DST-correct
  expansion of a local window into UTC hours.
- **Deadlines:** a 30-second sweep over
  `nights WHERE status='open' AND deadline_utc <= now`, plus a catch-up pass on
  boot. No in-memory timers, so a restart never drops a pending lock.
- **Embed updates:** re-renders are debounced per night with a 1.5 s trailing
  delay, so a burst of responses produces one message edit rather than ten.
- **`customId` format:** `gn:<action>:<nightId>[:<extra>]`, within Discord's
  100-character limit.
- **Intents:** `Guilds` and `GuildScheduledEvents` only. Everything is driven by
  interactions, so **no privileged intents are needed** — no Message Content
  toggle and no bot verification.
- **Bot permissions:** Send Messages, Embed Links, Manage Events.
  Scopes: `bot`, `applications.commands`.

### Error handling

- Every interaction handler is wrapped; failures reply ephemerally with
  something a human can act on, and log with the night id.
- Anything that may exceed 3 seconds defers first.
- Ephemeral pickers older than Discord's 15-minute interaction token lifetime
  fail with "click the button again", not a silent error.
- Validation failures on `create` explain the expected format and give an
  example.

## Testing

`vitest`. The scheduling engine and time parsing carry the weight:

- Nobody free; exactly one person free; everyone free.
- Runs shorter than `min_session_hours` excluded.
- Partial attendance across a run excluded.
- Roster below `min_players` reported as a near miss, not a suggestion.
- Roster above `max_players` still viable, and flagged.
- Every tie-break in order: players, then length, then start, then votes.
- Top-3 selection preferring distinct days.
- Three users in three timezones whose local choices land on the same UTC hour.
- Windows crossing midnight, and a window spanning a DST transition.
- Every accepted `days`, `window`, and `deadline` input format, plus the
  rejections: minutes, past deadlines, deadlines after the first window, more
  than 5 days.

Repositories are tested against an in-memory database. discord.js is **not**
mocked — mocking it would test the mock.

## Build order

Each step ends somewhere the behaviour can be seen working.

1. Skeleton, config, command registration, `/gamenight ping` — proves the token,
   invite, and registration before any logic exists.
2. Schema, repositories, and the games library commands.
3. The pure scheduling engine, written test-first.
4. Poll creation and the live-updating embed.
5. Availability, votes, timezone onboarding, the suggestion modal.
6. Deadline sweep, auto-lock, Scheduled Event, join/drop.

Discord Developer Portal setup (creating the application, copying the token,
inviting with the right scopes) is a human step, walked through at step 1. The
token lives in an uncommitted `.env`.
