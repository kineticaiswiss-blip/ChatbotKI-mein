import { Telegraf } from "telegraf";
import OpenAI from "openai";
import fs from "fs";
import path from "path";
import { loadBots } from "../../dashboard/bots.js";

/* =========================
   PERSISTENTE DISK
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
   BOT REGISTRY
========================= */
const runningBots = new Map();

/* =========================
   EINEN BOT STARTEN
========================= */
async function launchBot(botConfig) {
  const { id, token, allowedTelegramIds = [] } = botConfig;

  if (!token) return;

  // ✅ WICHTIG: NICHT neu starten, wenn er schon läuft
  if (runningBots.has(id)) {
    console.log(`✅ Bot ${id} läuft bereits – übersprungen`);
    return;
  }

  console.log(`🟢 Starte Bot ${id}`);
  const bot = new Telegraf(token);

  const infoFile = path.join(INFO_DIR, `${id}.txt`);
  if (!fs.existsSync(infoFile)) {
    fs.writeFileSync(infoFile, "Firmeninfos:\n", "utf8");
  }

  bot.start(ctx => {
    ctx.reply("👋 Bot ist online.");
  });

  bot.on("text", async ctx => {
    const userId = String(ctx.from.id);

    if (allowedTelegramIds.length && !allowedTelegramIds.includes(userId)) {
      ctx.reply("🚫 Du bist für diesen Bot nicht freigeschaltet.");
      return;
    }

    try {
      const info = fs.readFileSync(infoFile, "utf8");

      const res = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: "Antworte nur anhand dieser Infos:\n" + info },
          { role: "user", content: ctx.message.text }
        ],
        temperature: 0.2,
        max_tokens: 350
      });

      ctx.reply(res.choices?.[0]?.message?.content || "🤔 Keine Info vorhanden.");
    } catch (e) {
      console.error(`❌ OpenAI Fehler (${id})`, e);
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

  // 🧹 Stoppe nur Bots, die deaktiviert wurden
  for (const [id, bot] of runningBots.entries()) {
    const stillActive = bots.find(b => b.id === id && b.active && b.token);
    if (!stillActive) {
      try {
        await bot.stop();
        console.log(`🛑 Bot ${id} deaktiviert`);
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
