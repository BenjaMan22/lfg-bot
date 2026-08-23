# discord-bots — game night bot

A Discord bot for scheduling game nights. A host proposes some days, an
evening time window, and a shortlist of games from the server's library.
Players answer with the hours they're actually free and which of those
games they'd play. At the deadline, the bot doesn't ask anyone to decide —
it works out the best (time window × game) combination itself, posts the
result, and creates a Discord Scheduled Event for it.

## What it does, in more detail

- `/gamenight create` opens a short private setup flow for the host: pick
  days, an evening window, a deadline, and a shortlist of games from the
  server's library, then post the poll to the channel.
- The poll is a single message with buttons. Players click **Set
  availability** to pick the hours they're free (per day, in their own
  timezone), **Pick games** to say which of the shortlisted games they'd
  play, **Suggest a game** to add one that isn't on the shortlist, or **I'm
  out** to opt out entirely. The message re-renders after every response,
  showing a live availability grid, vote counts, and the top-ranked
  time/game combinations so far.
- At the deadline, the bot picks the best combination on its own — the
  (time window × game) pairing with the largest roster that clears the
  game's minimum player count — locks the night, creates a Discord
  Scheduled Event, and pings the roster. If nothing clears any game's
  minimum, the night is marked failed and the near-misses are shown instead.
- Once locked, players can still adjust with **I'm in** / **I'm out** on
  the final card.

## Discord Developer Portal setup

Do this once, before the bot can run against real Discord.

1. Go to <https://discord.com/developers/applications> and click **New
   Application**. Give it a name — this is what shows up as the bot's
   username.
2. Open the **Bot** tab.
   - Click **Reset Token** and copy the token it shows you. This token is
     a password for the bot account — it goes in `.env` and nowhere else
     (not in chat, not in a screenshot, not committed to git). If it ever
     leaks, come back here and reset it again; the old one stops working
     immediately.
   - Under **Privileged Gateway Intents**, turn **Server Members Intent
     ON**. The bot needs this to list who in the server hasn't responded
     to a poll yet — there's no other way to enumerate members.
   - Leave **Message Content Intent OFF**. The bot never reads message
     text (everything is buttons, dropdowns, and modals), and this is the
     intent Discord scrutinizes most — it's the one that forces a bot into
     extra verification and approval once it's eligible for review.
     Leaving it off avoids that friction entirely, and the bot doesn't
     need it for anything.
3. Open the **OAuth2** tab → **URL Generator**.
   - Under **Scopes**, check both **bot** and **applications.commands**.
     Forgetting `applications.commands` is the single most common reason
     slash commands never show up in a server even though the bot itself
     is online — the bot scope alone is not enough.
   - Under **Bot Permissions**, check **Send Messages**, **Embed Links**,
     and **Manage Events** (needed to create the Scheduled Event when a
     night locks).
   - Copy the generated URL, open it in a browser, and invite the bot to
     your server.
4. Back on the **General Information** tab, copy the **Application ID** —
   this is `DISCORD_APPLICATION_ID`.
5. In Discord itself, enable Developer Mode (User Settings → Advanced →
   Developer Mode), then right-click your server's icon and **Copy Server
   ID** — this is `DISCORD_DEV_GUILD_ID`.

## Running it locally

```bash
cp .env.example .env
# fill in DISCORD_TOKEN, DISCORD_APPLICATION_ID, DISCORD_DEV_GUILD_ID
npm install
npm run deploy   # registers the slash commands with Discord
npm run dev      # starts the bot
```

`.env` needs:

| Variable                 | What it is                                                     |
| ------------------------- | --------------------------------------------------------------- |
| `DISCORD_TOKEN`           | The bot token from the Bot tab.                                 |
| `DISCORD_APPLICATION_ID`  | The Application ID from General Information.                    |
| `DISCORD_DEV_GUILD_ID`    | Your server ID. Optional — see the gotcha below.                |
| `DATABASE_PATH`           | Path to the SQLite file. Defaults to `data/gamenight.db`.       |

## Commands

### `/gamenight create`

Starts the setup flow for a new game night in the channel it's run in.
Only one open night is allowed per channel at a time.

| Option      | Required | Description                                            |
| ----------- | -------- | -------------------------------------------------------- |
| `days`      | yes      | Comma-separated days, e.g. `fri,sat` or `2026-08-28`.    |
| `window`    | yes      | The evening window each day, e.g. `6pm-1am`.             |
| `deadline`  | yes      | When responses close, e.g. `thu 9pm` or `24h`.           |
| `minhours`  | no       | Shortest session worth having, in hours (default 2).     |
| `voice`     | no       | A voice channel to attach the Scheduled Event to.        |
| `title`     | no       | Title for the poll post (up to 80 characters).           |

