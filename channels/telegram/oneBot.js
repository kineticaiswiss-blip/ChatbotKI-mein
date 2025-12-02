import { Telegraf } from "telegraf";
import OpenAI from "openai";
import fs from "fs";
import path from "path";

/* =========================
   PERSISTENTE DISK
   -> gleiche Disk wie Accounts: /var/data
========================= */
const DATA_DIR = "/var/data";                 // WICHTIG: NICHT /data
const INFO_DIR = path.join(DATA_DIR, "bots_info");
const BOTS_FILE = path.join(DATA_DIR, "bots.json");

// Ordner für Bot-Infos sicherstellen
if (!fs.existsSync(INFO_DIR)) {
  try {
    fs.mkdirSync(INFO_DIR, { recursive: true });
    console.log("✅ INFO_DIR angelegt:", INFO_DIR);
  } catch (err) {
    console.error("❌ Konnte INFO_DIR nicht anlegen:", err);
  }
}

/* =========================
   TELEGRAM ADMIN IDs
========================= */
// hier deine Telegram-User-IDs als STRING
const SUPER_ADMIN_IDS = [
  "6369024996"
];

/* =========================
   OPENAI CLIENT
========================= */
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

/* =========================
   SINGLE BOT START
========================= */
export async function launchTelegramBot({ id: botId, token }) {
  if (!botId || !token) {
    console.log(`❌ Bot ${botId}: fehlende ID oder Token`);
    return;
  }

  const bot = new Telegraf(token);

  const infoFile = path.join(INFO_DIR, `${botId}.txt`);
  if (!fs.existsSync(infoFile)) {
    fs.writeFileSync(infoFile, "Firmeninfos:\n", "utf8");
  }

  // /start
  bot.start(ctx => {
    ctx.reply("👋 Bot ist online. Schreib mir einfach deine Frage.");
  });

  // alle Text-Nachrichten
  bot.on("text", async ctx => {
    const text = ctx.message.text.trim();
    const userId = String(ctx.from.id);
    const isAdmin = SUPER_ADMIN_IDS.includes(userId);

    // ---- ADMIN-BEFEHLE ----
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

    // ---- normale User-Fragen ----
    try {
      const info = fs.readFileSync(infoFile, "utf8");

      const response = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
          {
            role: "system",
            content:
              "Du bist ein Firmenassistent. Antworte freundlich und präzise NUR basierend auf diesen Infos:\n" +
              info
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

  // Bot starten
  try {
    await bot.telegram.deleteWebhook();
    await bot.launch({ dropPendingUpdates: true });
    console.log(`✅ Telegram-Bot gestartet: ${botId}`);
  } catch (err) {
    console.error(`❌ Bot ${botId} konnte nicht gestartet werden`, err);
  }
}

/* =========================
   ALLE BOTS AUS bots.json STARTEN
========================= */
function loadBotsFromDisk() {
  try {
    if (!fs.existsSync(BOTS_FILE)) return [];
    const raw = fs.readFileSync(BOTS_FILE, "utf8");
    return JSON.parse(raw);
  } catch (err) {
    console.error("❌ Konnte bots.json nicht lesen:", err);
    return [];
  }
}

export async function startTelegramBots() {
  const bots = loadBotsFromDisk();

  const activeBots = bots.filter(b => b.active && b.token);
  if (!activeBots.length) {
    console.log("ℹ️ Keine aktiven Bots mit Token in bots.json gefunden.");
    return;
  }

  console.log(`🚀 Starte ${activeBots.length} Telegram-Bot(s)...`);

  for (const botConfig of activeBots) {
    try {
      await launchTelegramBot(botConfig);
    } catch (err) {
      console.error("❌ Fehler beim Starten von Bot", botConfig.id, err);
    }
  }
}
