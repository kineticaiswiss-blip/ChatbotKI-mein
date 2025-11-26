import fs from "fs";
import { Telegraf } from "telegraf";
import OpenAI from "openai";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

export function initOneBot(botId, app) {
  const infoPath = `./data/bots_info/${botId}.json`;
  if (!fs.existsSync(infoPath)) return;

  const botData = JSON.parse(fs.readFileSync(infoPath, "utf8"));
  if (!botData.token) return;

  const bot = new Telegraf(botData.token);

  bot.on("text", async ctx => {
    const text = ctx.message.text;

    // Admin-Befehl nur für Admins
    if (text.startsWith("/") && !botData.admins.includes(ctx.from.id)) {
      return ctx.reply("⛔ Keine Berechtigung");
    }

    const gpt = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: botData.system || "Du bist ein Firmenbot." },
        { role: "user", content: text }
      ],
      temperature: 0
    });

    ctx.reply(gpt.choices[0].message.content);
  });

  bot.launch();
  console.log("🤖 Bot gestartet:", botId);
}

