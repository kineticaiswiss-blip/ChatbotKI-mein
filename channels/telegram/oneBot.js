import { Telegraf } from "telegraf";
import OpenAI from "openai";
import fs from "fs";
import path from "path";

// ✅ EINZIGER korrekter Import
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
   LAUFENDE BOTS (Registry)
========================= */
const runningBots = new Map();

/* =========================
   EINEN BOT STARTEN
========================= */
async function launchBot(botConfig) {
  const { id, token, allowedTelegramIds = [] } = botConfig;

  if (!token) {
    console.log(`⛔ Bot ${id} übersprungen – kein Token`);
    return;
  }

  // 🛑 Stoppe alten Bot falls vorhanden
  if (runningBots.has(id)) {
    try {
      await runningBots.get(id).stop();
      console.log(`🛑 Bot ${id} gestoppt`);
    } catch {}
    runningBots.delete(id);
  }

  console.log(`🟢 Starte Bot ${id}`);
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

    if (allowedTelegramIds.length && !allowedTelegramIds.includes(userId)) {
      ctx.reply("🚫 Du bist für diesen Bot nicht freigeschaltet.");
      return;
    }

    try {
      const info = fs.readFileSync(infoFile, "utf8");

      const result = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: "Antworte nur anhand dieser Infos:\n" + info },
          { role: "user", content: ctx.message.text }
        ],
        temperature: 0.2,
        max_tokens: 350
      });

      const answer = result.choices?.[0]?.message?.content?.trim();
      ctx.reply(answer || "🤔 Dazu habe ich keine Information.");
    } catch (err) {
      console.error(`❌ OpenAI Fehler (${id}):`, err);
      ctx.reply("⚠️ Fehler beim Antworten.");
    }
  });

  await bot.telegram.deleteWebhook();
  await bot.launch({ dropPendingUpdates: true });

  runningBots.set(id, bot);
  console.log(`✅ Telegram-Bot gestartet: ${id}`);
}

/* =========================
   ALLE AKTIVEN BOTS STARTEN
========================= */
export async function startTelegramBots() {
  const bots = loadBots();

  console.log(`🔄 Bot-Reload: ${bots.length} Config(s)`);

  // 🧹 Stoppe Bots die nicht mehr aktiv sind
  for (const [id, bot] of runningBots.entries()) {
    if (!bots.find(b => b.id === id && b.active && b.token)) {
      try {
        await bot.stop();
        console.log(`🛑 Bot ${id} gestoppt (nicht mehr aktiv)`);
      } catch {}
      runningBots.delete(id);
    }
  }

  const active = bots.filter(b => b.active && b.token);
  console.log(`🚀 Starte ${active.length} Telegram-Bot(s)...`);

  for (const bot of active) {
    await launchBot(bot);
  }
}
