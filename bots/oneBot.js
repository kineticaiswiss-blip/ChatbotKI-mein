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

// Hilfsfunktion: Admin-Telegram-IDs aus Dashboard laden
function loadAdminTelegramIds(botId) {
  if (!fs.existsSync(ACCOUNTS_FILE)) return [];

  const accounts = JSON.parse(fs.readFileSync(ACCOUNTS_FILE, "utf8"));

  return accounts
    .filter(a =>
      (a.role === "admin" || a.role === "superadmin") ||
      (a.role === "customer" && (a.assignedBots || []).includes(botId))
    )
    .map(a => a.telegramId)
    .filter(Boolean);
}

export function initOneBot(botId, app) {
  const infoPath = path.join(BOTS_INFO_DIR, botId + ".json");
  if (!fs.existsSync(infoPath)) return;

  const botData = JSON.parse(fs.readFileSync(infoPath, "utf8"));
  if (!botData.token) return;

  const bot = new Telegraf(botData.token);

  bot.start(ctx => {
    ctx.reply("👋 Willkommen! Du kannst mir jederzeit eine Frage stellen.");
  });

  bot.on("text", async ctx => {
    const text = ctx.message.text.trim();
    const fromId = ctx.from.id;

    // Admins aus Dashboard bestimmen
    const adminTelegramIds = loadAdminTelegramIds(botId);
    const isAdmin = adminTelegramIds.includes(fromId);

    // 🔒 Telegram-Befehle nur für Admins
    if (text.startsWith("/") && !isAdmin) {
      return ctx.reply("⛔ Dieser Befehl ist nur für Admins erlaubt.");
    }

    // 👉 Jede andere Nachricht wird beantwortet (Admin & Nicht-Admin)
    try {
      const systemPrompt =
        botData.system ||
        "Du bist ein freundlicher Firmenassistent. Antworte sachlich und hilfreich nur basierend auf den bekannten Infos.";

      const gpt = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: text }
        ],
        temperature: 0,
        max_tokens: 300
      });

      const answer = gpt.choices[0].message.content.trim();
      ctx.reply(answer || "🤔 Dazu habe ich leider keine Information.");
    } catch (err) {
      console.error("OpenAI Fehler:", err);
      ctx.reply("⚠️ Es ist ein Fehler aufgetreten. Bitte später erneut versuchen.");
    }
  });

  bot.launch({ dropPendingUpdates: true });
  console.log(`🤖 Bot aktiv: ${botId}`);
}
