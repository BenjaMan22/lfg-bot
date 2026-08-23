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
