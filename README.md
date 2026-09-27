# discord-bots — game night bot

A Discord bot for scheduling game nights. A host picks some upcoming days,
a start time and a length, and a shortlist of games from the server's
library. Players answer with the hours they're actually free and which of
those games they'd play. An hour before the first day, the bot doesn't ask
anyone to decide — it works out the best (time window × game) combination
itself, posts the result, and creates a Discord Scheduled Event for it.

## What it does, in more detail

- `/gamenight create` opens a form where every date and time is picked from
  a dropdown, with no typing: up to five days from the next 25, a start
  time, and how long you could play. A private setup screen follows for
  adjusting games and attaching a voice channel, then **Post it** puts the
  poll in the channel.
- The poll is a single message with buttons. Players click **Set
  availability** to pick the hours they're free (per day, in their own
  timezone), **Pick games** to say which of the shortlisted games they'd
  play, **Suggest a game** to add one that isn't on the shortlist, or **I'm
  out** to opt out entirely. The message re-renders after every response,
  showing a live availability grid, vote counts, and the top-ranked
  time/game combinations so far.
- An hour before the first day starts, the bot picks the best combination
  on its own — the (time window × game) pairing with the largest roster —
  locks the night, creates a Discord Scheduled Event, and pings the roster.
  If nobody who answered was free for two hours in a row with a game
  picked, the night is marked failed instead.
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
   - Under **Privileged Gateway Intents**, leave **Server Members Intent
     OFF**. The poll shows how many people have responded, not who
     hasn't, so the bot never needs the member list. (If you turned it on
     for an older version, it does no harm — switch it off whenever.)
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

No options. Opens a form for a new game night in the channel it's run in.
Only one open night is allowed per channel at a time.

| Field      | Required | How you fill it                                                        |
| ---------- | -------- | ---------------------------------------------------------------------- |
| Title      | no       | Text, up to 80 characters. Defaults to "Game Night".                   |
| Games      | yes      | Pick from the server's library (the first 25 alphabetically).          |
| Days       | yes      | Pick up to 5 of the next 25 days.                                      |
| Start time | yes      | Noon to 11:30pm, in half hours, in your timezone.                      |
| Length     | yes      | 2 to 12 hours, in half hours. A night that runs past midnight just works. |

There's no deadline to set: the bot locks the night one hour before the
first day you picked starts, so that day has to start more than an hour
from now.

After you submit, a private setup screen lets you adjust the games, add one
that isn't in the library yet (**Add a game**), attach a voice channel for
the Scheduled Event, and **Post it**. The poll only becomes visible to the
channel once you click **Post it**.

### `/gamenight cancel`

Cancels the channel's open game night. Usable by the host or by anyone
with the Manage Events permission. Deletes the Scheduled Event if one had
already been created, and marks the poll message cancelled.

### `/gamenight ping`

No options. Replies privately with a round-trip latency check — useful for
confirming the bot is online and responding.

### `/games add`

Adds a game to the server's shared library. Start typing in the optional
`name` option to search Steam, or skip it. Either way, a form opens:

| Field        | Required | Description                                                     |
| ------------ | -------- | --------------------------------------------------------------- |
| Game name    | yes      | Up to 80 characters. Pre-filled if you picked a Steam title.    |
| Most players | no       | The most people it supports. Leave blank for any number.        |
| Link         | no       | A store page or website, starting with `http://` or `https://`. |

The confirmation is only visible to you.

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

1. A host runs `/gamenight create` and picks a title, games, up to five
   days, a start time and a length — all from dropdowns. A private setup
   screen follows.
2. The host adjusts the games if needed (or adds a new one on the spot),
   optionally attaches a voice channel, then clicks **Post it**. The poll
   goes live in the channel as a single message.
3. Every player who wants in clicks **Set availability** and picks the
   hours they're free on each proposed day, shown in their own timezone
   (the bot asks for it once, the first time it's needed, and remembers
   it). They also click **Pick games** to mark which of the shortlisted
   games they'd actually play, or **Suggest a game** to add one that isn't
   listed. Anyone not interested clicks **I'm out**.
4. The poll message updates after every response: an availability grid,
   vote counts per game, and the top few (time window × game) combinations
   ranked by roster size, right on the card.
5. An hour before the first day starts, a background sweep (checked every
   30 seconds) picks the best combination itself — the one with the
   largest roster — creates a Discord Scheduled Event for it, posts the
   result, and pings the roster. If nobody who answered was free for two
   hours in a row with a game picked, the night is marked failed instead.
6. After locking, players can still adjust with **I'm in** / **I'm out**
   on the final card.

## Deployment

On a small VPS with Docker and Docker Compose installed:

```bash
git clone <this repo> && cd discord-bots
cp .env.example .env   # fill it in, as above
mkdir -p data && sudo chown -R 1000:1000 data   # see note below
docker compose up -d --build
docker compose run --rm gamenight node dist/scripts/deploy-commands.js
```

**That last line is not optional.** The container's `CMD` only starts the
bot — nothing in it registers the slash commands — and a Docker-only VPS
has no host Node to run `npm run deploy` with. Skip it and the bot comes
online with no commands at all: it looks connected and does nothing. The
compiled registration script ships inside the image already
(`dist/scripts/deploy-commands.js`), and `docker compose run` hands it the
same `.env` the bot gets, so that one-liner is the containerised equivalent
of `npm run deploy`.

Re-run it after **any change to a command's definition** — its name,
description, or options. See "Two things to remember" below.

The compose file mounts `./data` into the container at `/app/data`. That
bind mount is what makes the SQLite database survive a redeploy — the
container's own filesystem (including `dist/`) is rebuilt from scratch on
every `--build`, but `./data` lives on the host, so `data/gamenight.db`
persists across it. If you ever run without that mount, every rebuild
starts with an empty database.

The container runs as the image's unprivileged `node` user (uid 1000), not
root, so `./data` has to be writable by uid 1000 on the host *before* the
first `up` — the `chown` above does that. Skip it and the first start fails
to open the database with an error that doesn't obviously look like a
permissions problem.

## Two things to remember

- **Command registration only needs to be re-run when a command's
  *definition* changes** — `npm run deploy` locally, or `docker compose run
  --rm gamenight node dist/scripts/deploy-commands.js` on the VPS. A
  definition is its name, description, or options (anything in a
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
