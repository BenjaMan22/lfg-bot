# Game Night Bot Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Discord bot where a host posts candidate days, an evening window, and games; players answer with the hours they are free and the games they would play; and at a deadline the bot automatically locks the best viable combination and creates a Discord Scheduled Event.

**Architecture:** A single Node process. All decision logic lives in two pure modules under `src/domain/` that import neither discord.js nor the database, so the overlap maths, timezone conversion, and ranking are unit-testable without a bot token. Discord interactions are routed by a `customId` convention through thin handlers that read and write SQLite through repositories. Deadlines are handled by a periodic sweep over the database rather than in-memory timers, so a restart never drops a pending lock.

**Tech Stack:** TypeScript 5 (ESM, NodeNext), discord.js v14, Node 26 with the built-in `node:sqlite`, `luxon` for IANA timezone maths, `vitest` for tests, `tsx` for dev running.

**Spec:** `docs/superpowers/specs/2026-08-22-game-night-bot-design.md`

## Global Constraints

- **ESM with NodeNext resolution.** Every relative import MUST carry a `.js` extension even though the source file is `.ts`: `import { rankNight } from "../domain/scheduling.js";`. Omitting it is a runtime failure, not a compile error.
- **`src/domain/` imports nothing from `discord.js` and nothing from `src/db/`.** This boundary is the reason the logic is testable. A domain module that needs data takes it as a parameter.
- **All stored times are epoch seconds (UTC), aligned to the top of an hour** where they represent an availability hour. Never store local time or timezone-naive strings.
- **Maximum 5 days per night**, because each day consumes one of Discord's 5 component rows. **Maximum 25 games per night** and **25 options per select menu**, both Discord limits.
- **`customId` format is `gn:<action>[:<arg>[:<arg>]]`** and must stay within 100 characters.
- **`min_players` is required and ≥ 1. `max_players` is nullable**, and null means unlimited.
- **TypeScript `strict: true`.** No `any` in committed code.
- **Never commit `.env`.** It is already in `.gitignore`.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/config.ts` | Parse and validate environment; fail loudly |
| `src/index.ts` | Client bootstrap, event wiring, start the sweep |
| `src/interactions/router.ts` | Parse `customId`, dispatch, wrap every handler in error handling |
| `src/domain/timeblocks.ts` | PURE: parse days/window/deadline, expand local windows into UTC hours, format labels |
| `src/domain/scheduling.ts` | PURE: availability + votes → ranked suggestions and near misses |
| `src/db/schema.sql` | Table definitions |
| `src/db/index.ts` | Open the database, apply WAL and schema |
| `src/db/repos/users.ts` | Timezone storage |
| `src/db/repos/games.ts` | The per-guild game library |
| `src/db/repos/nights.ts` | Nights, days, poll games, availability, votes, attendance |
| `src/discord/render.ts` | Build the poll embed and its components for every status |
| `src/discord/events.ts` | Create, update, and delete Scheduled Events |
| `src/discord/timezonePicker.ts` | The shared timezone onboarding flow |
| `src/discord/updateQueue.ts` | Debounced per-night message re-render |
| `src/commands/*.ts` | Slash command definitions and handlers |
| `src/nights/lock.ts` | The deadline sweep and the locking transition |
| `scripts/deploy-commands.ts` | Register slash commands with Discord |

---

## Task 1: Project skeleton, config, and a responding `/gamenight ping`

This task exists to prove the token, the invite, and command registration are correct **before** any logic depends on them. Nothing here has domain behaviour.

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `.env.example`, `README.md`
- Create: `src/config.ts`, `src/index.ts`, `src/interactions/router.ts`, `src/commands/index.ts`, `src/commands/gamenight.ts`, `scripts/deploy-commands.ts`
- Test: `src/config.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `loadConfig(env?: NodeJS.ProcessEnv): Config` where `interface Config { token: string; applicationId: string; devGuildId: string | null; databasePath: string }`
  - `interface SlashCommand { data: SlashCommandBuilder | SlashCommandSubcommandsOnlyBuilder; execute(i: ChatInputCommandInteraction, ctx: AppContext): Promise<void> }`
  - `interface AppContext { db: DatabaseSync; config: Config }` — declared in `src/context.ts`, populated for real in Task 4. In this task `db` is typed but assigned `null as unknown as DatabaseSync` at the single call site in `index.ts`, with a comment saying Task 4 replaces it.
  - `routeInteraction(interaction: Interaction, ctx: AppContext): Promise<void>`
  - `parseCustomId(id: string): { action: string; args: string[] }`

- [ ] **Step 1: Human step — create the Discord application**

This is the only part the agent cannot do. Walk the user through it and wait for them to confirm before continuing:

1. Go to <https://discord.com/developers/applications> and click **New Application**. Name it whatever you like.
2. Open the **Bot** tab. Click **Reset Token**, then copy the token. This is a password — it goes in `.env` and nowhere else. If it ever leaks, reset it here.
3. Still on the **Bot** tab, scroll to **Privileged Gateway Intents** and turn ON **Server Members Intent**. Leave **Message Content Intent** OFF — that is the one that causes verification friction, and this bot does not need it. Save.
4. Open the **OAuth2** tab, and in the URL generator tick scopes **`bot`** and **`applications.commands`**. In the bot permissions list below, tick **Send Messages**, **Embed Links**, and **Manage Events**.
5. Copy the generated URL, open it, and invite the bot to your server.
6. From the **General Information** tab, copy the **Application ID**.
7. In Discord, enable Developer Mode (User Settings → Advanced), then right-click your server and **Copy Server ID**.

Then create `.env` (never committed) from these three values:

```
DISCORD_TOKEN=the token from step 2
DISCORD_APPLICATION_ID=the application id from step 6
DISCORD_DEV_GUILD_ID=the server id from step 7
DATABASE_PATH=data/gamenight.db
```

- [ ] **Step 2: Scaffold the project**

```bash
npm init -y
npm pkg set type=module
npm install discord.js luxon
npm install -D typescript tsx vitest @types/node @types/luxon
mkdir -p src/domain src/db/repos src/discord src/commands src/interactions src/nights scripts data
echo "data/" >> .gitignore
```

`tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "nodenext",
    "moduleResolution": "nodenext",
    "outDir": "dist",
    "rootDir": ".",
    "strict": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "esModuleInterop": true,
    "types": ["node"]
  },
  "include": ["src/**/*.ts", "scripts/**/*.ts"],
  "exclude": ["**/*.test.ts"]
}
```

`vitest.config.ts`:

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { include: ["src/**/*.test.ts"] },
});
```

Add scripts to `package.json`:

```json
{
  "scripts": {
    "dev": "node --env-file=.env --import tsx src/index.ts",
    "build": "tsc",
    "start": "node --env-file=.env dist/src/index.js",
    "deploy": "node --env-file=.env --import tsx scripts/deploy-commands.ts",
    "test": "vitest run"
  }
}
```

`.env.example` is `.env` with the values blanked out. Commit `.env.example`, never `.env`.

- [ ] **Step 3: Write the failing config test**

`src/config.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";

const full = {
  DISCORD_TOKEN: "t",
  DISCORD_APPLICATION_ID: "a",
  DISCORD_DEV_GUILD_ID: "g",
  DATABASE_PATH: "data/test.db",
};

describe("loadConfig", () => {
  it("reads every value", () => {
    expect(loadConfig(full)).toEqual({
      token: "t",
      applicationId: "a",
      devGuildId: "g",
      databasePath: "data/test.db",
    });
  });

  it("treats the dev guild as optional", () => {
    const { DISCORD_DEV_GUILD_ID, ...rest } = full;
    expect(loadConfig(rest).devGuildId).toBeNull();
  });

  it("defaults the database path", () => {
    const { DATABASE_PATH, ...rest } = full;
    expect(loadConfig(rest).databasePath).toBe("data/gamenight.db");
  });

  it("names the missing variable when the token is absent", () => {
    const { DISCORD_TOKEN, ...rest } = full;
    expect(() => loadConfig(rest)).toThrow(/DISCORD_TOKEN/);
  });

  it("rejects an empty token rather than accepting it", () => {
    expect(() => loadConfig({ ...full, DISCORD_TOKEN: "  " })).toThrow(/DISCORD_TOKEN/);
  });
});
```

- [ ] **Step 4: Run the test to verify it fails**

Run: `npx vitest run src/config.test.ts`
Expected: FAIL — cannot resolve `./config.js`.

- [ ] **Step 5: Implement the config**

`src/config.ts`:

```ts
export interface Config {
  token: string;
  applicationId: string;
  devGuildId: string | null;
  databasePath: string;
}

function required(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key]?.trim();
  if (!value) {
    throw new Error(
      `Missing ${key}. Copy .env.example to .env and fill it in — see README.`,
    );
  }
  return value;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    token: required(env, "DISCORD_TOKEN"),
    applicationId: required(env, "DISCORD_APPLICATION_ID"),
    devGuildId: env.DISCORD_DEV_GUILD_ID?.trim() || null,
    databasePath: env.DATABASE_PATH?.trim() || "data/gamenight.db",
  };
}
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `npx vitest run src/config.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 7: Write the context, the command, and the router**

`src/context.ts`:

```ts
import type { DatabaseSync } from "node:sqlite";
import type { Config } from "./config.js";

export interface AppContext {
  db: DatabaseSync;
  config: Config;
}
```

`src/commands/gamenight.ts`:

```ts
import {
  SlashCommandBuilder,
  MessageFlags,
  type ChatInputCommandInteraction,
} from "discord.js";
import type { AppContext } from "../context.js";

export const data = new SlashCommandBuilder()
  .setName("gamenight")
  .setDescription("Plan a game night")
  .addSubcommand((s) => s.setName("ping").setDescription("Check the bot is alive"));

export async function execute(
  interaction: ChatInputCommandInteraction,
  _ctx: AppContext,
): Promise<void> {
  if (interaction.options.getSubcommand() === "ping") {
    await interaction.reply({
      content: `Alive. Round trip ${Date.now() - interaction.createdTimestamp}ms.`,
      flags: MessageFlags.Ephemeral,
    });
  }
}
```

`src/commands/index.ts`:

```ts
import type { ChatInputCommandInteraction } from "discord.js";
import type { AppContext } from "../context.js";
import * as gamenight from "./gamenight.js";

export interface SlashCommand {
  data: { name: string; toJSON(): unknown };
  execute(i: ChatInputCommandInteraction, ctx: AppContext): Promise<void>;
}

export const commands: SlashCommand[] = [gamenight];

export const commandsByName = new Map(commands.map((c) => [c.data.name, c]));
```

`src/interactions/router.ts`:

```ts
import { MessageFlags, type Interaction } from "discord.js";
import type { AppContext } from "../context.js";
import { commandsByName } from "../commands/index.js";

export function parseCustomId(id: string): { action: string; args: string[] } {
  const [namespace, action, ...args] = id.split(":");
  if (namespace !== "gn" || !action) {
    return { action: "", args: [] };
  }
  return { action, args };
}

/** Reply with a message the user can act on, whether or not we already deferred. */
async function replyError(interaction: Interaction, message: string): Promise<void> {
  if (!interaction.isRepliable()) return;
  const payload = { content: message, flags: MessageFlags.Ephemeral } as const;
  try {
    if (interaction.deferred || interaction.replied) {
      await interaction.followUp(payload);
    } else {
      await interaction.reply(payload);
    }
  } catch {
    // The interaction token expired (15 minutes) — nothing left to say.
  }
}

export async function routeInteraction(
  interaction: Interaction,
  ctx: AppContext,
): Promise<void> {
  try {
    if (interaction.isChatInputCommand()) {
      const command = commandsByName.get(interaction.commandName);
      if (!command) throw new Error(`Unknown command ${interaction.commandName}`);
      await command.execute(interaction, ctx);
      return;
    }
    // Component and modal handlers are registered in later tasks.
  } catch (error) {
    console.error("Interaction failed", {
      id: interaction.id,
      type: interaction.type,
      error,
    });
    await replyError(
      interaction,
      "Something went wrong handling that. It has been logged — try again.",
    );
  }
}
```

`src/index.ts`:

```ts
import { Client, Events, GatewayIntentBits } from "discord.js";
import type { DatabaseSync } from "node:sqlite";
import { loadConfig } from "./config.js";
import { routeInteraction } from "./interactions/router.js";
import type { AppContext } from "./context.js";

const config = loadConfig();

// Task 4 replaces this with openDatabase(config.databasePath).
const db = null as unknown as DatabaseSync;
const ctx: AppContext = { db, config };

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildScheduledEvents,
  ],
});

client.once(Events.ClientReady, (c) => {
  console.log(`Logged in as ${c.user.tag}`);
});

client.on(Events.InteractionCreate, (interaction) => {
  void routeInteraction(interaction, ctx);
});

await client.login(config.token);
```

`scripts/deploy-commands.ts`:

```ts
import { REST, Routes } from "discord.js";
import { loadConfig } from "../src/config.js";
import { commands } from "../src/commands/index.js";

const config = loadConfig();
const body = commands.map((c) => c.data.toJSON());
const rest = new REST().setToken(config.token);

// Guild-scoped registration appears instantly; global registration can take an
// hour to propagate. Use the dev guild whenever one is configured.
const route = config.devGuildId
  ? Routes.applicationGuildCommands(config.applicationId, config.devGuildId)
  : Routes.applicationCommands(config.applicationId);

await rest.put(route, { body });
console.log(`Registered ${body.length} command(s) to ${config.devGuildId ?? "global"}.`);
```

- [ ] **Step 8: Verify against real Discord**

Run: `npm run deploy` — expect `Registered 1 command(s) to <your guild id>.`
Run: `npm run dev` — expect `Logged in as <bot>#1234`.
In your server, type `/gamenight ping`. Expect a private reply with a round-trip time.

If the command does not appear, the cause is almost always a missing `applications.commands` scope on the invite. Re-invite with both scopes.

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "feat: project skeleton with config, router, and /gamenight ping"
```

---

## Task 2: Time parsing and window expansion (`src/domain/timeblocks.ts`)

Pure module. No Discord, no database. This is where DST and midnight-crossing bugs would otherwise hide.

**Files:**
- Create: `src/domain/timeblocks.ts`
- Test: `src/domain/timeblocks.test.ts`

**Interfaces:**
- Consumes: nothing (luxon only).
- Produces:
  - `class TimeParseError extends Error` — its `message` is shown to users verbatim, so it must read as help, not as a stack trace.
  - `parseWindow(input: string): { startHour: number; endHour: number }`
  - `parseDays(input: string, tz: string, now: DateTime): string[]` — ISO `YYYY-MM-DD` strings, deduped and ascending, at most 5
  - `interface NightDay { dayIndex: number; startUtc: number; endUtc: number }`
  - `expandDays(isoDates: string[], window: { startHour: number; endHour: number }, tz: string): NightDay[]`
  - `hoursIn(day: NightDay): number[]` — epoch seconds at each hour boundary, `startUtc` inclusive, `endUtc` exclusive
  - `parseDeadline(input: string, tz: string, now: DateTime): number` — epoch seconds
  - `formatHourLabel(utcHour: number, tz: string): string` — e.g. `"6p"`, `"12a"`
  - `formatDayLabel(day: NightDay, tz: string): string` — e.g. `"Fri Aug 28"`

- [ ] **Step 1: Write the failing tests**

`src/domain/timeblocks.test.ts`:

```ts
import { DateTime } from "luxon";
import { describe, expect, it } from "vitest";
import {
  TimeParseError,
  expandDays,
  formatDayLabel,
  formatHourLabel,
  hoursIn,
  parseDays,
  parseDeadline,
  parseWindow,
} from "./timeblocks.js";

const CHI = "America/Chicago";
// A Tuesday.
const NOW = DateTime.fromISO("2026-08-25T12:00:00", { zone: CHI });

