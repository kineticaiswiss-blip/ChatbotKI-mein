import fs from "fs";
import path from "path";
import { launchTelegramBot } from "./oneBot.js";

const DATA_DIR = process.env.DATA_DIR || "/mnt/data";
const BOTS_FILE = path.join(DATA_DIR, "bots.json");

export function startTelegramBots() {
  if (!fs.existsSync(BOTS_FILE)) return;

  const bots = JSON.parse(fs.readFileSync(BOTS_FILE));
  console.log(`🤖 Starte ${bots.length} Telegram-Bots...`);

  bots.forEach(b => {
    if (b.token) {
      launchTelegramBot(b.id, b.token);
      console.log(`✅ Bot ${b.id} gestartet`);
    }
  });
}
