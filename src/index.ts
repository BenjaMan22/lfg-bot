import { Client, Events, GatewayIntentBits } from "discord.js";
import { loadConfig } from "./config.js";
import { routeInteraction } from "./interactions/router.js";
import type { AppContext } from "./context.js";
import { openDatabase } from "./db/index.js";
import { startSweep } from "./nights/lock.js";
import { log } from "./log.js";

// Last-resort nets for failures that never reach routeInteraction's catch —
// e.g. an async callback nobody awaited. Without these, a rejected promise
// prints Node's generic warning (or nothing, depending on flags) with no
// timestamp and no context.
process.on("unhandledRejection", (reason) => {
  log.error("Unhandled promise rejection", reason);
});
process.on("uncaughtException", (error) => {
  log.error("Uncaught exception — exiting", error);
  // State after an uncaught exception is unknown; exit and let Docker's
  // restart policy (or you, locally) bring the bot back clean.
  process.exit(1);
});

const config = loadConfig();

const db = openDatabase(config.databasePath);
const ctx: AppContext = { db, config };

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildScheduledEvents,
  ],
  // User-supplied text (game names, poll titles) is echoed into messages.
  // Default to parsing no mentions; the few messages that intend to ping
  // pass their own allowedMentions to override this.
  allowedMentions: { parse: [] },
});

client.once(Events.ClientReady, (c) => {
  log.info(`Logged in as ${c.user.tag}`);
  startSweep(c, db);
});

// discord.js reports gateway and parsing problems here. With no listener, an
// "error" event crashes the process with a bare stack; a "warn" is just lost.
client.on(Events.Error, (error) => log.error("Discord client error", error));
client.on(Events.Warn, (message) => log.warn("Discord client warning", message));

client.on(Events.InteractionCreate, (interaction) => {
  void routeInteraction(interaction, ctx);
});

await client.login(config.token);