describe("parseWindow", () => {
  it("parses 12-hour with meridiems", () => {
    expect(parseWindow("6pm-1am")).toEqual({ startHour: 18, endHour: 1 });
  });

  it("parses 24-hour", () => {
    expect(parseWindow("18-01")).toEqual({ startHour: 18, endHour: 1 });
  });

  it("accepts explicit zero minutes", () => {
    expect(parseWindow("6:00pm-11:00pm")).toEqual({ startHour: 18, endHour: 23 });
  });

  it("treats 12am as midnight and 12pm as noon", () => {
    expect(parseWindow("12pm-12am")).toEqual({ startHour: 12, endHour: 0 });
  });

  it("rejects non-zero minutes with an explanation", () => {
    expect(() => parseWindow("6:30pm-11pm")).toThrow(TimeParseError);
    expect(() => parseWindow("6:30pm-11pm")).toThrow(/whole hours/i);
  });

  it("rejects a window of zero length", () => {
    expect(() => parseWindow("8pm-8pm")).toThrow(/at least one hour/i);
  });

  it("rejects gibberish", () => {
    expect(() => parseWindow("evening")).toThrow(TimeParseError);
  });
});

describe("parseDays", () => {
  it("resolves weekday names to the next occurrence", () => {
    expect(parseDays("fri,sat", CHI, NOW)).toEqual(["2026-08-28", "2026-08-29"]);
  });

  it("resolves a weekday name for today to today", () => {
    expect(parseDays("tue", CHI, NOW)).toEqual(["2026-08-25"]);
  });

  it("accepts long names, ISO dates, and MM/DD together, sorted and deduped", () => {
    expect(parseDays("friday, 2026-08-28, 08/30", CHI, NOW)).toEqual([
      "2026-08-28",
      "2026-08-30",
    ]);
  });

  it("rolls MM/DD into next year when it has already passed", () => {
    expect(parseDays("01/03", CHI, NOW)).toEqual(["2027-01-03"]);
  });

  it("rejects more than five days", () => {
    expect(() => parseDays("mon,tue,wed,thu,fri,sat", CHI, NOW)).toThrow(/5 days/);
  });

  it("rejects an empty list", () => {
    expect(() => parseDays("  ", CHI, NOW)).toThrow(TimeParseError);
  });

  it("rejects an unparseable token by name", () => {
    expect(() => parseDays("fri,someday", CHI, NOW)).toThrow(/someday/);
  });
});

describe("expandDays", () => {
  it("expands an evening window into UTC instants", () => {
    const [day] = expandDays(["2026-08-28"], { startHour: 18, endHour: 23 }, CHI);
    expect(DateTime.fromSeconds(day.startUtc, { zone: CHI }).hour).toBe(18);
    expect(DateTime.fromSeconds(day.endUtc, { zone: CHI }).hour).toBe(23);
    expect(hoursIn(day)).toHaveLength(5);
  });

  it("carries a window that crosses midnight into the next day", () => {
    const [day] = expandDays(["2026-08-28"], { startHour: 18, endHour: 1 }, CHI);
    const end = DateTime.fromSeconds(day.endUtc, { zone: CHI });
    expect(end.day).toBe(29);
    expect(end.hour).toBe(1);
    expect(hoursIn(day)).toHaveLength(7);
  });

  it("numbers days from zero in order", () => {
    const days = expandDays(
      ["2026-08-28", "2026-08-29"],
      { startHour: 18, endHour: 22 },
      CHI,
    );
    expect(days.map((d) => d.dayIndex)).toEqual([0, 1]);
  });

  it("produces one fewer hour across a spring-forward transition", () => {
    // US DST begins 2027-03-14; 2am local does not exist.
    const [day] = expandDays(["2027-03-13"], { startHour: 22, endHour: 5 }, CHI);
    // 10pm to 5am is 7 wall-clock hours but only 6 real ones that night.
    expect(hoursIn(day)).toHaveLength(6);
  });

  it("emits hours exactly one hour apart, aligned to the hour", () => {
    const [day] = expandDays(["2026-08-28"], { startHour: 18, endHour: 23 }, CHI);
    const hours = hoursIn(day);
    expect(hours.every((h) => h % 3600 === 0)).toBe(true);
    expect(hours[1] - hours[0]).toBe(3600);
  });
});

describe("parseDeadline", () => {
  it("parses a relative duration in hours", () => {
    expect(parseDeadline("24h", CHI, NOW)).toBe(NOW.plus({ hours: 24 }).toUnixInteger());
  });

  it("parses a relative duration in days", () => {
    expect(parseDeadline("2d", CHI, NOW)).toBe(NOW.plus({ days: 2 }).toUnixInteger());
  });

  it("parses a weekday and time in the given zone", () => {
    const expected = DateTime.fromISO("2026-08-27T21:00:00", { zone: CHI });
    expect(parseDeadline("thu 9pm", CHI, NOW)).toBe(expected.toUnixInteger());
  });

  it("parses an absolute date and time", () => {
    const expected = DateTime.fromISO("2026-08-27T21:00:00", { zone: CHI });
    expect(parseDeadline("2026-08-27 21:00", CHI, NOW)).toBe(expected.toUnixInteger());
  });

  it("rejects a deadline in the past", () => {
    expect(() => parseDeadline("2026-08-24 21:00", CHI, NOW)).toThrow(/future/i);
  });

  it("rejects gibberish", () => {
    expect(() => parseDeadline("soon", CHI, NOW)).toThrow(TimeParseError);
  });
});

