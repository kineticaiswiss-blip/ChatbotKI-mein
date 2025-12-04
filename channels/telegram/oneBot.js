import { Telegraf } from "telegraf";
import OpenAI from "openai";
import fs from "fs";
import path from "path";

// ✅ EINZIGER, korrekter Import
import { loadBots } from "../../dashboard/bots.js";

/* =========================
   PERSISTENTE DISK (Render)
========================= */
const DATA_DIR = process.env.RENDER_PERSISTENT_DIR || "/var/data";
const INFO_DIR = path.join(DATA_DIR, "bots_info");

if (!fs.existsSync(INFO_DIR)) {
  fs.mkdirSync(INFO_DIR, { recursive: true });
  console.log("✅ INFO_DIR angelegt:", INFO_DIR);
}

/* =========================
   OPENAI
========================= */
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

/* =========================
   BOT START (EIN BOT)
========================= */
async function launchBot(botConfig) {
  const { id, token, allowedTelegramIds = [] } = botConfig;

  if (!token) {
    console.log(`⛔ Bot ${id}: kein Token`);
    return;
  }

  const bot = new Telegraf(token);

  const infoFile = path.join(INFO_DIR, `${id}.txt`);
  if (!fs.existsSync(infoFile)) {
    fs.writeFileSync(infoFile, "Firmeninfos:\n", "utf8");
  }

  bot.start(ctx => {
    ctx.reply("👋 Bot ist online. Schreib mir einfach.");
  });

  bot.on("text", async ctx => {
    const userId = String(ctx.from.id);

    // 🔒 Telegram-ID Einschränkung (optional)
    if (allowedTelegramIds.length && !allowedTelegramIds.includes(userId)) {
      return ctx.reply("🚫 Du bist für diesen Bot nicht freigeschaltet.");
    }

    try {
      const info = fs.readFileSync(infoFile, "utf8");

      const result = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
          {
            role: "system",
            content:
              "Du bist ein Firmenassistent. Antworte NUR basierend auf diesen Infos:\n" +
              info
          },
          { role: "user", content: ctx.message.text }
        ],
        temperature: 0.2,
        max_tokens: 300
      });

      const answer = result.choices?.[0]?.message?.content?.trim();
      ctx.reply(answer || "🤔 Dazu habe ich keine Information.");
    } catch (err) {
      console.error("❌ OpenAI Fehler:", err);
      ctx.reply("⚠️ Fehler beim Antworten.");
    }
  });

  try {
    await bot.telegram.deleteWebhook();
    await bot.launch({ dropPendingUpdates: true });
    console.log(`✅ Telegram-Bot gestartet: ${id}`);
  } catch (err) {
    console.error(`❌ Bot ${id} Start fehlgeschlagen`, err);
  }
}

/* =========================
   START ALLER BOTS
========================= */
export async function startTelegramBots() {
  const bots = loadBots().filter(b => b.active && b.token);

  if (!bots.length) {
    console.log("ℹ️ Keine aktiven Bots mit Token gefunden.");
    return;
  }

  console.log(`🚀 Starte ${bots.length} Telegram-Bot(s)...`);

  for (const bot of bots) {
    await launchBot(bot);
  }
}
