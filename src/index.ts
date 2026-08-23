import { Client, Events, GatewayIntentBits } from "discord.js";
import { loadConfig } from "./config.js";
import { routeInteraction } from "./interactions/router.js";
import type { AppContext } from "./context.js";
import { openDatabase } from "./db/index.js";
import { startSweep } from "./nights/lock.js";

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
  console.log(`Logged in as ${c.user.tag}`);
  startSweep(c, db);
});

client.on(Events.InteractionCreate, (interaction) => {
  void routeInteraction(interaction, ctx);
});

await client.login(config.token);