describe("formatting", () => {
  it("labels hours compactly in the target zone", () => {
    const [day] = expandDays(["2026-08-28"], { startHour: 18, endHour: 23 }, CHI);
    expect(formatHourLabel(hoursIn(day)[0], CHI)).toBe("6p");
  });

  it("labels midnight and noon unambiguously", () => {
    const [day] = expandDays(["2026-08-28"], { startHour: 12, endHour: 14 }, CHI);
    const hours = hoursIn(day);
    expect(formatHourLabel(hours[0], CHI)).toBe("12p");
    expect(formatHourLabel(hours[0] + 12 * 3600, CHI)).toBe("12a");
  });

  it("renders the same instant differently per viewer zone", () => {
    const [day] = expandDays(["2026-08-28"], { startHour: 18, endHour: 23 }, CHI);
    expect(formatHourLabel(hoursIn(day)[0], "America/New_York")).toBe("7p");
  });

  it("labels a day", () => {
    const [day] = expandDays(["2026-08-28"], { startHour: 18, endHour: 23 }, CHI);
    expect(formatDayLabel(day, CHI)).toBe("Fri Aug 28");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/domain/timeblocks.test.ts`
Expected: FAIL — cannot resolve `./timeblocks.js`.

- [ ] **Step 3: Implement the module**

`src/domain/timeblocks.ts`:

```ts
import { DateTime } from "luxon";

export class TimeParseError extends Error {}

export interface HourWindow {
  startHour: number;
  endHour: number;
}

export interface NightDay {
  dayIndex: number;
  startUtc: number;
  endUtc: number;
}

export const MAX_DAYS = 5;

const TIME = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i;

function parseClockHour(raw: string, whole: string): number {
  const match = TIME.exec(raw.trim());
  if (!match) {
    throw new TimeParseError(
      `I could not read "${whole}" as a time window. Try something like \`6pm-1am\` or \`18-01\`.`,
    );
  }
  const [, hourText, minuteText, meridiem] = match;
  if (minuteText && minuteText !== "00") {
    throw new TimeParseError(
      `Availability is tracked in whole hours, so "${raw.trim()}" will not work. Use \`6pm\`, not \`6:30pm\`.`,
    );
  }
  let hour = Number(hourText);
  if (meridiem) {
    if (hour < 1 || hour > 12) {
      throw new TimeParseError(`"${raw.trim()}" is not a valid 12-hour time.`);
    }
    if (hour === 12) hour = 0;
    if (meridiem.toLowerCase() === "pm") hour += 12;
  } else if (hour < 0 || hour > 24) {
    throw new TimeParseError(`"${raw.trim()}" is not a valid hour.`);
  }
  return hour % 24;
}

export function parseWindow(input: string): HourWindow {
  const parts = input.split("-");
  if (parts.length !== 2) {
    throw new TimeParseError(
      `I could not read "${input}" as a time window. Try something like \`6pm-1am\`.`,
    );
  }
  const startHour = parseClockHour(parts[0], input);
  const endHour = parseClockHour(parts[1], input);
  if (startHour === endHour) {
    throw new TimeParseError("A game night window needs to be at least one hour long.");
  }
  return { startHour, endHour };
}

const WEEKDAYS: Record<string, number> = {
  mon: 1, monday: 1,
  tue: 2, tues: 2, tuesday: 2,
  wed: 3, weds: 3, wednesday: 3,
  thu: 4, thur: 4, thurs: 4, thursday: 4,
  fri: 5, friday: 5,
  sat: 6, saturday: 6,
  sun: 7, sunday: 7,
};

function resolveDayToken(token: string, tz: string, now: DateTime): string {
  const text = token.trim().toLowerCase();
  const today = now.setZone(tz).startOf("day");

  const weekday = WEEKDAYS[text];
  if (weekday !== undefined) {
    // Luxon weekdays are 1 (Monday) through 7 (Sunday).
    const delta = (weekday - today.weekday + 7) % 7;
    return today.plus({ days: delta }).toISODate()!;
  }

  const iso = DateTime.fromISO(text, { zone: tz });
  if (iso.isValid) return iso.startOf("day").toISODate()!;

  const slash = /^(\d{1,2})\/(\d{1,2})$/.exec(text);
  if (slash) {
    const [, month, day] = slash;
    let candidate = DateTime.fromObject(
      { year: today.year, month: Number(month), day: Number(day) },
      { zone: tz },
    );
    if (!candidate.isValid) {
      throw new TimeParseError(`"${token.trim()}" is not a real date.`);
    }
    if (candidate < today) candidate = candidate.plus({ years: 1 });
    return candidate.toISODate()!;
  }

  throw new TimeParseError(
    `I could not read "${token.trim()}" as a day. Use a weekday (\`fri\`), a date (\`2026-08-28\`), or \`MM/DD\`.`,
  );
}

export function parseDays(input: string, tz: string, now: DateTime): string[] {
  const tokens = input.split(",").map((t) => t.trim()).filter((t) => t.length > 0);
  if (tokens.length === 0) {
    throw new TimeParseError("Give me at least one day, like `fri,sat`.");
  }
  const dates = [...new Set(tokens.map((t) => resolveDayToken(t, tz, now)))].sort();
  if (dates.length > MAX_DAYS) {
    throw new TimeParseError(
      `A game night can cover at most ${MAX_DAYS} days — Discord only allows five dropdowns in one message. You gave ${dates.length}.`,
    );
  }
  return dates;
}

export function expandDays(
  isoDates: string[],
  window: HourWindow,
  tz: string,
): NightDay[] {
  return isoDates.map((iso, dayIndex) => {
    const base = DateTime.fromISO(iso, { zone: tz }).startOf("day");
    const start = base.set({ hour: window.startHour });
    const crossesMidnight = window.endHour <= window.startHour;
    const end = (crossesMidnight ? base.plus({ days: 1 }) : base).set({
      hour: window.endHour,
    });
    return { dayIndex, startUtc: start.toUnixInteger(), endUtc: end.toUnixInteger() };
  });
}

export function hoursIn(day: NightDay): number[] {
  const hours: number[] = [];
  for (let t = day.startUtc; t < day.endUtc; t += 3600) hours.push(t);
  return hours;
}

export function parseDeadline(input: string, tz: string, now: DateTime): number {
  const text = input.trim().toLowerCase();
  const base = now.setZone(tz);
  let result: DateTime | null = null;

  const relative = /^(\d+)\s*(h|hr|hrs|hour|hours|d|day|days)$/.exec(text);
  if (relative) {
    const amount = Number(relative[1]);
    result = relative[2].startsWith("h")
      ? base.plus({ hours: amount })
      : base.plus({ days: amount });
  }

  if (!result) {
    const absolute = DateTime.fromISO(text.replace(" ", "T"), { zone: tz });
    if (absolute.isValid) result = absolute;
  }

  if (!result) {
    const weekdayTime = /^([a-z]+)\s+(.+)$/.exec(text);
    if (weekdayTime && WEEKDAYS[weekdayTime[1]] !== undefined) {
      const iso = resolveDayToken(weekdayTime[1], tz, now);
      const hour = parseClockHour(weekdayTime[2], input);
      result = DateTime.fromISO(iso, { zone: tz }).set({ hour });
      // "thu 9pm" when it is already Thursday 10pm means next Thursday.
      if (result <= base) result = result.plus({ weeks: 1 });
    }
  }

  if (!result || !result.isValid) {
    throw new TimeParseError(
      `I could not read "${input}" as a deadline. Try \`thu 9pm\`, \`24h\`, or \`2026-08-27 21:00\`.`,
    );
  }
  if (result <= base) {
    throw new TimeParseError("The deadline needs to be in the future.");
  }
  return result.toUnixInteger();
}

export function formatHourLabel(utcHour: number, tz: string): string {
  const local = DateTime.fromSeconds(utcHour, { zone: tz });
  const hour12 = local.hour % 12 === 0 ? 12 : local.hour % 12;
  return `${hour12}${local.hour < 12 ? "a" : "p"}`;
}

export function formatDayLabel(day: NightDay, tz: string): string {
  return DateTime.fromSeconds(day.startUtc, { zone: tz }).toFormat("ccc LLL d");
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/domain/timeblocks.test.ts`
Expected: PASS. If the spring-forward test fails, check that `expandDays` builds instants through luxon zones rather than adding `3600 * hours` to a start time — that shortcut is exactly what the test exists to catch.

- [ ] **Step 5: Commit**

```bash
git add src/domain/timeblocks.ts src/domain/timeblocks.test.ts
git commit -m "feat: day, window, and deadline parsing with DST-correct expansion"
```

---

## Task 3: The scheduling engine (`src/domain/scheduling.ts`)

The heart of the bot, and still pure: sets of hours and votes in, ranked suggestions out.

**Files:**
- Create: `src/domain/scheduling.ts`
- Test: `src/domain/scheduling.test.ts`

**Interfaces:**
- Consumes: `NightDay` and `hoursIn` from `./timeblocks.js`.
- Produces:
  - `interface Game { id: number; name: string; minPlayers: number; maxPlayers: number | null }`
  - `interface SchedulingInput { days: NightDay[]; minSessionHours: number; games: Game[]; availability: Map<string, Set<number>>; votes: Map<string, Set<number>> }`
  - `interface Suggestion { dayIndex: number; startUtc: number; endUtc: number; game: Game; roster: string[]; oversubscribed: boolean }`
  - `interface NearMiss { dayIndex: number; startUtc: number; endUtc: number; game: Game; rosterSize: number; shortfall: number }`
  - `interface SchedulingResult { top: Suggestion[]; nearMisses: NearMiss[] }`
  - `rankNight(input: SchedulingInput): SchedulingResult`
  - `MAX_SUGGESTIONS = 3`

- [ ] **Step 1: Write the failing tests**

`src/domain/scheduling.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { rankNight, type Game, type SchedulingInput } from "./scheduling.js";
import type { NightDay } from "./timeblocks.js";

const H = 3600;
/** Day 0 runs 0..6 in "hour units" for readability; real code uses epoch seconds. */
const day = (dayIndex: number, hourCount: number): NightDay => ({
  dayIndex,
  startUtc: dayIndex * 100 * H,
  endUtc: dayIndex * 100 * H + hourCount * H,
});
const at = (d: NightDay, offset: number) => d.startUtc + offset * H;

const deepRock: Game = { id: 1, name: "Deep Rock", minPlayers: 4, maxPlayers: 4 };
const lethal: Game = { id: 2, name: "Lethal Company", minPlayers: 2, maxPlayers: 4 };
const solo: Game = { id: 3, name: "Solo Game", minPlayers: 1, maxPlayers: null };

function input(over: Partial<SchedulingInput> = {}): SchedulingInput {
  return {
    days: [day(0, 6)],
    minSessionHours: 2,
    games: [lethal],
    availability: new Map(),
    votes: new Map(),
    ...over,
  };
}

/** Everyone free for the same offsets, all voting for the same games. */
function everyone(
  d: NightDay,
  users: string[],
  offsets: number[],
  gameIds: number[],
): Pick<SchedulingInput, "availability" | "votes"> {
  return {
    availability: new Map(users.map((u) => [u, new Set(offsets.map((o) => at(d, o)))])),
    votes: new Map(users.map((u) => [u, new Set(gameIds)])),
  };
}

describe("rankNight", () => {
  it("returns nothing when nobody has responded", () => {
    expect(rankNight(input())).toEqual({ top: [], nearMisses: [] });
  });

  it("returns nothing when one person is free and the game needs two", () => {
    const d = day(0, 6);
    const result = rankNight(input(everyone(d, ["a"], [0, 1, 2], [2])));
    expect(result.top).toEqual([]);
    expect(result.nearMisses[0]).toMatchObject({ rosterSize: 1, shortfall: 1 });
  });

  it("suggests a window when enough people are free for all of it", () => {
    const d = day(0, 6);
    const result = rankNight(input(everyone(d, ["a", "b"], [0, 1, 2], [2])));
    expect(result.top).toHaveLength(1);
    expect(result.top[0]).toMatchObject({
      game: lethal,
      startUtc: at(d, 0),
      endUtc: at(d, 3),
      oversubscribed: false,
    });
    expect(result.top[0].roster.sort()).toEqual(["a", "b"]);
  });

  it("excludes a run shorter than the minimum session", () => {
    const d = day(0, 6);
    const result = rankNight(
      input({ ...everyone(d, ["a", "b"], [0], [2]), minSessionHours: 2 }),
    );
    expect(result.top).toEqual([]);
  });

  it("excludes someone who is free for only part of the run", () => {
    const d = day(0, 6);
    const result = rankNight(
      input({
        availability: new Map([
          ["a", new Set([at(d, 0), at(d, 1), at(d, 2)])],
          ["b", new Set([at(d, 0), at(d, 1), at(d, 2)])],
          ["c", new Set([at(d, 0)])],
        ]),
        votes: new Map([
          ["a", new Set([2])],
          ["b", new Set([2])],
          ["c", new Set([2])],
        ]),
      }),
    );
    expect(result.top[0].roster.sort()).toEqual(["a", "b"]);
  });

  it("excludes someone who did not vote for the game", () => {
    const d = day(0, 6);
    const result = rankNight(
      input({
        availability: new Map([
          ["a", new Set([at(d, 0), at(d, 1)])],
          ["b", new Set([at(d, 0), at(d, 1)])],
          ["c", new Set([at(d, 0), at(d, 1)])],
        ]),
        votes: new Map([
          ["a", new Set([2])],
          ["b", new Set([2])],
          ["c", new Set([1])],
        ]),
      }),
    );
    expect(result.top[0].roster.sort()).toEqual(["a", "b"]);
  });

  it("reports a roster below min_players as a near miss, never a suggestion", () => {
    const d = day(0, 6);
    const result = rankNight(
      input({ ...everyone(d, ["a", "b", "c"], [0, 1, 2], [1]), games: [deepRock] }),
    );
    expect(result.top).toEqual([]);
    expect(result.nearMisses[0]).toMatchObject({ game: deepRock, rosterSize: 3, shortfall: 1 });
  });

  it("keeps a roster above max_players but flags it", () => {
    const d = day(0, 6);
    const result = rankNight(
      input(everyone(d, ["a", "b", "c", "d", "e"], [0, 1, 2], [2])),
    );
    expect(result.top[0].oversubscribed).toBe(true);
  });

  it("never flags a game with no maximum", () => {
    const d = day(0, 6);
    const result = rankNight(
      input({ ...everyone(d, ["a", "b", "c"], [0, 1, 2], [3]), games: [solo] }),
    );
    expect(result.top[0].oversubscribed).toBe(false);
  });

  it("prefers more players over a longer window", () => {
    const d = day(0, 6);
    const result = rankNight(
      input({
        games: [lethal, solo],
        availability: new Map([
          ["a", new Set([at(d, 0), at(d, 1), at(d, 2), at(d, 3)])],
          ["b", new Set([at(d, 2), at(d, 3)])],
        ]),
        votes: new Map([
          ["a", new Set([2, 3])],
          ["b", new Set([2, 3])],
        ]),
      }),
    );
    expect(result.top[0].roster).toHaveLength(2);
  });

  it("prefers the longer window when player counts tie", () => {
    const d = day(0, 6);
    const result = rankNight(input(everyone(d, ["a", "b"], [0, 1, 2, 3], [2])));
    expect(result.top[0].endUtc - result.top[0].startUtc).toBe(4 * H);
  });

  it("prefers the earlier start when players and length tie", () => {
    const d = day(0, 6);
    const result = rankNight(
      input({
        // Free 0-2 and 4-6, so two equal two-hour runs exist.
        availability: new Map([
          ["a", new Set([at(d, 0), at(d, 1), at(d, 4), at(d, 5)])],
          ["b", new Set([at(d, 0), at(d, 1), at(d, 4), at(d, 5)])],
        ]),
        votes: new Map([
          ["a", new Set([2])],
          ["b", new Set([2])],
        ]),
      }),
    );
    expect(result.top[0].startUtc).toBe(at(d, 0));
  });

  it("keeps only the best window per day and game", () => {
    const d = day(0, 6);
    const result = rankNight(input(everyone(d, ["a", "b"], [0, 1, 2, 3], [2])));
    expect(result.top).toHaveLength(1);
  });

  it("prefers three different days over three slices of one evening", () => {
    const days = [day(0, 6), day(1, 6), day(2, 6)];
    const availability = new Map<string, Set<number>>();
    const votes = new Map<string, Set<number>>();
    for (const user of ["a", "b"]) {
      availability.set(
        user,
        new Set(days.flatMap((d) => [at(d, 0), at(d, 1), at(d, 2)])),
      );
      votes.set(user, new Set([2, 3]));
    }
    const result = rankNight(input({ days, games: [lethal, solo], availability, votes }));
    expect(new Set(result.top.map((s) => s.dayIndex)).size).toBe(3);
  });

  it("backfills from the same day when there are not three days available", () => {
    const d = day(0, 6);
    const result = rankNight(
      input({ ...everyone(d, ["a", "b"], [0, 1, 2], [2, 3]), games: [lethal, solo] }),
    );
    expect(result.top).toHaveLength(2);
    expect(result.top.every((s) => s.dayIndex === 0)).toBe(true);
  });

  it("returns at most three suggestions", () => {
    const days = [day(0, 6), day(1, 6), day(2, 6), day(3, 6)];
    const availability = new Map<string, Set<number>>();
    const votes = new Map<string, Set<number>>();
    for (const user of ["a", "b"]) {
      availability.set(
        user,
        new Set(days.flatMap((d) => [at(d, 0), at(d, 1), at(d, 2)])),
      );
      votes.set(user, new Set([2, 3]));
    }
    const result = rankNight(input({ days, games: [lethal, solo], availability, votes }));
    expect(result.top).toHaveLength(3);
  });

  it("ranks near misses by smallest shortfall first", () => {
    const d = day(0, 6);
    const almost: Game = { id: 4, name: "Almost", minPlayers: 3, maxPlayers: null };
    const distant: Game = { id: 5, name: "Distant", minPlayers: 8, maxPlayers: null };
    const result = rankNight(
      input({
        games: [almost, distant],
        ...everyone(d, ["a", "b"], [0, 1, 2], [4, 5]),
      }),
    );
    expect(result.top).toEqual([]);
    expect(result.nearMisses[0].game).toEqual(almost);
  });

  it("treats users in different timezones as overlapping when the UTC hour matches", () => {
    const d = day(0, 6);
    // Three users picked "8pm" in three zones; only two produced the same instant.
    const result = rankNight(
      input({
        availability: new Map([
          ["chicago", new Set([at(d, 0), at(d, 1)])],
          ["newyork", new Set([at(d, 0), at(d, 1)])],
          ["london", new Set([at(d, 4), at(d, 5)])],
        ]),
        votes: new Map([
          ["chicago", new Set([2])],
          ["newyork", new Set([2])],
          ["london", new Set([2])],
        ]),
      }),
    );
    expect(result.top[0].roster.sort()).toEqual(["chicago", "newyork"]);
  });

  it("ignores availability hours that are not part of any day", () => {
    const d = day(0, 6);
    const result = rankNight(
      input({
        availability: new Map([
          ["a", new Set([at(d, 0), at(d, 1), 999_999 * H])],
          ["b", new Set([at(d, 0), at(d, 1)])],
        ]),
        votes: new Map([
          ["a", new Set([2])],
          ["b", new Set([2])],
        ]),
      }),
    );
    expect(result.top[0].endUtc).toBe(at(d, 2));
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/domain/scheduling.test.ts`
Expected: FAIL — cannot resolve `./scheduling.js`.

- [ ] **Step 3: Implement the engine**

`src/domain/scheduling.ts`:

```ts
import { hoursIn, type NightDay } from "./timeblocks.js";

export interface Game {
  id: number;
  name: string;
  minPlayers: number;
  maxPlayers: number | null;
}

export interface SchedulingInput {
  days: NightDay[];
  minSessionHours: number;
  games: Game[];
  /** userId -> the UTC hours (epoch seconds) they are free. */
  availability: Map<string, Set<number>>;
  /** userId -> the game ids they would play. */
  votes: Map<string, Set<number>>;
}

export interface Suggestion {
  dayIndex: number;
  startUtc: number;
  endUtc: number;
  game: Game;
  roster: string[];
  oversubscribed: boolean;
}

export interface NearMiss {
  dayIndex: number;
  startUtc: number;
  endUtc: number;
  game: Game;
  rosterSize: number;
  shortfall: number;
}

export interface SchedulingResult {
  top: Suggestion[];
  nearMisses: NearMiss[];
}

export const MAX_SUGGESTIONS = 3;

const HOUR = 3600;

/** Users free for every hour of the run. Partial attendance does not count. */
function freeForAll(
  run: number[],
  availability: Map<string, Set<number>>,
): string[] {
  const users: string[] = [];
  for (const [userId, hours] of availability) {
    if (run.every((hour) => hours.has(hour))) users.push(userId);
  }
  return users;
}

function totalVotes(gameId: number, votes: Map<string, Set<number>>): number {
  let count = 0;
  for (const chosen of votes.values()) if (chosen.has(gameId)) count += 1;
  return count;
}

function compareSuggestions(
  a: Suggestion,
  b: Suggestion,
  voteCounts: Map<number, number>,
): number {
  if (a.roster.length !== b.roster.length) return b.roster.length - a.roster.length;
  const aLength = a.endUtc - a.startUtc;
  const bLength = b.endUtc - b.startUtc;
  if (aLength !== bLength) return bLength - aLength;
  if (a.startUtc !== b.startUtc) return a.startUtc - b.startUtc;
  return (voteCounts.get(b.game.id) ?? 0) - (voteCounts.get(a.game.id) ?? 0);
}

export function rankNight(input: SchedulingInput): SchedulingResult {
  const { days, minSessionHours, games, availability, votes } = input;

  const voteCounts = new Map(games.map((g) => [g.id, totalVotes(g.id, votes)]));
  const voters = new Map(
    games.map((g) => [
      g.id,
      new Set(
        [...votes.entries()].filter(([, ids]) => ids.has(g.id)).map(([userId]) => userId),
      ),
    ]),
  );

  const suggestions: Suggestion[] = [];
  const misses: NearMiss[] = [];

  for (const day of days) {
    const hours = hoursIn(day);
    for (let start = 0; start < hours.length; start += 1) {
      for (let end = start + minSessionHours; end <= hours.length; end += 1) {
        const run = hours.slice(start, end);
        const free = freeForAll(run, availability);
        if (free.length === 0) continue;

        const startUtc = run[0];
        const endUtc = run[run.length - 1] + HOUR;

        for (const game of games) {
          const eligible = voters.get(game.id)!;
          const roster = free.filter((userId) => eligible.has(userId));
          if (roster.length === 0) continue;

          if (roster.length >= game.minPlayers) {
            suggestions.push({
              dayIndex: day.dayIndex,
              startUtc,
              endUtc,
              game,
              roster: roster.sort(),
              oversubscribed:
                game.maxPlayers !== null && roster.length > game.maxPlayers,
            });
          } else {
            misses.push({
              dayIndex: day.dayIndex,
              startUtc,
              endUtc,
              game,
              rosterSize: roster.length,
              shortfall: game.minPlayers - roster.length,
            });
          }
        }
      }
    }
  }

  suggestions.sort((a, b) => compareSuggestions(a, b, voteCounts));

  // One entry per (day, game): the sort above already put the best one first.
  const bestPerDayGame: Suggestion[] = [];
  const seen = new Set<string>();
  for (const suggestion of suggestions) {
    const key = `${suggestion.dayIndex}:${suggestion.game.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    bestPerDayGame.push(suggestion);
  }

  // Prefer distinct days, then backfill in rank order if we came up short.
  const top: Suggestion[] = [];
  const usedDays = new Set<number>();
  const skipped: Suggestion[] = [];
  for (const suggestion of bestPerDayGame) {
    if (top.length === MAX_SUGGESTIONS) break;
    if (usedDays.has(suggestion.dayIndex)) {
      skipped.push(suggestion);
      continue;
    }
    usedDays.add(suggestion.dayIndex);
    top.push(suggestion);
  }
  for (const suggestion of skipped) {
    if (top.length === MAX_SUGGESTIONS) break;
    top.push(suggestion);
  }

  misses.sort((a, b) => {
    if (a.shortfall !== b.shortfall) return a.shortfall - b.shortfall;
    if (a.rosterSize !== b.rosterSize) return b.rosterSize - a.rosterSize;
    return a.startUtc - b.startUtc;
  });
  const bestMisses: NearMiss[] = [];
  const missSeen = new Set<string>();
  for (const miss of misses) {
    const key = `${miss.dayIndex}:${miss.game.id}`;
    if (missSeen.has(key)) continue;
    missSeen.add(key);
    bestMisses.push(miss);
    if (bestMisses.length === MAX_SUGGESTIONS) break;
  }

  return { top, nearMisses: top.length > 0 ? [] : bestMisses };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/domain/scheduling.test.ts`
Expected: PASS, 19 tests.

- [ ] **Step 5: Commit**

```bash
git add src/domain/scheduling.ts src/domain/scheduling.test.ts
git commit -m "feat: rank (window x game) combinations into top-3 suggestions"
```

---

## Task 4: Database, schema, and the users and games repositories

**Files:**
- Create: `src/db/schema.sql`, `src/db/index.ts`, `src/db/repos/users.ts`, `src/db/repos/games.ts`
- Modify: `src/index.ts` (replace the `null as unknown as DatabaseSync` placeholder from Task 1)
- Test: `src/db/repos/games.test.ts`, `src/db/repos/users.test.ts`

**Interfaces:**
- Consumes: `Game` from `../../domain/scheduling.js`.
- Produces:
  - `openDatabase(path: string): DatabaseSync`
  - users: `getTimezone(db, userId): string | null`, `setTimezone(db, userId, tz): void`
  - games: `addGame(db, guildId, name, minPlayers, maxPlayers, createdBy): Game`, `findGameByName(db, guildId, name): Game | null`, `listGames(db, guildId): Game[]`, `getGamesByIds(db, ids): Game[]`, `removeGame(db, guildId, name, actorId, force): boolean`

**Note on the driver:** `node:sqlite` is built into Node, so there is nothing to compile. If `import { DatabaseSync } from "node:sqlite"` throws on the installed Node, run `npm install better-sqlite3 @types/better-sqlite3` and change **only** `src/db/index.ts` — its `prepare/run/get/all` surface is the same, so no repository changes.

- [ ] **Step 1: Write the schema**

`src/db/schema.sql`:

```sql
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  user_id  TEXT PRIMARY KEY,
  timezone TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS games (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id     TEXT NOT NULL,
  name         TEXT NOT NULL,
  min_players  INTEGER NOT NULL CHECK (min_players >= 1),
  max_players  INTEGER,
  created_by   TEXT NOT NULL,
  CHECK (max_players IS NULL OR max_players >= min_players)
);

CREATE UNIQUE INDEX IF NOT EXISTS games_guild_name
  ON games (guild_id, lower(name));

CREATE TABLE IF NOT EXISTS nights (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id          TEXT NOT NULL,
  channel_id        TEXT NOT NULL,
  message_id        TEXT,
  host_id           TEXT NOT NULL,
  title             TEXT NOT NULL,
  display_tz        TEXT NOT NULL,
  min_session_hours INTEGER NOT NULL,
  deadline_utc      INTEGER NOT NULL,
  status            TEXT NOT NULL
                    CHECK (status IN ('draft','open','locked','failed','cancelled')),
  voice_channel_id  TEXT,
  locked_start_utc  INTEGER,
  locked_end_utc    INTEGER,
  locked_game_id    INTEGER REFERENCES games(id),
  event_id          TEXT,
  created_utc       INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS nights_due ON nights (status, deadline_utc);

CREATE TABLE IF NOT EXISTS night_days (
  night_id         INTEGER NOT NULL REFERENCES nights(id) ON DELETE CASCADE,
  day_index        INTEGER NOT NULL,
  window_start_utc INTEGER NOT NULL,
  window_end_utc   INTEGER NOT NULL,
  PRIMARY KEY (night_id, day_index)
);

CREATE TABLE IF NOT EXISTS night_games (
  night_id INTEGER NOT NULL REFERENCES nights(id) ON DELETE CASCADE,
  game_id  INTEGER NOT NULL REFERENCES games(id),
  PRIMARY KEY (night_id, game_id)
);

CREATE TABLE IF NOT EXISTS availability (
  night_id INTEGER NOT NULL REFERENCES nights(id) ON DELETE CASCADE,
  user_id  TEXT NOT NULL,
  utc_hour INTEGER NOT NULL,
  PRIMARY KEY (night_id, user_id, utc_hour)
);

CREATE TABLE IF NOT EXISTS game_votes (
  night_id INTEGER NOT NULL REFERENCES nights(id) ON DELETE CASCADE,
  user_id  TEXT NOT NULL,
  game_id  INTEGER NOT NULL REFERENCES games(id),
  PRIMARY KEY (night_id, user_id, game_id)
);

CREATE TABLE IF NOT EXISTS attendance (
  night_id INTEGER NOT NULL REFERENCES nights(id) ON DELETE CASCADE,
  user_id  TEXT NOT NULL,
  status   TEXT NOT NULL CHECK (status IN ('in','out')),
  PRIMARY KEY (night_id, user_id)
);
```

- [ ] **Step 2: Write the failing repository tests**

`src/db/repos/games.test.ts`:

```ts
import { beforeEach, describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { openDatabase } from "../index.js";
import {
  addGame,
  findGameByName,
  getGamesByIds,
  listGames,
  removeGame,
} from "./games.js";

let db: DatabaseSync;
beforeEach(() => {
  db = openDatabase(":memory:");
});

describe("games repository", () => {
  it("adds and reads back a game", () => {
    const game = addGame(db, "g1", "Deep Rock", 2, 4, "u1");
    expect(game).toEqual({ id: game.id, name: "Deep Rock", minPlayers: 2, maxPlayers: 4 });
    expect(listGames(db, "g1")).toEqual([game]);
  });

  it("stores an unlimited maximum as null", () => {
    const game = addGame(db, "g1", "Valheim", 1, null, "u1");
    expect(game.maxPlayers).toBeNull();
  });

  it("keeps guilds separate", () => {
    addGame(db, "g1", "Deep Rock", 2, 4, "u1");
    expect(listGames(db, "g2")).toEqual([]);
  });

  it("finds a game case-insensitively", () => {
    addGame(db, "g1", "Deep Rock", 2, 4, "u1");
    expect(findGameByName(db, "g1", "  deep ROCK ")?.name).toBe("Deep Rock");
  });

  it("rejects a duplicate name in the same guild", () => {
    addGame(db, "g1", "Deep Rock", 2, 4, "u1");
    expect(() => addGame(db, "g1", "deep rock", 3, 5, "u2")).toThrow();
  });

  it("rejects a maximum below the minimum", () => {
    expect(() => addGame(db, "g1", "Bad", 4, 2, "u1")).toThrow();
  });

  it("rejects a minimum below one", () => {
    expect(() => addGame(db, "g1", "Bad", 0, 4, "u1")).toThrow();
  });

  it("lists games alphabetically", () => {
    addGame(db, "g1", "Zomboid", 1, null, "u1");
    addGame(db, "g1", "Astroneer", 1, null, "u1");
    expect(listGames(db, "g1").map((g) => g.name)).toEqual(["Astroneer", "Zomboid"]);
  });

  it("fetches a set of games by id", () => {
    const a = addGame(db, "g1", "A", 1, null, "u1");
    const b = addGame(db, "g1", "B", 1, null, "u1");
    addGame(db, "g1", "C", 1, null, "u1");
    expect(getGamesByIds(db, [a.id, b.id]).map((g) => g.name)).toEqual(["A", "B"]);
  });

  it("returns an empty list for no ids rather than failing", () => {
    expect(getGamesByIds(db, [])).toEqual([]);
  });

  it("lets the creator remove their own game", () => {
    addGame(db, "g1", "Deep Rock", 2, 4, "u1");
    expect(removeGame(db, "g1", "Deep Rock", "u1", false)).toBe(true);
    expect(listGames(db, "g1")).toEqual([]);
  });

  it("refuses removal by another member without force", () => {
    addGame(db, "g1", "Deep Rock", 2, 4, "u1");
    expect(removeGame(db, "g1", "Deep Rock", "u2", false)).toBe(false);
    expect(listGames(db, "g1")).toHaveLength(1);
  });

  it("allows a moderator to force removal", () => {
    addGame(db, "g1", "Deep Rock", 2, 4, "u1");
    expect(removeGame(db, "g1", "Deep Rock", "u2", true)).toBe(true);
  });
});
```

`src/db/repos/users.test.ts`:

```ts
import { beforeEach, describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { openDatabase } from "../index.js";
import { getTimezone, setTimezone } from "./users.js";

let db: DatabaseSync;
beforeEach(() => {
  db = openDatabase(":memory:");
});

describe("users repository", () => {
  it("returns null before a timezone is set", () => {
    expect(getTimezone(db, "u1")).toBeNull();
  });

  it("stores and reads a timezone", () => {
    setTimezone(db, "u1", "America/Chicago");
    expect(getTimezone(db, "u1")).toBe("America/Chicago");
  });

  it("overwrites on change rather than duplicating", () => {
    setTimezone(db, "u1", "America/Chicago");
    setTimezone(db, "u1", "Europe/London");
    expect(getTimezone(db, "u1")).toBe("Europe/London");
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run src/db`
Expected: FAIL — cannot resolve `../index.js`.

- [ ] **Step 4: Implement the database layer**

`src/db/index.ts`:

```ts
import { DatabaseSync } from "node:sqlite";
import { readFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const schemaPath = fileURLToPath(new URL("./schema.sql", import.meta.url));

export function openDatabase(path: string): DatabaseSync {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(readFileSync(schemaPath, "utf8"));
  return db;
}
```

Because `schema.sql` is not TypeScript, `tsc` will not copy it into `dist`. Add a copy step so `npm start` works from a build:

```json
{
  "scripts": {
    "build": "tsc && node -e \"require('fs').copyFileSync('src/db/schema.sql','dist/src/db/schema.sql')\""
  }
}
```

`src/db/repos/users.ts`:

```ts
import type { DatabaseSync } from "node:sqlite";

export function getTimezone(db: DatabaseSync, userId: string): string | null {
  const row = db
    .prepare("SELECT timezone FROM users WHERE user_id = ?")
    .get(userId) as { timezone: string } | undefined;
  return row?.timezone ?? null;
}

export function setTimezone(db: DatabaseSync, userId: string, timezone: string): void {
  db.prepare(
    `INSERT INTO users (user_id, timezone) VALUES (?, ?)
     ON CONFLICT(user_id) DO UPDATE SET timezone = excluded.timezone`,
  ).run(userId, timezone);
}
```

`src/db/repos/games.ts`:

```ts
import type { DatabaseSync } from "node:sqlite";
import type { Game } from "../../domain/scheduling.js";

interface GameRow {
  id: number;
  name: string;
  min_players: number;
  max_players: number | null;
}

const toGame = (row: GameRow): Game => ({
  id: row.id,
  name: row.name,
  minPlayers: row.min_players,
  maxPlayers: row.max_players,
});

const SELECT = "SELECT id, name, min_players, max_players FROM games";

export function addGame(
  db: DatabaseSync,
  guildId: string,
  name: string,
  minPlayers: number,
  maxPlayers: number | null,
  createdBy: string,
): Game {
  const trimmed = name.trim();
  const result = db
    .prepare(
      `INSERT INTO games (guild_id, name, min_players, max_players, created_by)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(guildId, trimmed, minPlayers, maxPlayers, createdBy);
  return {
    id: Number(result.lastInsertRowid),
    name: trimmed,
    minPlayers,
    maxPlayers,
  };
}

export function findGameByName(
  db: DatabaseSync,
  guildId: string,
  name: string,
): Game | null {
  const row = db
    .prepare(`${SELECT} WHERE guild_id = ? AND lower(name) = lower(?)`)
    .get(guildId, name.trim()) as GameRow | undefined;
  return row ? toGame(row) : null;
}

export function listGames(db: DatabaseSync, guildId: string): Game[] {
  const rows = db
    .prepare(`${SELECT} WHERE guild_id = ? ORDER BY name COLLATE NOCASE`)
    .all(guildId) as GameRow[];
  return rows.map(toGame);
}

export function getGamesByIds(db: DatabaseSync, ids: number[]): Game[] {
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => "?").join(",");
  const rows = db
    .prepare(`${SELECT} WHERE id IN (${placeholders}) ORDER BY name COLLATE NOCASE`)
    .all(...ids) as GameRow[];
  return rows.map(toGame);
}

export function removeGame(
  db: DatabaseSync,
  guildId: string,
  name: string,
  actorId: string,
  force: boolean,
): boolean {
  const row = db
    .prepare("SELECT id, created_by FROM games WHERE guild_id = ? AND lower(name) = lower(?)")
    .get(guildId, name.trim()) as { id: number; created_by: string } | undefined;
  if (!row) return false;
  if (!force && row.created_by !== actorId) return false;
  db.prepare("DELETE FROM games WHERE id = ?").run(row.id);
  return true;
}
```

**Implementer note:** every query builds on the `SELECT` constant, which already
includes `FROM games`. Interpolate it followed by a `WHERE` clause only — never
write `FROM games` a second time.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run src/db`
Expected: PASS, 16 tests. A failure on the duplicate-name or check-constraint tests means the schema was not applied — confirm `schema.sql` is being read from the right path.

- [ ] **Step 6: Wire the real database into the bot**

In `src/index.ts`, replace the placeholder from Task 1:

```ts
import { openDatabase } from "./db/index.js";
// ...
const db = openDatabase(config.databasePath);
const ctx: AppContext = { db, config };
```

Delete the now-unused `import type { DatabaseSync } from "node:sqlite";` line.

- [ ] **Step 7: Verify the bot still starts**

Run: `npm run dev`
Expected: `Logged in as ...`, and `data/gamenight.db` now exists. `/gamenight ping` still replies.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat: sqlite schema with users and games repositories"
```

---

## Task 5: Timezone onboarding and `/timezone set`

Everything downstream renders times per-viewer, so nothing else can be built until a user's zone is known.

**Files:**
- Create: `src/discord/timezonePicker.ts`, `src/commands/timezone.ts`
- Modify: `src/commands/index.ts`, `src/interactions/router.ts`
- Test: `src/discord/timezonePicker.test.ts`

**Interfaces:**
- Consumes: `getTimezone`, `setTimezone` from `../db/repos/users.js`.
- Produces:
  - `COMMON_ZONES: { label: string; value: string }[]`
  - `isValidZone(zone: string): boolean`
  - `timezonePrompt(reason: string): InteractionReplyOptions` — the ephemeral picker payload
  - `handleTimezoneSelect(i: StringSelectMenuInteraction, ctx: AppContext): Promise<void>`
  - `handleTimezoneOtherButton(i: ButtonInteraction): Promise<void>`
  - `handleTimezoneModal(i: ModalSubmitInteraction, ctx: AppContext): Promise<void>`
  - `requireTimezone(i: RepliableInteraction, ctx: AppContext): Promise<string | null>` — returns the zone, or replies with the picker and returns `null`
- customIds: `gn:tz`, `gn:tzother`, `gn:tzmodal`

- [ ] **Step 1: Write the failing test**

`src/discord/timezonePicker.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { COMMON_ZONES, isValidZone } from "./timezonePicker.js";

describe("timezone picker", () => {
  it("offers at most 25 zones, Discord's select limit", () => {
    expect(COMMON_ZONES.length).toBeLessThanOrEqual(25);
    expect(COMMON_ZONES.length).toBeGreaterThan(5);
  });

  it("offers only valid IANA zones", () => {
    expect(COMMON_ZONES.every((z) => isValidZone(z.value))).toBe(true);
  });

  it("accepts a valid IANA zone", () => {
    expect(isValidZone("Europe/London")).toBe(true);
  });

  it("rejects an abbreviation, which is ambiguous", () => {
    expect(isValidZone("EST5EDT_not_real")).toBe(false);
  });

  it("rejects nonsense without throwing", () => {
    expect(isValidZone("Mars/Olympus")).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/discord/timezonePicker.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the picker**

`src/discord/timezonePicker.ts`:

```ts
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
  ModalBuilder,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
  type ButtonInteraction,
  type InteractionReplyOptions,
  type ModalSubmitInteraction,
  type RepliableInteraction,
  type StringSelectMenuInteraction,
} from "discord.js";
import { IANAZone } from "luxon";
import type { AppContext } from "../context.js";
import { getTimezone, setTimezone } from "../db/repos/users.js";

export const COMMON_ZONES: { label: string; value: string }[] = [
  { label: "Pacific (Los Angeles)", value: "America/Los_Angeles" },
  { label: "Mountain (Denver)", value: "America/Denver" },
  { label: "Arizona (no DST)", value: "America/Phoenix" },
  { label: "Central (Chicago)", value: "America/Chicago" },
  { label: "Eastern (New York)", value: "America/New_York" },
  { label: "Atlantic (Halifax)", value: "America/Halifax" },
  { label: "Brazil (Sao Paulo)", value: "America/Sao_Paulo" },
  { label: "UK (London)", value: "Europe/London" },
  { label: "Central Europe (Berlin)", value: "Europe/Berlin" },
  { label: "Eastern Europe (Athens)", value: "Europe/Athens" },
  { label: "India (Kolkata)", value: "Asia/Kolkata" },
  { label: "Singapore", value: "Asia/Singapore" },
  { label: "Japan (Tokyo)", value: "Asia/Tokyo" },
  { label: "Sydney", value: "Australia/Sydney" },
  { label: "New Zealand (Auckland)", value: "Pacific/Auckland" },
];

export function isValidZone(zone: string): boolean {
  return IANAZone.isValidZone(zone);
}

export function timezonePrompt(reason: string): InteractionReplyOptions {
  return {
    content: `${reason}\n\nPick the closest one, or use **Other** for any IANA zone name.`,
    flags: MessageFlags.Ephemeral,
    components: [
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId("gn:tz")
          .setPlaceholder("Your timezone")
          .addOptions(COMMON_ZONES),
      ),
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId("gn:tzother")
          .setLabel("Other")
          .setStyle(ButtonStyle.Secondary),
      ),
    ],
  };
}

/**
 * Returns the caller's timezone, or replies with the picker and returns null.
 * Callers MUST stop when this returns null — a reply has already been sent.
 */
export async function requireTimezone(
  interaction: RepliableInteraction,
  ctx: AppContext,
): Promise<string | null> {
  const zone = getTimezone(ctx.db, interaction.user.id);
  if (zone) return zone;
  await interaction.reply(
    timezonePrompt("I need your timezone first — I only ask once."),
  );
  return null;
}

async function confirm(
  interaction: StringSelectMenuInteraction | ModalSubmitInteraction,
  zone: string,
): Promise<void> {
  const payload = {
    content: `Timezone set to **${zone}**. Click the button on the poll again and your hours will be in your local time.`,
    components: [],
  };
  if (interaction.isModalSubmit()) {
    await interaction.reply({ ...payload, flags: MessageFlags.Ephemeral });
  } else {
    await interaction.update(payload);
  }
}

export async function handleTimezoneSelect(
  interaction: StringSelectMenuInteraction,
  ctx: AppContext,
): Promise<void> {
  const zone = interaction.values[0];
  setTimezone(ctx.db, interaction.user.id, zone);
  await confirm(interaction, zone);
}

export async function handleTimezoneOtherButton(
  interaction: ButtonInteraction,
): Promise<void> {
  await interaction.showModal(
    new ModalBuilder()
      .setCustomId("gn:tzmodal")
      .setTitle("Set your timezone")
      .addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder()
            .setCustomId("zone")
            .setLabel("IANA timezone name")
            .setPlaceholder("Europe/Lisbon")
            .setStyle(TextInputStyle.Short)
            .setRequired(true),
        ),
      ),
  );
}

export async function handleTimezoneModal(
  interaction: ModalSubmitInteraction,
  ctx: AppContext,
): Promise<void> {
  const zone = interaction.fields.getTextInputValue("zone").trim();
  if (!isValidZone(zone)) {
    await interaction.reply({
      content: `**${zone}** is not an IANA timezone name. They look like \`Europe/Lisbon\` or \`America/Chicago\` — the full list is on Wikipedia under "List of tz database time zones".`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  setTimezone(ctx.db, interaction.user.id, zone);
  await confirm(interaction, zone);
}
```

`src/commands/timezone.ts`:

```ts
import { SlashCommandBuilder, type ChatInputCommandInteraction } from "discord.js";
import type { AppContext } from "../context.js";
import { getTimezone } from "../db/repos/users.js";
import { timezonePrompt } from "../discord/timezonePicker.js";

export const data = new SlashCommandBuilder()
  .setName("timezone")
  .setDescription("Set the timezone your game night times are shown in");

export async function execute(
  interaction: ChatInputCommandInteraction,
  ctx: AppContext,
): Promise<void> {
  const current = getTimezone(ctx.db, interaction.user.id);
  await interaction.reply(
    timezonePrompt(current ? `You are currently set to **${current}**.` : "Pick your timezone."),
  );
}
```

- [ ] **Step 4: Register the command and route the components**

In `src/commands/index.ts`, import `* as timezone from "./timezone.js"` and add it to the `commands` array.

In `src/interactions/router.ts`, add inside the `try` block, after the chat-input branch:

```ts
    if (interaction.isStringSelectMenu()) {
      const { action } = parseCustomId(interaction.customId);
      if (action === "tz") return await handleTimezoneSelect(interaction, ctx);
    }
    if (interaction.isButton()) {
      const { action } = parseCustomId(interaction.customId);
      if (action === "tzother") return await handleTimezoneOtherButton(interaction);
    }
    if (interaction.isModalSubmit()) {
      const { action } = parseCustomId(interaction.customId);
      if (action === "tzmodal") return await handleTimezoneModal(interaction, ctx);
    }
```

with the matching imports from `../discord/timezonePicker.js`.

- [ ] **Step 5: Run the tests and verify in Discord**

Run: `npx vitest run` — expect all suites PASS.
Run: `npm run deploy && npm run dev`.
In Discord: `/timezone`, choose a zone, expect the confirmation. Run it again and expect it to show your current zone. Click **Other**, submit `Mars/Olympus`, expect the explanatory rejection; submit `Europe/Lisbon`, expect success.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: per-user timezone onboarding and /timezone command"
```

---

## Task 6: The game library commands

**Files:**
- Create: `src/commands/games.ts`
- Modify: `src/commands/index.ts`

**Interfaces:**
- Consumes: `addGame`, `findGameByName`, `listGames`, `removeGame` from `../db/repos/games.js`.
- Produces: the `games` slash command with `add`, `list`, and `remove` subcommands. No new exports other than `data` and `execute`.

- [ ] **Step 1: Implement the command**

`src/commands/games.ts`:

```ts
import {
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
} from "discord.js";
import type { AppContext } from "../context.js";
import { addGame, findGameByName, listGames, removeGame } from "../db/repos/games.js";

export const data = new SlashCommandBuilder()
  .setName("games")
  .setDescription("Manage this server's game library")
  .addSubcommand((s) =>
    s
      .setName("add")
      .setDescription("Add a game")
      .addStringOption((o) =>
        o.setName("name").setDescription("Game name").setRequired(true).setMaxLength(80),
      )
      .addIntegerOption((o) =>
        o
          .setName("min")
          .setDescription("Fewest players it works with")
          .setRequired(true)
          .setMinValue(1)
          .setMaxValue(100),
      )
      .addIntegerOption((o) =>
        o
          .setName("max")
          .setDescription("Most players it supports (leave empty for unlimited)")
          .setMinValue(1)
          .setMaxValue(100),
      ),
  )
  .addSubcommand((s) => s.setName("list").setDescription("List the library"))
  .addSubcommand((s) =>
    s
      .setName("remove")
      .setDescription("Remove a game")
      .addStringOption((o) =>
        o.setName("name").setDescription("Game name").setRequired(true),
      ),
  );

export async function execute(
  interaction: ChatInputCommandInteraction,
  ctx: AppContext,
): Promise<void> {
  const guildId = interaction.guildId;
  if (!guildId) {
    await interaction.reply({
      content: "Game nights only work inside a server.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const subcommand = interaction.options.getSubcommand();

  if (subcommand === "add") {
    const name = interaction.options.getString("name", true).trim();
    const min = interaction.options.getInteger("min", true);
    const max = interaction.options.getInteger("max");

    if (max !== null && max < min) {
      await interaction.reply({
        content: `**max** (${max}) cannot be below **min** (${min}).`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    if (findGameByName(ctx.db, guildId, name)) {
      await interaction.reply({
        content: `**${name}** is already in the library.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const game = addGame(ctx.db, guildId, name, min, max, interaction.user.id);
    await interaction.reply({
      content: `Added **${game.name}** (${game.minPlayers}–${game.maxPlayers ?? "∞"} players).`,
    });
    return;
  }

  if (subcommand === "list") {
    const games = listGames(ctx.db, guildId);
    if (games.length === 0) {
      await interaction.reply({
        content: "The library is empty. Add one with `/games add`.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    const lines = games.map(
      (g) => `• **${g.name}** — ${g.minPlayers}–${g.maxPlayers ?? "∞"} players`,
    );
    await interaction.reply({ content: lines.join("\n") });
    return;
  }

  // remove
  const name = interaction.options.getString("name", true);
  const isModerator =
    interaction.memberPermissions?.has(PermissionFlagsBits.ManageEvents) ?? false;
  const removed = removeGame(ctx.db, guildId, name, interaction.user.id, isModerator);
  await interaction.reply({
    content: removed
      ? `Removed **${name}**.`
      : `Could not remove **${name}** — either it is not in the library, or someone else added it and you do not have Manage Events.`,
    flags: MessageFlags.Ephemeral,
  });
}
```

- [ ] **Step 2: Register it**

In `src/commands/index.ts`, import `* as games from "./games.js"` and add it to the `commands` array.

- [ ] **Step 3: Verify in Discord**

Run: `npm run deploy && npm run dev`.
- `/games add name:Deep Rock min:2 max:4` → confirmation.
- `/games add name:deep rock min:2` → "already in the library".
- `/games add name:Bad min:4 max:2` → the max-below-min rejection.
- `/games list` → both entries, alphabetical.
- `/games remove name:Deep Rock` → removed.

Add three or four real games now; the next task needs them.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "feat: /games add, list, and remove"
```

---

## Task 7: Creating a night and rendering the poll

The largest task, and the first with something visible in the channel. It ends with a poll posted that shows an empty grid and no suggestions.

**Files:**
- Create: `src/db/repos/nights.ts`, `src/discord/render.ts`, `src/discord/updateQueue.ts`
- Modify: `src/commands/gamenight.ts`, `src/interactions/router.ts`
- Test: `src/db/repos/nights.test.ts`, `src/discord/render.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 2, 3, and 4.
- Produces:
  - nights repo:
    - `interface NightRow { id: number; guildId: string; channelId: string; messageId: string | null; hostId: string; title: string; displayTz: string; minSessionHours: number; deadlineUtc: number; status: NightStatus; voiceChannelId: string | null; lockedStartUtc: number | null; lockedEndUtc: number | null; lockedGameId: number | null; eventId: string | null }`
    - `type NightStatus = "draft" | "open" | "locked" | "failed" | "cancelled"`
    - `createDraftNight(db, input): number`, `getNight(db, id): NightRow | null`, `getOpenNightForChannel(db, channelId): NightRow | null`
    - `setNightGames(db, nightId, gameIds): void`, `getNightGameIds(db, nightId): number[]`
    - `getNightDays(db, nightId): NightDay[]`
    - `publishNight(db, nightId, messageId): void`
    - `getAvailability(db, nightId): Map<string, Set<number>>`, `setAvailabilityForDay(db, nightId, userId, dayHours, chosen): void`
    - `getVotes(db, nightId): Map<string, Set<number>>`, `setVotes(db, nightId, userId, gameIds): void`
    - `getAttendance(db, nightId): Map<string, "in" | "out">`, `setAttendance(db, nightId, userId, status): void`
    - `clearUserResponses(db, nightId, userId): void`
    - `getResponderIds(db, nightId): Set<string>`
    - `dueNights(db, nowUtc): NightRow[]`, `deleteStaleDrafts(db, olderThanUtc): void`
    - `lockNight(db, nightId, startUtc, endUtc, gameId, eventId): void`, `failNight(db, nightId): void`, `cancelNight(db, nightId): void`
  - render: `interface PollView { ... }` and `renderPoll(view: PollView): { embeds: EmbedBuilder[]; components: ActionRowBuilder<ButtonBuilder>[] }`
  - updateQueue: `queueRender(client, db, nightId): void`, `renderNightNow(client, db, nightId): Promise<void>`
- customIds: `gn:setup:<nightId>` (game select), `gn:setupadd:<nightId>`, `gn:post:<nightId>`, `gn:avail:<nightId>`, `gn:votes:<nightId>`, `gn:suggest:<nightId>`, `gn:out:<nightId>`

- [ ] **Step 1: Write the failing nights-repo test**

`src/db/repos/nights.test.ts`:

```ts
import { beforeEach, describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { openDatabase } from "../index.js";
import { addGame } from "./games.js";
import {
  clearUserResponses,
  createDraftNight,
  dueNights,
  deleteStaleDrafts,
  getAvailability,
  getNight,
  getNightDays,
  getNightGameIds,
  getOpenNightForChannel,
  getResponderIds,
  getVotes,
  lockNight,
  publishNight,
  setAttendance,
  setAvailabilityForDay,
  setNightGames,
  setVotes,
} from "./nights.js";

let db: DatabaseSync;
const DAYS = [
  { dayIndex: 0, startUtc: 1_000_000 * 3600, endUtc: 1_000_005 * 3600 },
  { dayIndex: 1, startUtc: 1_000_024 * 3600, endUtc: 1_000_029 * 3600 },
];

function makeDraft(): number {
  return createDraftNight(db, {
    guildId: "g1",
    channelId: "c1",
    hostId: "u1",
    title: "Game Night",
    displayTz: "America/Chicago",
    minSessionHours: 2,
    deadlineUtc: 1_000_000 * 3600 - 3600,
    voiceChannelId: null,
    days: DAYS,
    createdUtc: 1_000_000 * 3600 - 7200,
  });
}

beforeEach(() => {
  db = openDatabase(":memory:");
});

describe("nights repository", () => {
  it("creates a draft that is not yet the channel's open night", () => {
    const id = makeDraft();
    expect(getNight(db, id)?.status).toBe("draft");
    expect(getOpenNightForChannel(db, "c1")).toBeNull();
  });

  it("stores the days", () => {
    const id = makeDraft();
    expect(getNightDays(db, id)).toEqual(DAYS);
  });

  it("publishing makes it the channel's open night", () => {
    const id = makeDraft();
    publishNight(db, id, "m1");
    const night = getOpenNightForChannel(db, "c1");
    expect(night?.id).toBe(id);
    expect(night?.messageId).toBe("m1");
  });

  it("replaces the game set rather than appending", () => {
    const id = makeDraft();
    const a = addGame(db, "g1", "A", 1, null, "u1");
    const b = addGame(db, "g1", "B", 1, null, "u1");
    setNightGames(db, id, [a.id, b.id]);
    setNightGames(db, id, [b.id]);
    expect(getNightGameIds(db, id)).toEqual([b.id]);
  });

  it("records availability for one day without touching another", () => {
    const id = makeDraft();
    const day0 = [DAYS[0].startUtc, DAYS[0].startUtc + 3600];
    const day1 = [DAYS[1].startUtc, DAYS[1].startUtc + 3600];
    setAvailabilityForDay(db, id, "u1", day0, day0);
    setAvailabilityForDay(db, id, "u1", day1, [DAYS[1].startUtc]);
    setAvailabilityForDay(db, id, "u1", day0, [DAYS[0].startUtc]);
    expect([...getAvailability(db, id).get("u1")!].sort()).toEqual(
      [DAYS[0].startUtc, DAYS[1].startUtc].sort(),
    );
  });

  it("clearing a day's selection removes only that day", () => {
    const id = makeDraft();
    const day0 = [DAYS[0].startUtc];
    const day1 = [DAYS[1].startUtc];
    setAvailabilityForDay(db, id, "u1", day0, day0);
    setAvailabilityForDay(db, id, "u1", day1, day1);
    setAvailabilityForDay(db, id, "u1", day0, []);
    expect([...getAvailability(db, id).get("u1")!]).toEqual(day1);
  });

  it("replaces votes wholesale", () => {
    const id = makeDraft();
    const a = addGame(db, "g1", "A", 1, null, "u1");
    const b = addGame(db, "g1", "B", 1, null, "u1");
    setVotes(db, id, "u1", [a.id, b.id]);
    setVotes(db, id, "u1", [a.id]);
    expect([...getVotes(db, id).get("u1")!]).toEqual([a.id]);
  });

  it("counts availability, votes, or attendance as having responded", () => {
    const id = makeDraft();
    const game = addGame(db, "g1", "A", 1, null, "u1");
    setAvailabilityForDay(db, id, "avail", [DAYS[0].startUtc], [DAYS[0].startUtc]);
    setVotes(db, id, "voter", [game.id]);
    setAttendance(db, id, "opted", "out");
    expect(getResponderIds(db, id)).toEqual(new Set(["avail", "voter", "opted"]));
  });

  it("does not count an empty availability submission as a response", () => {
    const id = makeDraft();
    setAvailabilityForDay(db, id, "u1", [DAYS[0].startUtc], []);
    expect(getResponderIds(db, id).has("u1")).toBe(false);
  });

  it("clears every trace of a user's response", () => {
    const id = makeDraft();
    const game = addGame(db, "g1", "A", 1, null, "u1");
    setAvailabilityForDay(db, id, "u1", [DAYS[0].startUtc], [DAYS[0].startUtc]);
    setVotes(db, id, "u1", [game.id]);
    clearUserResponses(db, id, "u1");
    expect(getAvailability(db, id).has("u1")).toBe(false);
    expect(getVotes(db, id).has("u1")).toBe(false);
  });

  it("returns only open nights past their deadline", () => {
    const id = makeDraft();
    publishNight(db, id, "m1");
    const deadline = getNight(db, id)!.deadlineUtc;
    expect(dueNights(db, deadline - 1)).toEqual([]);
    expect(dueNights(db, deadline).map((n) => n.id)).toEqual([id]);
  });

  it("stops returning a night once it is locked", () => {
    const id = makeDraft();
    publishNight(db, id, "m1");
    const game = addGame(db, "g1", "A", 1, null, "u1");
    lockNight(db, id, DAYS[0].startUtc, DAYS[0].endUtc, game.id, "e1");
    expect(dueNights(db, DAYS[0].endUtc)).toEqual([]);
    expect(getNight(db, id)?.status).toBe("locked");
    expect(getNight(db, id)?.eventId).toBe("e1");
  });

  it("deletes stale drafts and nothing else", () => {
    const draft = makeDraft();
    const published = makeDraft();
    publishNight(db, published, "m1");
    deleteStaleDrafts(db, 1_000_000 * 3600);
    expect(getNight(db, draft)).toBeNull();
    expect(getNight(db, published)).not.toBeNull();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/db/repos/nights.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the nights repository**

`src/db/repos/nights.ts`:

```ts
import type { DatabaseSync } from "node:sqlite";
import type { NightDay } from "../../domain/timeblocks.js";

export type NightStatus = "draft" | "open" | "locked" | "failed" | "cancelled";

export interface NightRow {
  id: number;
  guildId: string;
  channelId: string;
  messageId: string | null;
  hostId: string;
  title: string;
  displayTz: string;
  minSessionHours: number;
  deadlineUtc: number;
  status: NightStatus;
  voiceChannelId: string | null;
  lockedStartUtc: number | null;
  lockedEndUtc: number | null;
  lockedGameId: number | null;
  eventId: string | null;
}

export interface CreateNightInput {
  guildId: string;
  channelId: string;
  hostId: string;
  title: string;
  displayTz: string;
  minSessionHours: number;
  deadlineUtc: number;
  voiceChannelId: string | null;
  days: NightDay[];
  createdUtc: number;
}

interface NightDbRow {
  id: number;
  guild_id: string;
  channel_id: string;
  message_id: string | null;
  host_id: string;
  title: string;
  display_tz: string;
  min_session_hours: number;
  deadline_utc: number;
  status: NightStatus;
  voice_channel_id: string | null;
  locked_start_utc: number | null;
  locked_end_utc: number | null;
  locked_game_id: number | null;
  event_id: string | null;
}

const toNight = (r: NightDbRow): NightRow => ({
  id: r.id,
  guildId: r.guild_id,
  channelId: r.channel_id,
  messageId: r.message_id,
  hostId: r.host_id,
  title: r.title,
  displayTz: r.display_tz,
  minSessionHours: r.min_session_hours,
  deadlineUtc: r.deadline_utc,
  status: r.status,
  voiceChannelId: r.voice_channel_id,
  lockedStartUtc: r.locked_start_utc,
  lockedEndUtc: r.locked_end_utc,
  lockedGameId: r.locked_game_id,
  eventId: r.event_id,
});

const NIGHT_COLUMNS = `SELECT id, guild_id, channel_id, message_id, host_id, title,
  display_tz, min_session_hours, deadline_utc, status, voice_channel_id,
  locked_start_utc, locked_end_utc, locked_game_id, event_id FROM nights`;

export function createDraftNight(db: DatabaseSync, input: CreateNightInput): number {
  const result = db
    .prepare(
      `INSERT INTO nights (guild_id, channel_id, host_id, title, display_tz,
        min_session_hours, deadline_utc, status, voice_channel_id, created_utc)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?)`,
    )
    .run(
      input.guildId,
      input.channelId,
      input.hostId,
      input.title,
      input.displayTz,
      input.minSessionHours,
      input.deadlineUtc,
      input.voiceChannelId,
      input.createdUtc,
    );
  const nightId = Number(result.lastInsertRowid);
  const insertDay = db.prepare(
    `INSERT INTO night_days (night_id, day_index, window_start_utc, window_end_utc)
     VALUES (?, ?, ?, ?)`,
  );
  for (const day of input.days) {
    insertDay.run(nightId, day.dayIndex, day.startUtc, day.endUtc);
  }
  return nightId;
}

export function getNight(db: DatabaseSync, id: number): NightRow | null {
  const row = db.prepare(`${NIGHT_COLUMNS} WHERE id = ?`).get(id) as
    | NightDbRow
    | undefined;
  return row ? toNight(row) : null;
}

export function getOpenNightForChannel(
  db: DatabaseSync,
  channelId: string,
): NightRow | null {
  const row = db
    .prepare(`${NIGHT_COLUMNS} WHERE channel_id = ? AND status = 'open'`)
    .get(channelId) as NightDbRow | undefined;
  return row ? toNight(row) : null;
}

export function getNightDays(db: DatabaseSync, nightId: number): NightDay[] {
  const rows = db
    .prepare(
      `SELECT day_index, window_start_utc, window_end_utc FROM night_days
       WHERE night_id = ? ORDER BY day_index`,
    )
    .all(nightId) as {
    day_index: number;
    window_start_utc: number;
    window_end_utc: number;
  }[];
  return rows.map((r) => ({
    dayIndex: r.day_index,
    startUtc: r.window_start_utc,
    endUtc: r.window_end_utc,
  }));
}

export function setNightGames(
  db: DatabaseSync,
  nightId: number,
  gameIds: number[],
): void {
  db.prepare("DELETE FROM night_games WHERE night_id = ?").run(nightId);
  const insert = db.prepare(
    "INSERT INTO night_games (night_id, game_id) VALUES (?, ?)",
  );
  for (const gameId of gameIds) insert.run(nightId, gameId);
}

export function getNightGameIds(db: DatabaseSync, nightId: number): number[] {
  const rows = db
    .prepare("SELECT game_id FROM night_games WHERE night_id = ? ORDER BY game_id")
    .all(nightId) as { game_id: number }[];
  return rows.map((r) => r.game_id);
}

export function publishNight(
  db: DatabaseSync,
  nightId: number,
  messageId: string,
): void {
  db.prepare("UPDATE nights SET status = 'open', message_id = ? WHERE id = ?").run(
    messageId,
    nightId,
  );
}

export function getAvailability(
  db: DatabaseSync,
  nightId: number,
): Map<string, Set<number>> {
  const rows = db
    .prepare("SELECT user_id, utc_hour FROM availability WHERE night_id = ?")
    .all(nightId) as { user_id: string; utc_hour: number }[];
  const map = new Map<string, Set<number>>();
  for (const row of rows) {
    const set = map.get(row.user_id) ?? new Set<number>();
    set.add(row.utc_hour);
    map.set(row.user_id, set);
  }
  return map;
}

/**
 * Replace one day's selection. `dayHours` is every hour that day offers, so the
 * delete stays scoped to that day and other days survive untouched.
 */
export function setAvailabilityForDay(
  db: DatabaseSync,
  nightId: number,
  userId: string,
  dayHours: number[],
  chosen: number[],
): void {
  if (dayHours.length === 0) return;
  const placeholders = dayHours.map(() => "?").join(",");
  db.prepare(
    `DELETE FROM availability
     WHERE night_id = ? AND user_id = ? AND utc_hour IN (${placeholders})`,
  ).run(nightId, userId, ...dayHours);
  const insert = db.prepare(
    "INSERT INTO availability (night_id, user_id, utc_hour) VALUES (?, ?, ?)",
  );
  for (const hour of chosen) insert.run(nightId, userId, hour);
}

export function getVotes(db: DatabaseSync, nightId: number): Map<string, Set<number>> {
  const rows = db
    .prepare("SELECT user_id, game_id FROM game_votes WHERE night_id = ?")
    .all(nightId) as { user_id: string; game_id: number }[];
  const map = new Map<string, Set<number>>();
  for (const row of rows) {
    const set = map.get(row.user_id) ?? new Set<number>();
    set.add(row.game_id);
    map.set(row.user_id, set);
  }
  return map;
}

export function setVotes(
  db: DatabaseSync,
  nightId: number,
  userId: string,
  gameIds: number[],
): void {
  db.prepare("DELETE FROM game_votes WHERE night_id = ? AND user_id = ?").run(
    nightId,
    userId,
  );
  const insert = db.prepare(
    "INSERT INTO game_votes (night_id, user_id, game_id) VALUES (?, ?, ?)",
  );
  for (const gameId of gameIds) insert.run(nightId, userId, gameId);
}

export function getAttendance(
  db: DatabaseSync,
  nightId: number,
): Map<string, "in" | "out"> {
  const rows = db
    .prepare("SELECT user_id, status FROM attendance WHERE night_id = ?")
    .all(nightId) as { user_id: string; status: "in" | "out" }[];
  return new Map(rows.map((r) => [r.user_id, r.status]));
}

export function setAttendance(
  db: DatabaseSync,
  nightId: number,
  userId: string,
  status: "in" | "out",
): void {
  db.prepare(
    `INSERT INTO attendance (night_id, user_id, status) VALUES (?, ?, ?)
     ON CONFLICT(night_id, user_id) DO UPDATE SET status = excluded.status`,
  ).run(nightId, userId, status);
}

export function clearUserResponses(
  db: DatabaseSync,
  nightId: number,
  userId: string,
): void {
  db.prepare("DELETE FROM availability WHERE night_id = ? AND user_id = ?").run(
    nightId,
    userId,
  );
  db.prepare("DELETE FROM game_votes WHERE night_id = ? AND user_id = ?").run(
    nightId,
    userId,
  );
}

export function getResponderIds(db: DatabaseSync, nightId: number): Set<string> {
  const rows = db
    .prepare(
      `SELECT user_id FROM availability WHERE night_id = ?
       UNION SELECT user_id FROM game_votes WHERE night_id = ?
       UNION SELECT user_id FROM attendance WHERE night_id = ?`,
    )
    .all(nightId, nightId, nightId) as { user_id: string }[];
  return new Set(rows.map((r) => r.user_id));
}

export function dueNights(db: DatabaseSync, nowUtc: number): NightRow[] {
  const rows = db
    .prepare(`${NIGHT_COLUMNS} WHERE status = 'open' AND deadline_utc <= ?`)
    .all(nowUtc) as NightDbRow[];
  return rows.map(toNight);
}

export function deleteStaleDrafts(db: DatabaseSync, olderThanUtc: number): void {
  db.prepare("DELETE FROM nights WHERE status = 'draft' AND created_utc < ?").run(
    olderThanUtc,
  );
}

export function lockNight(
  db: DatabaseSync,
  nightId: number,
  startUtc: number,
  endUtc: number,
  gameId: number,
  eventId: string | null,
): void {
  db.prepare(
    `UPDATE nights SET status = 'locked', locked_start_utc = ?, locked_end_utc = ?,
      locked_game_id = ?, event_id = ? WHERE id = ?`,
  ).run(startUtc, endUtc, gameId, eventId, nightId);
}

export function failNight(db: DatabaseSync, nightId: number): void {
  db.prepare("UPDATE nights SET status = 'failed' WHERE id = ?").run(nightId);
}

export function cancelNight(db: DatabaseSync, nightId: number): void {
  db.prepare("UPDATE nights SET status = 'cancelled' WHERE id = ?").run(nightId);
}
```

- [ ] **Step 4: Run the repository tests**

Run: `npx vitest run src/db/repos/nights.test.ts`
Expected: PASS, 13 tests.

- [ ] **Step 5: Write the failing render test**

`src/discord/render.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { renderPoll, type PollView } from "./render.js";
import { expandDays } from "../domain/timeblocks.js";
import { rankNight } from "../domain/scheduling.js";
import type { Game } from "../domain/scheduling.js";

const CHI = "America/Chicago";
const lethal: Game = { id: 2, name: "Lethal Company", minPlayers: 2, maxPlayers: 4 };
const days = expandDays(["2026-08-28"], { startHour: 18, endHour: 23 }, CHI);

function view(over: Partial<PollView> = {}): PollView {
  const availability = over.availability ?? new Map<string, Set<number>>();
  const votes = over.votes ?? new Map<string, Set<number>>();
  const games = over.games ?? [lethal];
  return {
    title: "Game Night",
    status: "open",
    displayTz: CHI,
    deadlineUtc: 1_800_000_000,
    days,
    games,
    availability,
    votes,
    responderIds: new Set(availability.keys()),
    pendingIds: [],
    result: rankNight({ days, minSessionHours: 2, games, availability, votes }),
    locked: null,
    ...over,
  };
}

describe("renderPoll", () => {
  it("names the display timezone so the grid is unambiguous", () => {
    const embed = renderPoll(view()).embeds[0].toJSON();
    expect(JSON.stringify(embed)).toContain(CHI);
  });

  it("renders a grid row per day with hour labels", () => {
    const embed = renderPoll(view()).embeds[0].toJSON();
    const text = JSON.stringify(embed);
    expect(text).toContain("Fri Aug 28");
    expect(text).toContain("6p");
  });

  it("uses a dynamic timestamp for the deadline so each viewer sees local time", () => {
    const embed = renderPoll(view()).embeds[0].toJSON();
    expect(JSON.stringify(embed)).toContain("<t:1800000000:R>");
  });

  it("says nobody has answered yet when the poll is empty", () => {
    const embed = renderPoll(view()).embeds[0].toJSON();
    expect(JSON.stringify(embed)).toMatch(/no (responses|answers) yet/i);
  });

  it("lists suggestions with dynamic timestamps and the roster", () => {
    const hours = [days[0].startUtc, days[0].startUtc + 3600];
    const availability = new Map([
      ["a", new Set(hours)],
      ["b", new Set(hours)],
    ]);
    const votes = new Map([
      ["a", new Set([2])],
      ["b", new Set([2])],
    ]);
    const embed = renderPoll(view({ availability, votes })).embeds[0].toJSON();
    const text = JSON.stringify(embed);
    expect(text).toContain("Lethal Company");
    expect(text).toContain("<@a>");
    expect(text).toContain(`<t:${days[0].startUtc}:t>`);
  });

  it("flags an oversubscribed roster", () => {
    const hours = [days[0].startUtc, days[0].startUtc + 3600];
    const users = ["a", "b", "c", "d", "e"];
    const availability = new Map(users.map((u) => [u, new Set(hours)]));
    const votes = new Map(users.map((u) => [u, new Set([2])]));
    const text = JSON.stringify(renderPoll(view({ availability, votes })).embeds[0].toJSON());
    expect(text).toMatch(/plays 4/);
  });

  it("lists who has not responded", () => {
    const text = JSON.stringify(
      renderPoll(view({ pendingIds: ["taylor"] })).embeds[0].toJSON(),
    );
    expect(text).toContain("<@taylor>");
  });

  it("offers the four response buttons while open", () => {
    const [row] = renderPoll(view()).components;
    const ids = row.toJSON().components.map((c) => (c as { custom_id: string }).custom_id);
    expect(ids).toEqual([
      "gn:avail:7",
      "gn:votes:7",
      "gn:suggest:7",
      "gn:out:7",
    ]);
  });

  it("swaps to in/out buttons once locked", () => {
    const locked = {
      startUtc: days[0].startUtc,
      endUtc: days[0].startUtc + 3 * 3600,
      game: lethal,
      roster: ["a", "b"],
    };
    const rendered = renderPoll(view({ status: "locked", locked }));
    const ids = rendered.components[0]
      .toJSON()
      .components.map((c) => (c as { custom_id: string }).custom_id);
    expect(ids).toEqual(["gn:in:7", "gn:out:7"]);
    expect(JSON.stringify(rendered.embeds[0].toJSON())).toMatch(/locked/i);
  });

  it("explains the near misses when nothing was viable", () => {
    const hours = [days[0].startUtc, days[0].startUtc + 3600];
    const availability = new Map([["a", new Set(hours)]]);
    const votes = new Map([["a", new Set([2])]]);
    const result = rankNight({
      days,
      minSessionHours: 2,
      games: [lethal],
      availability,
      votes,
    });
    const text = JSON.stringify(
      renderPoll(view({ status: "failed", availability, votes, result })).embeds[0].toJSON(),
    );
    expect(text).toMatch(/needs 2/);
  });

  it("shows no buttons at all on a failed night", () => {
    expect(renderPoll(view({ status: "failed" })).components).toEqual([]);
  });
});
```

Note the tests assume `nightId: 7`; add `nightId: 7` to the `view()` factory and to `PollView`.

- [ ] **Step 6: Implement the renderer**

`src/discord/render.ts`:

```ts
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
} from "discord.js";
import type { Game, SchedulingResult } from "../domain/scheduling.js";
import {
  formatDayLabel,
  formatHourLabel,
  hoursIn,
  type NightDay,
} from "../domain/timeblocks.js";

export interface LockedDetails {
  startUtc: number;
  endUtc: number;
  game: Game;
  roster: string[];
}

export interface PollView {
  nightId: number;
  title: string;
  status: "open" | "locked" | "failed" | "cancelled";
  displayTz: string;
  deadlineUtc: number;
  days: NightDay[];
  games: Game[];
  availability: Map<string, Set<number>>;
  votes: Map<string, Set<number>>;
  responderIds: Set<string>;
  pendingIds: string[];
  result: SchedulingResult;
  locked: LockedDetails | null;
}

const mention = (id: string) => `<@${id}>`;
/** Discord renders these in each viewer's own local time. */
const clock = (utc: number) => `<t:${utc}:t>`;

function countsFor(day: NightDay, availability: Map<string, Set<number>>): number[] {
  return hoursIn(day).map((hour) => {
    let count = 0;
    for (const hours of availability.values()) if (hours.has(hour)) count += 1;
    return count;
  });
}

function grid(view: PollView): string {
  const lines: string[] = [];
  for (const day of view.days) {
    const hours = hoursIn(day);
    const labels = hours.map((h) => formatHourLabel(h, view.displayTz));
    const counts = countsFor(day, view.availability).map((c) => (c === 0 ? "·" : String(c)));
    const width = labels.map((label, i) => Math.max(label.length, counts[i].length));
    const pad = (cells: string[]) =>
      cells.map((cell, i) => cell.padStart(width[i])).join(" ");
    lines.push(`${formatDayLabel(day, view.displayTz).padEnd(12)} ${pad(labels)}`);
    lines.push(`${" ".repeat(12)} ${pad(counts)}`);
  }
  return `\`\`\`\n${lines.join("\n")}\n\`\`\``;
}

function gameLine(view: PollView): string {
  if (view.games.length === 0) return "_No games yet._";
  return view.games
    .map((game) => {
      let count = 0;
      for (const chosen of view.votes.values()) if (chosen.has(game.id)) count += 1;
      return `${game.name} (${count})`;
    })
    .join(" · ");
}

function suggestionLines(view: PollView): string {
  if (view.result.top.length > 0) {
    return view.result.top
      .map((s, index) => {
        const flag = s.oversubscribed
          ? ` — ${s.roster.length} in, plays ${s.game.maxPlayers}, split lobbies?`
          : "";
        return [
          `**${index + 1}. ${clock(s.startUtc)}–${clock(s.endUtc)} · ${s.game.name}** · ${s.roster.length} players${flag}`,
          s.roster.map(mention).join(" "),
        ].join("\n");
      })
      .join("\n\n");
  }
  if (view.result.nearMisses.length > 0) {
    return view.result.nearMisses
      .map(
        (m) =>
          `${clock(m.startUtc)}–${clock(m.endUtc)} · **${m.game.name}** had ${m.rosterSize}; needs ${m.game.minPlayers}.`,
      )
      .join("\n");
  }
  return "_Nothing yet — no responses yet._";
}

export function renderPoll(view: PollView): {
  embeds: EmbedBuilder[];
  components: ActionRowBuilder<ButtonBuilder>[];
} {
  const embed = new EmbedBuilder()
    .setTitle(`🎲 ${view.title}`)
    .setFooter({ text: `Grid shown in ${view.displayTz}` });

  if (view.status === "locked" && view.locked) {
    embed
      .setColor(0x2ecc71)
      .setDescription(
        `**Locked in.** ${clock(view.locked.startUtc)}–${clock(view.locked.endUtc)} · **${view.locked.game.name}**`,
      )
      .addFields({
        name: `Playing (${view.locked.roster.length})`,
        value: view.locked.roster.map(mention).join(" ") || "_nobody yet_",
      });
    return {
      embeds: [embed],
      components: [
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder()
            .setCustomId(`gn:in:${view.nightId}`)
            .setLabel("I'm in")
            .setStyle(ButtonStyle.Success),
          new ButtonBuilder()
            .setCustomId(`gn:out:${view.nightId}`)
            .setLabel("I'm out")
            .setStyle(ButtonStyle.Secondary),
        ),
      ],
    };
  }

  if (view.status === "failed" || view.status === "cancelled") {
    embed
      .setColor(0x95a5a6)
      .setDescription(
        view.status === "cancelled"
          ? "**Cancelled** by the host."
          : "**No viable night.** Closest misses:",
      );
    if (view.status === "failed") {
      embed.addFields({ name: "Near misses", value: suggestionLines(view) });
    }
    return { embeds: [embed], components: [] };
  }

  embed
    .setColor(0x5865f2)
    .setDescription(`Deadline <t:${view.deadlineUtc}:R>`)
    .addFields(
      { name: "Availability", value: grid(view) },
      { name: "Games", value: gameLine(view) },
      { name: "Best right now", value: suggestionLines(view) },
      {
        name: `Responded: ${view.responderIds.size}`,
        value:
          view.pendingIds.length > 0
            ? `No response: ${view.pendingIds.map(mention).join(" ")}`
            : "Everyone has answered.",
      },
    );

  return {
    embeds: [embed],
    components: [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(`gn:avail:${view.nightId}`)
          .setLabel("Set availability")
          .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
          .setCustomId(`gn:votes:${view.nightId}`)
          .setLabel("Pick games")
          .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
          .setCustomId(`gn:suggest:${view.nightId}`)
          .setLabel("Suggest a game")
          .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId(`gn:out:${view.nightId}`)
          .setLabel("I'm out")
          .setStyle(ButtonStyle.Secondary),
      ),
    ],
  };
}
```

- [ ] **Step 7: Run the render tests**

Run: `npx vitest run src/discord/render.test.ts`
Expected: PASS, 11 tests.

- [ ] **Step 8: Implement the debounced update queue**

`src/discord/updateQueue.ts`:

```ts
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

  let locked = null;
  if (night.status === "locked" && night.lockedGameId !== null) {
    const [game] = getGamesByIds(db, [night.lockedGameId]);
    const attendance = getAttendance(db, nightId);
    const roster = [...attendance.entries()]
      .filter(([, status]) => status === "in")
      .map(([userId]) => userId);
    locked = {
      startUtc: night.lockedStartUtc!,
      endUtc: night.lockedEndUtc!,
      game,
      roster,
    };
  }

  return {
    nightId,
    title: night.title,
    status: night.status === "draft" ? "open" : night.status,
    displayTz: night.displayTz,
    deadlineUtc: night.deadlineUtc,
    days,
    games,
    availability,
    votes,
    responderIds,
    pendingIds: await pendingMemberIds(client, night.guildId, night.channelId, responderIds),
    result,
    locked,
  };
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
```

- [ ] **Step 9: Implement `/gamenight create`**

Replace the body of `src/commands/gamenight.ts`, keeping the `ping` subcommand:

```ts
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  MessageFlags,
  SlashCommandBuilder,
  StringSelectMenuBuilder,
  type ChatInputCommandInteraction,
} from "discord.js";
import { DateTime } from "luxon";
import type { AppContext } from "../context.js";
import { listGames } from "../db/repos/games.js";
import {
  createDraftNight,
  getOpenNightForChannel,
} from "../db/repos/nights.js";
import {
  TimeParseError,
  expandDays,
  parseDays,
  parseDeadline,
  parseWindow,
} from "../domain/timeblocks.js";
import { requireTimezone } from "../discord/timezonePicker.js";

export const data = new SlashCommandBuilder()
  .setName("gamenight")
  .setDescription("Plan a game night")
  .addSubcommand((s) => s.setName("ping").setDescription("Check the bot is alive"))
  .addSubcommand((s) =>
    s
      .setName("create")
      .setDescription("Start a game night poll")
      .addStringOption((o) =>
        o.setName("days").setDescription("e.g. fri,sat or 2026-08-28").setRequired(true),
      )
      .addStringOption((o) =>
        o.setName("window").setDescription("e.g. 6pm-1am").setRequired(true),
      )
      .addStringOption((o) =>
        o.setName("deadline").setDescription("e.g. thu 9pm or 24h").setRequired(true),
      )
      .addIntegerOption((o) =>
        o
          .setName("minhours")
          .setDescription("Shortest session worth having (default 2)")
          .setMinValue(1)
          .setMaxValue(12),
      )
      .addChannelOption((o) =>
        o
          .setName("voice")
          .setDescription("Voice channel to attach the event to")
          .addChannelTypes(ChannelType.GuildVoice),
      )
      .addStringOption((o) =>
        o.setName("title").setDescription("Title for the post").setMaxLength(80),
      ),
  );

export async function execute(
  interaction: ChatInputCommandInteraction,
  ctx: AppContext,
): Promise<void> {
  if (interaction.options.getSubcommand() === "ping") {
    await interaction.reply({
      content: `Alive. Round trip ${Date.now() - interaction.createdTimestamp}ms.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (!interaction.guildId || !interaction.channelId) {
    await interaction.reply({
      content: "Game nights only work inside a server channel.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const existing = getOpenNightForChannel(ctx.db, interaction.channelId);
  if (existing) {
    await interaction.reply({
      content: `This channel already has an open game night: https://discord.com/channels/${interaction.guildId}/${interaction.channelId}/${existing.messageId}\nFinish or \`/gamenight cancel\` that one first.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const tz = await requireTimezone(interaction, ctx);
  if (!tz) return;

  const now = DateTime.now().setZone(tz);
  let days, window, deadlineUtc;
  try {
    days = parseDays(interaction.options.getString("days", true), tz, now);
    window = parseWindow(interaction.options.getString("window", true));
    deadlineUtc = parseDeadline(interaction.options.getString("deadline", true), tz, now);
  } catch (error) {
    if (error instanceof TimeParseError) {
      await interaction.reply({ content: error.message, flags: MessageFlags.Ephemeral });
      return;
    }
    throw error;
  }

  const expanded = expandDays(days, window, tz);
  if (deadlineUtc >= expanded[0].startUtc) {
    await interaction.reply({
      content: "The deadline has to be before the first day's window starts, or there is no time to decide.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const library = listGames(ctx.db, interaction.guildId);
  if (library.length === 0) {
    await interaction.reply({
      content: "The game library is empty. Add a few with `/games add` first.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const nightId = createDraftNight(ctx.db, {
    guildId: interaction.guildId,
    channelId: interaction.channelId,
    hostId: interaction.user.id,
    title: interaction.options.getString("title") ?? "Game Night",
    displayTz: tz,
    minSessionHours: interaction.options.getInteger("minhours") ?? 2,
    deadlineUtc,
    voiceChannelId: interaction.options.getChannel("voice")?.id ?? null,
    days: expanded,
    createdUtc: now.toUnixInteger(),
  });

  await interaction.reply({
    content: "Pick the games for this night, then post it.",
    flags: MessageFlags.Ephemeral,
    components: [
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(`gn:setup:${nightId}`)
          .setPlaceholder("Games")
          .setMinValues(0)
          .setMaxValues(Math.min(library.length, 25))
          .addOptions(
            library.slice(0, 25).map((g) => ({
              label: g.name.slice(0, 100),
              description: `${g.minPlayers}–${g.maxPlayers ?? "∞"} players`,
              value: String(g.id),
            })),
          ),
      ),
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(`gn:setupadd:${nightId}`)
          .setLabel("Add a game")
          .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId(`gn:post:${nightId}`)
          .setLabel("Post it")
          .setStyle(ButtonStyle.Success),
      ),
    ],
  });
}
```

- [ ] **Step 10: Handle the setup components**

Create `src/interactions/setup.ts`:

```ts
import { MessageFlags, type ButtonInteraction, type StringSelectMenuInteraction } from "discord.js";
import type { AppContext } from "../context.js";
import { getNight, getNightGameIds, publishNight, setNightGames } from "../db/repos/nights.js";
import { buildPollView } from "../discord/updateQueue.js";
import { renderPoll } from "../discord/render.js";

export async function handleSetupSelect(
  interaction: StringSelectMenuInteraction,
  ctx: AppContext,
  nightId: number,
): Promise<void> {
  setNightGames(ctx.db, nightId, interaction.values.map(Number));
  await interaction.deferUpdate();
}

export async function handlePostButton(
  interaction: ButtonInteraction,
  ctx: AppContext,
  nightId: number,
): Promise<void> {
  const night = getNight(ctx.db, nightId);
  if (!night || night.status !== "draft") {
    await interaction.update({ content: "That draft is gone. Run `/gamenight create` again.", components: [] });
    return;
  }
  if (interaction.user.id !== night.hostId) {
    await interaction.reply({ content: "Only the host can post this.", flags: MessageFlags.Ephemeral });
    return;
  }
  if (getNightGameIds(ctx.db, nightId).length === 0) {
    await interaction.reply({
      content: "Pick at least one game — there is nothing to rank otherwise.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const channel = await interaction.client.channels.fetch(night.channelId);
  if (!channel?.isTextBased() || !("send" in channel)) throw new Error("Channel is not sendable");

  const view = await buildPollView(interaction.client, ctx.db, nightId);
  if (!view) throw new Error(`Night ${nightId} vanished`);
  const message = await channel.send(renderPoll(view));
  publishNight(ctx.db, nightId, message.id);

  await interaction.update({ content: "Posted.", components: [] });
}
```

Route `setup`, `setupadd`, and `post` in `src/interactions/router.ts`, reading the night id from `args[0]`. `setupadd` reuses the suggestion modal built in Task 8; until then, have it reply "Use `/games add` for now."

- [ ] **Step 11: Verify end to end in Discord**

Run: `npm run deploy && npm run dev`.
- `/gamenight create days:fri,sat window:6pm-11pm deadline:2h` → the game picker appears.
- Select games, click **Post it** → the poll appears with an empty grid, the games listed, "no responses yet", and four buttons.
- Run `/gamenight create` again in the same channel → refused with a link to the existing poll.
- `/gamenight create days:fri window:6:30pm-11pm deadline:2h` → the whole-hours rejection.
- `/gamenight create days:fri window:6pm-11pm deadline:20d` → the deadline-before-window rejection.

- [ ] **Step 12: Commit**

```bash
git add -A
git commit -m "feat: create a game night and render the live poll"
```

---

## Task 8: Responding — availability, votes, suggestions, opting out

**Files:**
- Create: `src/interactions/respond.ts`
- Modify: `src/interactions/router.ts`, `src/interactions/setup.ts`

**Interfaces:**
- Consumes: the nights and games repositories, `queueRender`, `requireTimezone`, `hoursIn`, `formatDayLabel`, `formatHourLabel`.
- Produces: `handleAvailabilityButton`, `handleDaySelect`, `handleVotesButton`, `handleVotesSelect`, `handleSuggestButton`, `handleSuggestModal`, `handleOutButton`, `handleInButton`.
- customIds: `gn:day:<nightId>:<dayIndex>`, `gn:voteselect:<nightId>`, `gn:suggestmodal:<nightId>`

- [ ] **Step 1: Implement the handlers**

`src/interactions/respond.ts`:

```ts
import {
  ActionRowBuilder,
  MessageFlags,
  ModalBuilder,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
  type ButtonInteraction,
  type ModalSubmitInteraction,
  type StringSelectMenuInteraction,
} from "discord.js";
import type { AppContext } from "../context.js";
import { addGame, findGameByName, getGamesByIds } from "../db/repos/games.js";
import {
  clearUserResponses,
  getAvailability,
  getNight,
  getNightDays,
  getNightGameIds,
  getVotes,
  setAttendance,
  setAvailabilityForDay,
  setNightGames,
  setVotes,
} from "../db/repos/nights.js";
import {
  formatDayLabel,
  formatHourLabel,
  hoursIn,
} from "../domain/timeblocks.js";
import { queueRender } from "../discord/updateQueue.js";
import { requireTimezone } from "../discord/timezonePicker.js";

const EXPIRED = "That poll is closed. Nothing to change.";

function openNightOrNull(ctx: AppContext, nightId: number) {
  const night = getNight(ctx.db, nightId);
  return night && night.status === "open" ? night : null;
}

export async function handleAvailabilityButton(
  interaction: ButtonInteraction,
  ctx: AppContext,
  nightId: number,
): Promise<void> {
  const night = openNightOrNull(ctx, nightId);
  if (!night) {
    await interaction.reply({ content: EXPIRED, flags: MessageFlags.Ephemeral });
    return;
  }
  const tz = await requireTimezone(interaction, ctx);
  if (!tz) return;

  const chosen = getAvailability(ctx.db, nightId).get(interaction.user.id) ?? new Set();
  const rows = getNightDays(ctx.db, nightId).map((day) => {
    const hours = hoursIn(day);
    return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId(`gn:day:${nightId}:${day.dayIndex}`)
        .setPlaceholder(formatDayLabel(day, tz))
        .setMinValues(0)
        .setMaxValues(hours.length)
        .addOptions(
          hours.map((hour) => ({
            label: formatHourLabel(hour, tz),
            value: String(hour),
            default: chosen.has(hour),
          })),
        ),
    );
  });

  await interaction.reply({
    content: `Pick the hours you are free, in **${tz}**. Each change saves as you make it — just dismiss this when you are done.`,
    flags: MessageFlags.Ephemeral,
    components: rows,
  });
}

export async function handleDaySelect(
  interaction: StringSelectMenuInteraction,
  ctx: AppContext,
  nightId: number,
  dayIndex: number,
): Promise<void> {
  const night = openNightOrNull(ctx, nightId);
  if (!night) {
    await interaction.reply({ content: EXPIRED, flags: MessageFlags.Ephemeral });
    return;
  }
  const day = getNightDays(ctx.db, nightId).find((d) => d.dayIndex === dayIndex);
  if (!day) throw new Error(`Night ${nightId} has no day ${dayIndex}`);

  setAvailabilityForDay(
    ctx.db,
    nightId,
    interaction.user.id,
    hoursIn(day),
    interaction.values.map(Number),
  );
  await interaction.deferUpdate();
  queueRender(interaction.client, ctx.db, nightId);
}

export async function handleVotesButton(
  interaction: ButtonInteraction,
  ctx: AppContext,
  nightId: number,
): Promise<void> {
  const night = openNightOrNull(ctx, nightId);
  if (!night) {
    await interaction.reply({ content: EXPIRED, flags: MessageFlags.Ephemeral });
    return;
  }
  const games = getGamesByIds(ctx.db, getNightGameIds(ctx.db, nightId));
  const chosen = getVotes(ctx.db, nightId).get(interaction.user.id) ?? new Set();

  await interaction.reply({
    content: "Which of these would you play? Saves as you pick.",
    flags: MessageFlags.Ephemeral,
    components: [
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(`gn:voteselect:${nightId}`)
          .setPlaceholder("Games you'd play")
          .setMinValues(0)
          .setMaxValues(games.length)
          .addOptions(
            games.map((g) => ({
              label: g.name.slice(0, 100),
              description: `${g.minPlayers}–${g.maxPlayers ?? "∞"} players`,
              value: String(g.id),
              default: chosen.has(g.id),
            })),
          ),
      ),
    ],
  });
}

export async function handleVotesSelect(
  interaction: StringSelectMenuInteraction,
  ctx: AppContext,
  nightId: number,
): Promise<void> {
  setVotes(ctx.db, nightId, interaction.user.id, interaction.values.map(Number));
  await interaction.deferUpdate();
  queueRender(interaction.client, ctx.db, nightId);
}

export async function handleSuggestButton(
  interaction: ButtonInteraction,
  nightId: number,
): Promise<void> {
  await interaction.showModal(
    new ModalBuilder()
      .setCustomId(`gn:suggestmodal:${nightId}`)
      .setTitle("Suggest a game")
      .addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder()
            .setCustomId("name")
            .setLabel("Game name")
            .setStyle(TextInputStyle.Short)
            .setMaxLength(80)
            .setRequired(true),
        ),
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder()
            .setCustomId("min")
            .setLabel("Fewest players it works with")
            .setStyle(TextInputStyle.Short)
            .setPlaceholder("2")
            .setRequired(true),
        ),
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder()
            .setCustomId("max")
            .setLabel("Most players (blank = unlimited)")
            .setStyle(TextInputStyle.Short)
            .setRequired(false),
        ),
      ),
  );
}

export async function handleSuggestModal(
  interaction: ModalSubmitInteraction,
  ctx: AppContext,
  nightId: number,
): Promise<void> {
  const night = getNight(ctx.db, nightId);
  if (!night || (night.status !== "open" && night.status !== "draft")) {
    await interaction.reply({ content: EXPIRED, flags: MessageFlags.Ephemeral });
    return;
  }

  const name = interaction.fields.getTextInputValue("name").trim();
  const minText = interaction.fields.getTextInputValue("min").trim();
  const maxText = interaction.fields.getTextInputValue("max").trim();
  const min = Number(minText);
  const max = maxText === "" ? null : Number(maxText);

  if (!Number.isInteger(min) || min < 1) {
    await interaction.reply({
      content: `"${minText}" is not a whole number of players.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  if (max !== null && (!Number.isInteger(max) || max < min)) {
    await interaction.reply({
      content: `"${maxText}" has to be a whole number no smaller than ${min}, or blank for unlimited.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  // Reuse an existing library entry rather than creating a near-duplicate.
  const game =
    findGameByName(ctx.db, night.guildId, name) ??
    addGame(ctx.db, night.guildId, name, min, max, interaction.user.id);

  const gameIds = getNightGameIds(ctx.db, nightId);
  if (!gameIds.includes(game.id)) {
    if (gameIds.length >= 25) {
      await interaction.reply({
        content: "This night already has 25 games, which is Discord's dropdown limit.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    setNightGames(ctx.db, nightId, [...gameIds, game.id]);
  }

  const votes = getVotes(ctx.db, nightId).get(interaction.user.id) ?? new Set<number>();
  setVotes(ctx.db, nightId, interaction.user.id, [...votes, game.id]);

  await interaction.reply({
    content: `Added **${game.name}** (${game.minPlayers}–${game.maxPlayers ?? "∞"}) and voted you for it.`,
    flags: MessageFlags.Ephemeral,
  });
  queueRender(interaction.client, ctx.db, nightId);
}

export async function handleOutButton(
  interaction: ButtonInteraction,
  ctx: AppContext,
  nightId: number,
): Promise<void> {
  clearUserResponses(ctx.db, nightId, interaction.user.id);
  setAttendance(ctx.db, nightId, interaction.user.id, "out");
  await interaction.reply({
    content: "Marked you out for this one.",
    flags: MessageFlags.Ephemeral,
  });
  queueRender(interaction.client, ctx.db, nightId);
}

export async function handleInButton(
  interaction: ButtonInteraction,
  ctx: AppContext,
  nightId: number,
): Promise<void> {
  setAttendance(ctx.db, nightId, interaction.user.id, "in");
  await interaction.reply({
    content: "You're on the roster.",
    flags: MessageFlags.Ephemeral,
  });
  queueRender(interaction.client, ctx.db, nightId);
}
```

- [ ] **Step 2: Complete the router**

`src/interactions/router.ts` should now dispatch on `action`, parsing `Number(args[0])` as the night id:

| action | interaction type | handler |
|---|---|---|
| `tz` | select | `handleTimezoneSelect` |
| `tzother` | button | `handleTimezoneOtherButton` |
| `tzmodal` | modal | `handleTimezoneModal` |
| `setup` | select | `handleSetupSelect` |
| `setupadd` | button | `handleSuggestButton` |
| `post` | button | `handlePostButton` |
| `avail` | button | `handleAvailabilityButton` |
| `day` | select | `handleDaySelect` (day index is `Number(args[1])`) |
| `votes` | button | `handleVotesButton` |
| `voteselect` | select | `handleVotesSelect` |
| `suggest` | button | `handleSuggestButton` |
| `suggestmodal` | modal | `handleSuggestModal` |
| `out` | button | `handleOutButton` |
| `in` | button | `handleInButton` |

- [ ] **Step 3: Verify in Discord with a second account or a friend**

- Click **Set availability** → one dropdown per day, hours in your zone, previous picks pre-selected when you reopen it.
- Pick hours → the poll grid updates within about two seconds, and one edit rather than several.
- Click **Pick games**, select two → counts update.
- Have a second person do the same with overlapping hours → a suggestion appears with both names.
- Click **Suggest a game**, add one with min 2 → it appears in the games line with a vote of 1.
- Submit min `abc` → the whole-number rejection.
- Click **I'm out** → you disappear from the grid counts and from "no response".

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "feat: availability, votes, game suggestions, and opting out"
```

---

## Task 9: The deadline sweep, auto-lock, and Scheduled Events

**Files:**
- Create: `src/discord/events.ts`, `src/nights/lock.ts`
- Modify: `src/index.ts`, `src/commands/gamenight.ts` (add `cancel`)

**Interfaces:**
- Consumes: `dueNights`, `deleteStaleDrafts`, `lockNight`, `failNight`, `cancelNight`, `buildPollView`, `renderNightNow`, `rankNight`.
- Produces:
  - `createScheduledEvent(client, night, suggestion): Promise<string | null>`
  - `deleteScheduledEvent(client, guildId, eventId): Promise<void>`
  - `processDueNights(client, db, nowUtc): Promise<void>`
  - `startSweep(client, db): NodeJS.Timeout`

- [ ] **Step 1: Implement Scheduled Event creation**

`src/discord/events.ts`:

```ts
import { GuildScheduledEventEntityType, GuildScheduledEventPrivacyLevel, type Client } from "discord.js";
import type { Suggestion } from "../domain/scheduling.js";
import type { NightRow } from "../db/repos/nights.js";

export async function createScheduledEvent(
  client: Client,
  night: NightRow,
  suggestion: Suggestion,
): Promise<string | null> {
  const guild = await client.guilds.fetch(night.guildId);
  const base = {
    name: `${night.title}: ${suggestion.game.name}`,
    scheduledStartTime: new Date(suggestion.startUtc * 1000),
    scheduledEndTime: new Date(suggestion.endUtc * 1000),
    privacyLevel: GuildScheduledEventPrivacyLevel.GuildOnly,
    description: `Auto-scheduled from the game night poll. ${suggestion.roster.length} players.`,
  };

  try {
    const event = night.voiceChannelId
      ? await guild.scheduledEvents.create({
          ...base,
          entityType: GuildScheduledEventEntityType.Voice,
          channel: night.voiceChannelId,
        })
      : await guild.scheduledEvents.create({
          ...base,
          entityType: GuildScheduledEventEntityType.External,
          // External events require a location and an end time.
          entityMetadata: { location: suggestion.game.name },
        });
    return event.id;
  } catch (error) {
    // A missing Manage Events permission must not lose the decision itself.
    console.error("Could not create scheduled event", { nightId: night.id, error });
    return null;
  }
}

export async function deleteScheduledEvent(
  client: Client,
  guildId: string,
  eventId: string,
): Promise<void> {
  try {
    const guild = await client.guilds.fetch(guildId);
    await guild.scheduledEvents.delete(eventId);
  } catch (error) {
    console.error("Could not delete scheduled event", { eventId, error });
  }
}
```

- [ ] **Step 2: Implement the sweep**

`src/nights/lock.ts`:

```ts
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
```

- [ ] **Step 3: Start the sweep on ready**

In `src/index.ts`:

```ts
client.once(Events.ClientReady, (c) => {
  console.log(`Logged in as ${c.user.tag}`);
  startSweep(c, db);
});
```

- [ ] **Step 4: Add `/gamenight cancel`**

Add to the builder in `src/commands/gamenight.ts`:

```ts
  .addSubcommand((s) =>
    s.setName("cancel").setDescription("Cancel this channel's open game night"),
  )
```

and to `execute`, before the `create` branch:

```ts
  if (interaction.options.getSubcommand() === "cancel") {
    const night = getOpenNightForChannel(ctx.db, interaction.channelId!);
    if (!night) {
      await interaction.reply({
        content: "No open game night in this channel.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    const isModerator =
      interaction.memberPermissions?.has(PermissionFlagsBits.ManageEvents) ?? false;
    if (night.hostId !== interaction.user.id && !isModerator) {
      await interaction.reply({
        content: "Only the host or someone with Manage Events can cancel this.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    cancelNight(ctx.db, night.id);
    if (night.eventId) {
      await deleteScheduledEvent(interaction.client, night.guildId, night.eventId);
    }
    await renderNightNow(interaction.client, ctx.db, night.id);
    await interaction.reply({ content: "Cancelled.", flags: MessageFlags.Ephemeral });
    return;
  }
```

with imports for `cancelNight`, `PermissionFlagsBits`, `deleteScheduledEvent`, and `renderNightNow`.

- [ ] **Step 5: Verify the whole flow**

The deadline is the hard part to test by waiting, so drive it directly.

1. Create a night with `deadline:1h`, respond from two accounts so a suggestion exists.
2. In a Node REPL against the database, move the deadline into the past:
   `UPDATE nights SET deadline_utc = 0 WHERE status = 'open';`
3. Within 30 seconds expect: the poll edits to LOCKED with the winning slot and game, a Scheduled Event appears in the server's Events list at the right time, and a message pings exactly the winning roster.
4. Click **I'm out** on the locked post → you leave the roster; **I'm in** puts you back.
5. Repeat with only one respondent and a game needing two → expect "No viable night" and the near-miss line, and no event.
6. Stop the bot, set another night's deadline to the past, start the bot → it locks on the catch-up pass, proving restarts do not drop deadlines.
7. `/gamenight cancel` on an open night → cancelled, and any event is deleted.

- [ ] **Step 6: Run the full suite and commit**

```bash
npx vitest run
npm run build
git add -A
git commit -m "feat: deadline sweep, auto-lock, scheduled events, and cancel"
```

---

## Task 10: Deployment

**Files:**
- Create: `Dockerfile`, `compose.yaml`
- Modify: `README.md`

- [ ] **Step 1: Write the container files**

`Dockerfile`:

```dockerfile
FROM node:26-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build
CMD ["node", "dist/src/index.js"]
```

`compose.yaml`:

```yaml
services:
  gamenight:
    build: .
    restart: unless-stopped
    env_file: .env
    volumes:
      - ./data:/app/data
```

The `data` volume is what makes the database survive a redeploy. Without it, every rebuild starts empty.

- [ ] **Step 2: Document it**

`README.md` covers: the Developer Portal steps from Task 1, copying `.env.example`, `npm install`, `npm run deploy`, `npm run dev`, and `docker compose up -d --build` on the server. Note that `npm run deploy` must be re-run whenever a command's definition changes, and that dropping `DISCORD_DEV_GUILD_ID` switches registration to global.

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "chore: containerize for VPS deployment"
```

---

## Plan Self-Review

**Spec coverage.** Every spec section maps to a task: commands → 6, 7, 9; creation flow → 7; input parsing → 2; the public poll and the timezone rendering rule → 7; responding → 8; locking → 9; the scheduling engine → 3; the data model → 4 and 7; architecture and runtime decisions → 1, 4, 7, 9; error handling → 1 (router wrapper), 7, 8; testing → 2, 3, 4, 7; build order → task order.

**Two spec items deliberately deferred, both visible above:** the game-suggestion button during *setup* (`gn:setupadd`) reuses the Task 8 modal, so Task 7 ships it as a stub pointing at `/games add` and Task 8 completes it. This is called out in Task 7 Step 10 rather than left implicit.

**Known deviation from the spec:** the spec's "no privileged intents" claim was wrong — the "no response" list requires the `GuildMembers` intent, since there is no other way to enumerate members. The spec has been corrected, and Task 1 Step 1 walks through the toggle. Message Content, the intent that actually causes verification friction, remains off.

