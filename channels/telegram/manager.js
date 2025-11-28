import { launchTelegramBot } from "./oneBot.js";

export function startTelegramBots() {
  console.log("🚀 Starte Telegram-Bots...");

  launchTelegramBot({
    botId: "nexorai",
    token: process.env.BOT_TOKEN_1
  });
}
