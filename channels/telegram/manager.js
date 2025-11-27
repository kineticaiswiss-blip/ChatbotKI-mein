// channels/telegram/oneBot.js
import { Telegraf } from "telegraf";
import fs from "fs";
import path from "path";
import OpenAI from "openai";
import { readJSON, writeJSON } from "../../core/storage.js";
import { getUserRoleForBot } from "../../core/permissions.js";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

export function launchTelegramBot({ botId, token }) {
  const bot = new Telegraf(token);

  const infoFile = path.join("data", "bots_info", `${botId}.json`);
  if (!fs.existsSync(infoFile)) fs.writeFileSync(infoFile, "[]");

  bot.start(ctx => {
    ctx.reply("👋 Ich bin bereit. Du kannst mir jederzeit schreiben.");
  });

  bot.on("text", async ctx => {
    const text = ctx.message.text.trim();
    const userId = String(ctx.from.id);

    const accounts = readJSON("accounts.json", []);
    const bots = readJSON("bots.json", []);

    const role = getUserRoleForBot({
      accounts,
      bots,
      botId,
      userId,
      channel: "telegram"
    });

    // 🔒 Befehle NUR für Admins
    if (text.startsWith("/")) {
      if (!role.isAdmin) {
        return ctx.reply("🚫 Dieser Befehl ist nur für Admins.");
      }
      return ctx.reply("✅ Admin-Befehl erkannt (später erweiterbar).");
    }

    // 🧠 Kunde darf Infos ergänzen
    if (role.isCustomer && text.startsWith("info:")) {
      const data = JSON.parse(fs.readFileSync(infoFile, "utf8"));
      data.push({ from: userId, text: text.replace("info:", "").trim() });
      fs.writeFileSync(infoFile, JSON.stringify(data, null, 2));
      return ctx.reply("✅ Info gespeichert.");
    }

    // 🌍 JEDER bekommt Antwort
    try {
      const botInfo = fs.readFileSync(infoFile, "utf8");

      const completion = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
          {
            role: "system",
            content:
              "Du bist ein Firmenassistent. Nutze NUR diese Infos:\n" +
              botInfo
          },
          { role: "user", content: text }
        ],
        temperature: 0.2,
        max_tokens: 300
      });

      ctx.reply(completion.choices[0].message.content.trim());
    } catch (err) {
      console.error(err);
      ctx.reply("⚠️ Fehler beim Antworten.");
    }
  });

  bot.launch();
}
