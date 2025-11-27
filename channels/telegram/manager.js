import { readJSON } from "../../core/storage.js";
import { launchTelegramBot } from "./oneBot.js";

export function initAllBots() {
  const bots = readJSON("bots.json", []);

  console.log(`🤖 Starte ${bots.length} Telegram-Bots...`);

  for (const bot of bots) {
    if (!bot.token) {
      console.warn(`⚠️ Bot ${bot.id} hat kein Token – übersprungen`);
      continue;
    }

    try {
      launchTelegramBot({
        botId: bot.id,
        token: bot.token
      });

      console.log(`✅ Bot ${bot.id} gestartet`);
    } catch (err) {
      console.error(`❌ Fehler bei Bot ${bot.id}`, err);
    }
  }
}
