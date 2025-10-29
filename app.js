import express from "express";
import { Telegraf } from "telegraf";
import fs from "fs";
import OpenAI from "openai";

const app = express();

// === BOT & OPENAI Setup ===
const bot = new Telegraf(process.env.BOT_TOKEN);
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// === Dateien & Einstellungen ===
const DATA_FILE = "./businessinfo.json";
const ADMIN_USERNAME = "laderakh".toLowerCase();
const adminSessions = {};

// === Datei prüfen / erstellen ===
if (!fs.existsSync(DATA_FILE)) {
  fs.writeFileSync(DATA_FILE, JSON.stringify({ produkte: {}, info: {} }, null, 2));
}

function loadData() {
  try {
    const content = fs.readFileSync(DATA_FILE, "utf8").trim();
    if (!content) {
      console.warn("⚠️ businessinfo.json war leer – wird neu erstellt.");
      const emptyData = { produkte: {}, info: {} };
      saveData(emptyData);
      return emptyData;
    }
    return JSON.parse(content);
  } catch (err) {
    console.error("❌ Fehler beim Laden der businessinfo.json:", err);
    const fallback = { produkte: {}, info: {} };
    saveData(fallback);
    return fallback;
  }
}

function saveData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

// === BOT START ===
bot.start((ctx) => {
  ctx.reply("👋 Hallo! Ich bin der Business-KI-Bot. Frag mich etwas über Produkte oder Allgemeines!");
});

// === ADMIN BEFEHL ===
bot.command("businessinfo", async (ctx) => {
  const username = (ctx.from.username || "").toLowerCase();

  if (username !== ADMIN_USERNAME) {
    return ctx.reply("🚫 Nur der Geschäftsinhaber darf diesen Befehl verwenden.");
  }

  adminSessions[ctx.from.id] = true; // Admin-Modus aktiv
  ctx.reply(
    "🧾 Du bist jetzt im Admin-Modus.\n" +
      "Schreibe im Format:\n`produkt: apfelsaft = 2.50 €`\noder\n`info: öffnungszeiten = Mo–Fr 8–18 Uhr`\n" +
      "Schreibe `/exit`, um den Modus zu beenden."
  );
});

// === TEXT-NACHRICHTEN ===
bot.on("text", async (ctx) => {
  const username = ctx.from.username || "";
  const userId = ctx.from.id;
  const message = ctx.message.text.trim();
  const messageLower = message.toLowerCase();
  const data = loadData();

  // --- ADMIN MODUS ---
  if (adminSessions[userId]) {
    if (messageLower === "/exit") {
      delete adminSessions[userId];
      return ctx.reply("✅ Admin-Modus beendet.");
    }

    try {
      if (messageLower.startsWith("produkt:")) {
        const [key, value] = message.replace(/produkt:/i, "").split("=");
        data.produkte[key.trim()] = value.trim();
        saveData(data);
        return ctx.reply(`💾 Produkt gespeichert: ${key.trim()} = ${value.trim()}`);
      } else if (messageLower.startsWith("info:")) {
        const [key, value] = message.replace(/info:/i, "").split("=");
        data.info[key.trim()] = value.trim();
        saveData(data);
        return ctx.reply(`💾 Info gespeichert: ${key.trim()} = ${value.trim()}`);
      } else {
        return ctx.reply("⚠️ Bitte verwende das Format `produkt:` oder `info:`.");
      }
    } catch (err) {
      console.error("Fehler beim Speichern:", err);
      return ctx.reply("❌ Fehler beim Speichern.");
    }
  }

  // --- GPT erkennt, ob Frage zu gespeicherten Infos gehört ---
  try {
    const infoKeys = Object.keys(data.info);
    const produktKeys = Object.keys(data.produkte);

    const categories = [...infoKeys, ...produktKeys];

    const prompt = `
      Analysiere die Nutzerfrage und finde heraus, ob sie sich auf eine der folgenden Kategorien bezieht:
      ${categories.map((c) => `- ${c}`).join("\n")}

      Antworte nur mit dem genauen Begriff aus der Liste, falls zutreffend.
      Wenn keine Kategorie passt, antworte nur mit "none".

      Nutzerfrage: "${message}"
    `;

    const gptMatch = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: prompt }],
      max_tokens: 20,
    });

    const matchedKey = gptMatch.choices[0].message.content.trim().toLowerCase();

    // --- Falls GPT eine gespeicherte Kategorie erkannt hat ---
    if (matchedKey !== "none") {
      if (data.info[matchedKey]) {
        return ctx.reply(`ℹ️ ${matchedKey}: ${data.info[matchedKey]}`);
      }
      if (data.produkte[matchedKey]) {
        return ctx.reply(`🛍️ ${matchedKey}: ${data.produkte[matchedKey]}`);
      }
    }
  } catch (err) {
    console.error("Fehler bei GPT-Erkennung:", err);
  }

  // --- Wenn keine gespeicherte Info passt → ChatGPT allgemeine Antwort ---
  try {
    const prompt = `
      Du bist ein höflicher, freundlicher Assistent eines Geschäfts.
      - Antworte auf allgemeine Fragen freundlich (z. B. Wochentag, Uhrzeit, Smalltalk).
      - Wenn du die Frage nicht verstehst, frage höflich nach.
      - Wenn die Frage geschäftlich ist, aber keine gespeicherte Info vorhanden ist,
        sage: "Diese Information habe ich nicht, bitte frage direkt beim Geschäft nach."
      Nutzerfrage: "${message}"
    `;

    const gptResponse = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: prompt }],
      max_tokens: 120,
    });

    const reply = gptResponse.choices[0].message.content.trim();
    await ctx.reply(reply);
  } catch (err) {
    console.error("GPT-Fehler:", err);
    await ctx.reply("⚠️ Entschuldigung, ich konnte das gerade nicht beantworten.");
  }
});

// === SERVER START ===
const PORT = process.env.PORT || 10000;
const RENDER_URL = "https://chatbotki-mein.onrender.com";

(async () => {
  try {
    await bot.telegram.setWebhook(`${RENDER_URL}/bot${process.env.BOT_TOKEN}`);
    app.use(bot.webhookCallback(`/bot${process.env.BOT_TOKEN}`));

    app.get("/", (req, res) => res.send("🤖 Business-KI-Bot läuft über Webhook!"));
    app.listen(PORT, () => console.log(`🌐 Server läuft auf Port ${PORT}`));

    console.log("✅ Webhook erfolgreich gesetzt!");
  } catch (err) {
    console.error("❌ Fehler beim Starten des Bots:", err);
  }
})();




