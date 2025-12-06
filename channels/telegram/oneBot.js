import { Telegraf } from "telegraf";
import OpenAI from "openai";
import fs from "fs";
import path from "path";
import { loadBots } from "../../dashboard/bots.js";

/* =========================
   OPENAI
========================= */
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

/* =========================
   PERSISTENT DISK (Render)
========================= */
const DATA_DIR = process.env.RENDER_PERSISTENT_DIR || "/var/data";
const INFO_DIR = path.join(DATA_DIR, "bots_info");

if (!fs.existsSync(INFO_DIR)) {
  fs.mkdirSync(INFO_DIR, { recursive: true });
  console.log("✅ INFO_DIR erstellt:", INFO_DIR);
}

/* =========================
   RUNNING BOTS REGISTRY
========================= */
const runningBots = new Map(); // id → Telegraf

/* =========================
   START SINGLE BOT (SAFE)
========================= */
async function startSingleBot(botConfig) {
  const { id, token, active, allowedTelegramIds = [] } = botConfig;

  if (!active || !token) {
    console.log(`⏭️ Bot ${id} übersprungen (inaktiv oder kein Token)`);
    return;
  }

  // ✅ IMMER vorher stoppen → sonst 409
  if (runningBots.has(id)) {
    try {
      await runningBots.get(id).stop();
      console.log(`🛑 Alter Bot gestoppt: ${id}`);
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
    ctx.reply("👋 Bot ist online.");
  });

  bot.on("text", async ctx => {
    const userId = String(ctx.from.id);

    if (
      allowedTelegramIds.length &&
      !allowedTelegramIds.includes(userId)
    ) {
      return ctx.reply("🚫 Nicht freigeschaltet.");
    }

    try {
      const info = fs.readFileSync(infoFile, "utf8");

      const res = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: "Antworte NUR anhand dieser Infos:\n" + info },
          { role: "user", content: ctx.message.text }
        ],
        temperature: 0.2,
        max_tokens: 300
      });

      await ctx.reply(
        res.choices?.[0]?.message?.content?.trim() ||
        "🤔 Keine Information vorhanden."
      );
    } catch (err) {
      console.error(`❌ OpenAI Fehler (${id})`, err.message);
      await ctx.reply("⚠️ Interner Fehler.");
    }
  });

  await bot.telegram.deleteWebhook();
  await bot.launch({ dropPendingUpdates: true });

  runningBots.set(id, bot);
  console.log(`✅ Bot aktiv: ${id}`);
}

/* =========================
   START / RELOAD ALL BOTS
========================= */
export async function startTelegramBots() {
  const bots = loadBots();
  console.log(`🔄 Bot-Reload (${bots.length} Konfigurationen)`);

  // 🧹 Stoppe entfernte / deaktivierte Bots
  for (const [id, bot] of runningBots.entries()) {
    const exists = bots.find(b => b.id === id && b.active && b.token);
    if (!exists) {
      try {
        await bot.stop();
        console.log(`🛑 Bot gestoppt: ${id}`);
      } catch {}
      runningBots.delete(id);
    }
  }

  // ▶️ Starte alle aktiven
  for (const bot of bots) {
    await startSingleBot(bot);
  }

  console.log("🤖 Telegram-Bots synchronisiert");
}

/* =========================
   CLEAN SHUTDOWN (Render)
========================= */
process.once("SIGINT", async () => {
  for (const bot of runningBots.values()) {
    try { await bot.stop(); } catch {}
  }
  process.exit(0);
});