Example: `/gamenight create days:fri,sat window:6pm-1am deadline:thu 9pm
minhours:3 title:Weekend Game Night`

This replies privately with a game picker and an **Add a game** button
(for anything not already in the library) plus a **Post it** button. The
poll only becomes visible to the channel once the host clicks **Post it**.

### `/gamenight cancel`

Cancels the channel's open game night. Usable by the host or by anyone
with the Manage Events permission. Deletes the Scheduled Event if one had
already been created, and marks the poll message cancelled.

### `/gamenight ping`

No options. Replies privately with a round-trip latency check — useful for
confirming the bot is online and responding.

### `/games add`

Adds a game to the server's shared library.

| Option | Required | Description                                          |
| ------ | -------- | ------------------------------------------------------ |
| `name` | yes      | Game name (up to 80 characters).                       |
| `min`  | yes      | Fewest players it works with.                           |
| `max`  | no       | Most players it supports. Leave empty for unlimited.    |

Example: `/games add name:Codenames min:4 max:8`

### `/games list`

No options. Lists every game currently in the library.

### `/games remove`

| Option | Required | Description                          |
| ------ | -------- | --------------------------------------- |
| `name` | yes      | Exact name of the game to remove.       |

Example: `/games remove name:Codenames`. Anyone can remove a game they
added themselves; removing someone else's entry needs the Manage Events
permission.

### `/timezone`

No options. Shows your currently-set timezone (if any) and a dropdown of
common zones plus an **Other** button for any IANA zone name (e.g.
`Europe/Lisbon`). The bot asks for this automatically the first time you
try to set availability or create a night if it doesn't know your zone
yet — you only need to run this command directly to change it later.

## How a game night actually works, end to end

1. A host runs `/gamenight create` with days, a window, a deadline, and
   optionally a minimum session length, voice channel, and title. The bot
   replies privately with a game picker.
2. The host picks games from the library (or adds a new one on the spot),
   then clicks **Post it**. The poll goes live in the channel as a single
   message.
3. Every player who wants in clicks **Set availability** and picks the
   hours they're free on each proposed day, shown in their own timezone
   (the bot asks for it once, the first time it's needed, and remembers
   it). They also click **Pick games** to mark which of the shortlisted
   games they'd actually play, or **Suggest a game** to add one that isn't
   listed. Anyone not interested clicks **I'm out**.
4. The poll message updates after every response: an availability grid,
   vote counts per game, and the top few (time window × game) combinations
   ranked by roster size, right on the card.
5. At the deadline, a background sweep (checked every 30 seconds) picks
   the best combination itself — the one with the largest roster that
   still clears the game's minimum player count — creates a Discord
   Scheduled Event for it, posts the result, and pings the roster. If
   nothing clears any game's minimum, the night is marked failed and shows
   the closest near-misses instead.
6. After locking, players can still adjust with **I'm in** / **I'm out**
   on the final card.

## Deployment

On a small VPS with Docker and Docker Compose installed:

```bash
git clone <this repo> && cd discord-bots
cp .env.example .env   # fill it in, as above
docker compose up -d --build
```

The compose file mounts `./data` into the container at `/app/data`. That
bind mount is what makes the SQLite database survive a redeploy — the
container's own filesystem (including `dist/`) is rebuilt from scratch on
every `--build`, but `./data` lives on the host, so `data/gamenight.db`
persists across it. If you ever run without that mount, every rebuild
starts with an empty database.

## Two things to remember

- **`npm run deploy` only needs to be re-run when a command's *definition*
  changes** — its name, description, or options (anything in a
  `SlashCommandBuilder` under `src/commands/`). Changes to what a command
  *does* (handler logic) take effect the next time the bot process starts
  — no re-registration needed.
- **Dropping `DISCORD_DEV_GUILD_ID` switches command registration from
  guild-scoped to global.** Guild-scoped registration (with the variable
  set) appears in your server instantly, which is why it's the default for
  local development. Global registration can take up to an hour to
  propagate to every server the bot is in — expect that delay if you
  remove the variable for a production deployment across multiple
  servers.

## Scripts

- `npm run dev` — run the bot with `tsx`, loading `.env`.
- `npm run build` — compile TypeScript to `dist/` (and copy the SQLite
  schema alongside it).
- `npm start` — run the compiled bot from `dist/`.
- `npm run deploy` — register slash commands with Discord.
- `npm test` — run the test suite with Vitest.
