import { Telegraf } from "telegraf";
import OpenAI from "openai";
import fs from "fs";
import path from "path";

/* =========================
   KONFIGURATION
========================= */

// ✅ Telegram-Admin-IDs IMMER als STRING
const SUPER_ADMIN_IDS = [
  "6369024996"
];

// ✅ ABSOLUTER & RENDER-SICHERER PFAD
const DATA_DIR = path.join(process.cwd(), "data");
const INFO_DIR = path.join(DATA_DIR, "bots_info");

fs.mkdirSync(INFO_DIR, { recursive: true });

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

/* =========================
   BOT START
========================= */

export async function launchTelegramBot({ botId, token }) {
  if (!botId || !token) {
    console.log(`❌ Bot ${botId}: fehlende ID oder Token`);
    return;
  }

  const bot = new Telegraf(token);

  const infoFile = path.join(INFO_DIR, `${botId}.txt`);
  if (!fs.existsSync(infoFile)) {
    fs.writeFileSync(
      infoFile,
      "Firmeninfos:\n",
      "utf8"
    );
  }

  bot.start(ctx => {
    ctx.reply("👋 Bot ist online. Schreib mir einfach.");
  });

  bot.on("text", async ctx => {
    const text = ctx.message.text.trim();
    const userId = String(ctx.from.id);
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
        fs.writeFileSync(infoFile, newInfo + "\n", "utf8");
        return ctx.reply("✅ Firmeninfo gespeichert.");
      }

      return ctx.reply("✅ Admin-Befehl erkannt.");
    }

    /* ===== NORMALE FRAGEN (ALLES & JEDER) ===== */
    try {
      const info = fs.readFileSync(infoFile, "utf8");

      const response = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
          {
            role: "system",
            content:
              "Du bist ein Firmenassistent. Antworte NUR basierend auf diesen Infos:\n" + info
          },
          { role: "user", content: text }
        ],
        temperature: 0.2,
        max_tokens: 300
      });

      const answer = response.choices?.[0]?.message?.content?.trim();
      ctx.reply(answer || "🤔 Dazu habe ich leider keine Information.");
    } catch (err) {
      console.error("❌ OpenAI Fehler:", err);
      ctx.reply("⚠️ Fehler beim Antworten.");
    }
  });

  try {
    // ✅ GANZ WICHTIG AUF RENDER
    await bot.telegram.deleteWebhook();
    await bot.launch({ dropPendingUpdates: true });

    console.log(`✅ Telegram-Bot gestartet: ${botId}`);
  } catch (err) {
    console.error(`❌ Bot ${botId} konnte nicht gestartet werden`, err);
  }
}
