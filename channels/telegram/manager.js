// channels/telegram/manager.js
import { readJSON } from "../../core/storage.js";
import { launchTelegramBot } from "./oneBot.js";

export function startTelegramBots() {
  const bots = readJSON("bots.json", []);

  if (!bots.length) {
    console.log("⚠️ Keine Telegram-Bots gefunden.");
    return;
  }

  bots.forEach(bot => {
    if (!bot.token || !bot.id) return;

    try {
      launchTelegramBot({
        botId: bot.id,
        token: bot.token
      });
      console.log(`✅ Telegram-Bot gestartet: ${bot.name || bot.id}`);
    } catch (e) {
      console.error("❌ Fehler bei Bot-Start:", e.message);
    }
  });
}
