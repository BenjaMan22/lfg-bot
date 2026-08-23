# discord-bots — game night bot

A Discord bot for scheduling game nights.

## Setup

1. Create a Discord application at <https://discord.com/developers/applications>
   (Bot tab: reset token, enable **Server Members Intent**; OAuth2 tab: invite
   with the `bot` and `applications.commands` scopes and Send Messages, Embed
   Links, Manage Events permissions).
2. Copy `.env.example` to `.env` and fill in the values:
   - `DISCORD_TOKEN` — the bot token from the Bot tab.
   - `DISCORD_APPLICATION_ID` — the Application ID from General Information.
   - `DISCORD_DEV_GUILD_ID` — your server ID (enable Developer Mode, then
     right-click the server and Copy Server ID). Optional — omit for global
     command registration.
   - `DATABASE_PATH` — path to the SQLite database file. Defaults to
     `data/gamenight.db`.
3. Install dependencies: `npm install`
4. Register slash commands: `npm run deploy`
5. Start the bot: `npm run dev`

## Scripts

- `npm run dev` — run the bot with `tsx`, loading `.env`.
- `npm run build` — compile TypeScript to `dist/`.
- `npm start` — run the compiled bot from `dist/`.
- `npm run deploy` — register slash commands with Discord.
- `npm test` — run the test suite with Vitest.
