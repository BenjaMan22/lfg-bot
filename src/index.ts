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
