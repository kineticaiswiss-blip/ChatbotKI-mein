import { Telegraf } from "telegraf";
import OpenAI from "openai";
import fs from "fs";
import path from "path";

/* =========================
   KONFIGURATION
========================= */

// 👇 HIER DEINE TELEGRAM-ID EINTRAGEN
const SUPER_ADMIN_IDS = [
  6369024996 // ← HIER DEINE ID
];

// Optional: Info-Datei
const DATA_DIR = path.resolve("data");
const INFO_DIR = path.join(DATA_DIR, "bots_info");

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

if (!fs.existsSync(INFO_DIR)) {
  fs.mkdirSync(INFO_DIR, { recursive: true });
}

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

/* =========================
   BOT START
========================= */

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
    const userId = ctx.from.id;
    const isAdmin = SUPER_ADMIN_IDS.includes(userId);

    /* ===== ADMIN-BEFEHLE ===== */
    if (text.startsWith("/")) {
      if (!isAdmin) {
        return ctx.reply("🚫 Dieser Befehl ist nur für Admins.");
      }

      if (text === "/status") {
        return ctx.reply(`✅ Bot ${botId} läuft korrekt.`);
      }

      if (text.startsWith("/info ")) {
        const newInfo = text.replace("/info", "").trim();
        fs.writeFileSync(infoFile, newInfo, "utf8");
        return ctx.reply("✅ Firmeninfo aktualisiert.");
      }

      return ctx.reply("✅ Admin-Befehl erkannt.");
    }

    /* ===== ALLE ANDEREN FRAGEN ===== */
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
