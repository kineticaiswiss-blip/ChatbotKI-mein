import { Telegraf } from "telegraf";
import OpenAI from "openai";
import fs from "fs";
import path from "path";
import { loadBots } from "../../dashboard/bots.js";

/* =========================
   DISK (RENDER-KOMPATIBEL)
========================= */
const DATA_DIR = "/var/data";
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
   EINZELNEN BOT STARTEN
========================= */
export async function launchTelegramBot({ botId, token, allowedTelegramIds = [] }) {
  if (!botId || !token) {
    console.log(`❌ Bot ${botId}: fehlende ID oder Token`);
    return;
  }

  const bot = new Telegraf(token);

  const infoFile = path.join(INFO_DIR, `${botId}.txt`);
  if (!fs.existsSync(infoFile)) {
    fs.writeFileSync(infoFile, "Firmeninformationen:\n", "utf8");
  }

  bot.start(ctx => {
    ctx.reply("👋 Bot ist online. Schreib mir einfach.");
  });

  bot.on("text", async ctx => {
    const text = ctx.message.text.trim();
    const userId = String(ctx.from.id);

    const isAdmin =
      Array.isArray(allowedTelegramIds) &&
      allowedTelegramIds.includes(userId);

    /* ===== ADMIN BEFEHLE ===== */
    if (text.startsWith("/")) {
      if (!isAdmin) {
        return ctx.reply("🚫 Dieser Befehl ist nur für Admins.");
      }

      if (text === "/status") {
        return ctx.reply(`✅ Bot ${botId} läuft.`);
      }

      if (text.startsWith("/info ")) {
        const newInfo = text.replace("/info", "").trim();
        fs.appendFileSync(infoFile, newInfo + "\n", "utf8");
        return ctx.reply("✅ Firmeninfo gespeichert.");
      }

      return ctx.reply("✅ Admin-Befehl erkannt.");
    }

    /* ===== KI-ANTWORT (ALLE USER) ===== */
    try {
      const info = fs.readFileSync(infoFile, "utf8");

      const response = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
          {
            role: "system",
            content:
              "Du bist ein Firmenassistent. Antworte NUR basierend auf diesen Infos:\n" +
              info
          },
          { role: "user", content: text }
        ],
        temperature: 0.2,
        max_tokens: 300
      });

      const answer =
        response.choices?.[0]?.message?.content?.trim();

      ctx.reply(answer || "🤔 Dazu habe ich leider keine Information.");
    } catch (err) {
      console.error("❌ OpenAI Fehler:", err);
      ctx.reply("⚠️ Fehler beim Antworten.");
    }
  });

  try {
    await bot.telegram.deleteWebhook();
    await bot.launch({ dropPendingUpdates: true });
    console.log(`✅ Telegram-Bot gestartet: ${botId}`);
  } catch (err) {
    console.error(`❌ Bot ${botId} konnte nicht gestartet werden`, err);
  }
}

/* =========================
   ALLE AKTIVEN BOTS STARTEN
========================= */
export async function startTelegramBots() {
  const bots = loadBots();

  const activeBots = bots.filter(
    b => b.active && b.token
  );

  if (!activeBots.length) {
    console.log("ℹ️ Keine aktiven Bots mit Token in bots.json gefunden.");
    return;
  }

  console.log(`🚀 Starte ${activeBots.length} Telegram-Bot(s)...`);

  for (const bot of activeBots) {
    await launchTelegramBot({
      botId: bot.id,
      token: bot.token,
      allowedTelegramIds: bot.allowedTelegramIds || []
    });
  }
}
