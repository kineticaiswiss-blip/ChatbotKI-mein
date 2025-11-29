import fs from "fs";
import path from "path";
import { Telegraf } from "telegraf";
import OpenAI from "openai";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

const DATA_DIR = path.resolve("data");
const INFO_DIR = path.join(DATA_DIR, "bots_info");

// ✅ sichere Ordner
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}
if (!fs.existsSync(INFO_DIR)) {
  fs.mkdirSync(INFO_DIR, { recursive: true });
}

export function launchTelegramBot({ botId, token }) {
  if (!token) {
    console.log(`❌ Kein Token für Bot ${botId}`);
    return;
  }

  const bot = new Telegraf(token);
  const infoFile = path.join(INFO_DIR, `${botId}.txt`);

  if (!fs.existsSync(infoFile)) {
    fs.writeFileSync(infoFile, "Firmeninfos:\n", "utf8");
  }

  bot.start(ctx => {
    ctx.reply("👋 Bot ist online. Schreib mir einfach.");
  });

  bot.on("text", async ctx => {
    const text = ctx.message.text.trim();

    try {
      const info = fs.readFileSync(infoFile, "utf8");

      const response = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
          {
            role: "system",
            content:
              "Du bist ein Firmenassistent. Nutze NUR diese Infos:\n" + info
          },
          { role: "user", content: text }
        ],
        max_tokens: 300,
        temperature: 0.2
      });

      ctx.reply(response.choices[0].message.content.trim());
    } catch (err) {
      console.error(err);
      ctx.reply("⚠️ Fehler beim Antworten.");
    }
  });

  bot.launch({ dropPendingUpdates: true });
  console.log(`✅ Telegram-Bot gestartet: ${botId}`);
}
