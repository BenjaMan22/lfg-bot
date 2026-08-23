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
