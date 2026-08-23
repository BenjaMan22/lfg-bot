import type { ChatInputCommandInteraction } from "discord.js";
import type { AppContext } from "../context.js";
import * as gamenight from "./gamenight.js";

export interface SlashCommand {
  data: { name: string; toJSON(): unknown };
  execute(i: ChatInputCommandInteraction, ctx: AppContext): Promise<void>;
}

export const commands: SlashCommand[] = [gamenight];

export const commandsByName = new Map(commands.map((c) => [c.data.name, c]));
