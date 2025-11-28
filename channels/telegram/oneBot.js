import fs from "fs";
import path from "path";
import { Telegraf } from "telegraf";
import OpenAI from "openai";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

const DATA_DIR = "./data";
const ACCOUNTS_FILE = path.join(DATA_DIR, "accounts.json");
const BOTS_INFO_DIR = path.join(DATA_DIR, "bots_info");

/* =========================
   HILFSFUNKTIONEN
========================= */

// Alle Telegram-IDs, die für diesen Bot Admin-Rechte haben
function loadAdminTelegramIds(botId) {
  if (!fs.existsSync(ACCOUNTS_FILE)) return [];

  const accounts = JSON.parse(fs.readFileSync(ACCOUNTS_FILE, "utf8"));

  return accounts
    .filter(a =>
      a.telegramId &&
      (
        a.role === "admin" ||
        a.role === "superadmin" ||
        (a.role === "customer" && (a.assignedBots || []).includes(botId))
      )
    )
    .map(a => String(a.telegramId));
}

/* =========================
   BOT STARTEN
========================= */

export async function initOneBot(botId) {

  const infoPath = path.join(BOTS_INFO_DIR, `${botId}.json`);
  if (!fs.existsSync(infoPath)) {
    console.warn(`⚠️ Keine Bot-Info für ${botId}`);
    return;
  }

  const botData = JSON.parse(fs.readFileSync(infoPath, "utf8"));
  if (!botData.token) {
    console.warn(`⚠️ Kein Token für Bot ${botId}`);
    return;
  }

  const bot = new Telegraf(botData.token);

  /* =========================
     START
  ========================= */
  bot.start(ctx => {
    ctx.reply("👋 Hallo! Du kannst mir jederzeit eine Frage stellen.");
  });

  /* =========================
     TEXT HANDLER
  ========================= */
  bot.on("text", async ctx => {
    const text = (ctx.message.text || "").trim();
    const fromId = String(ctx.from.id);

    const adminIds = loadAdminTelegramIds(botId);
    const isAdmin = adminIds.includes(fromId);

    /* 🔒 Befehle NUR für Admins */
    if (text.startsWith("/")) {
      if (!isAdmin) {
        return ctx.reply("⛔ Dieser Befehl ist nur für Admins erlaubt.");
      }
      return ctx.reply("✅ Admin-Befehl erkannt (noch nicht implementiert).");
    }

    /* 🌍 JEDER bekommt eine Antwort */
    try {
      let systemPrompt =
        botData.system ||
        "Du bist ein hilfsbereiter Firmenassistent. Antworte freundlich, klar und faktenbasiert.";

      const gpt = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: text }
        ],
        temperature: 0.2,
        max_tokens: 300
      });

      const answer = gpt.choices?.[0]?.message?.content?.trim();

      await ctx.reply(
        answer && answer.length > 0
          ? answer
          : "🤔 Dazu habe ich leider keine Information."
      );

    } catch (err) {
      console.error(`❌ OpenAI Fehler (${botId}):`, err);
      ctx.reply("⚠️ Interner Fehler. Bitte später erneut versuchen.");
    }
  });

  /* =========================
     WICHTIG: WEBHOOK LÖSCHEN
  ========================= */
  await bot.telegram.deleteWebhook();

  /* =========================
     BOT STARTEN (POLLING)
  ========================= */
  await bot.launch({ dropPendingUpdates: true });
  console.log(`🤖 Bot aktiv: ${botId}`);
}

/* ✅ Alias für ältere Manager-Logik */
export const launchTelegramBot = initOneBot;
