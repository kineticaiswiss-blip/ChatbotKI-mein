import express from "express";
import { Telegraf } from "telegraf";
import fs from "fs";
import path from "path";
import OpenAI from "openai";

const app = express();

// === Pfad zur persistenten Render-Disk ===
const DATA_DIR = "/data";

// ✅ Stelle sicher, dass der Ordner /data existiert
try {
  if (!fs.existsSync(DATA_DIR)) {
    console.log("📁 Erstelle Datenverzeichnis:", DATA_DIR);
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
} catch (err) {
  console.error("⚠️ Konnte /data nicht erstellen:", err);
}

// === Datei-Pfad definieren (mit Fallback) ===
const DATA_FILE = fs.existsSync(DATA_DIR)
  ? path.join(DATA_DIR, "businessinfo.json")
  : path.join(process.cwd(), "businessinfo.json");

console.log("💾 Daten werden gespeichert in:", DATA_FILE);

// === BOT & OPENAI Setup ===
const bot = new Telegraf(process.env.BOT_TOKEN);
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// === Admin-Einstellungen ===
const ADMIN_USERNAME = "laderakh".toLowerCase();
const adminSessions = {};

// === Datei prüfen / erstellen ===
if (!fs.existsSync(DATA_FILE)) {
  console.log("🗂️ businessinfo.json nicht gefunden – wird erstellt...");
  fs.writeFileSync(DATA_FILE, JSON.stringify({}, null, 2));
}

// === Hilfsfunktionen ===
function loadData() {
  try {
    const content = fs.readFileSync(DATA_FILE, "utf8").trim();
    if (!content) {
      console.warn("⚠️ businessinfo.json war leer – wird neu erstellt.");
      const emptyData = {};
      saveData(emptyData);
      return emptyData;
    }
    return JSON.parse(content);
  } catch (err) {
    console.error("❌ Fehler beim Laden der businessinfo.json:", err);
    const fallback = {};
    saveData(fallback);
    return fallback;
  }
}

function saveData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

// === BOT START ===
bot.start((ctx) => {
  ctx.reply("👋 Hallo! Ich bin der Business-KI-Bot. Frag mich etwas über Produkte, Preise oder Öffnungszeiten!");
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
      "Schreibe einfach z. B.:\n" +
      "`preis chatbot = 1200€`\n" +
      "`öffnungszeiten = Mo–Fr 8–18 Uhr`\n" +
      "`adresse = Musterstraße 1, Zürich`\n" +
      "oder `/exit`, um den Modus zu beenden."
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
      // ✅ Universelles Speicherformat (key = value)
      const match = message.match(/^(.+?)\s*=\s*(.+)$/);
      if (match) {
        const key = match[1].trim().toLowerCase();
        const value = match[2].trim();
        data[key] = value;
        saveData(data);
        return ctx.reply(`💾 Gespeichert: ${key} = ${value}`);
      } else {
        return ctx.reply("⚠️ Bitte verwende das Format `schlüssel = wert`.");
      }
    } catch (err) {
      console.error("❌ Fehler beim Speichern:", err);
      return ctx.reply("❌ Fehler beim Speichern.");
    }
  }

  // --- GPT erkennt gespeicherte Begriffe ---
  try {
    const keys = Object.keys(data);
    if (keys.length > 0) {
      const gptPrompt = `
        Analysiere die Nutzerfrage und bestimme, ob sie sich auf eine der folgenden gespeicherten Informationen bezieht:
        ${keys.map((c) => `- ${c}`).join("\n")}
        Antworte nur mit einem Begriff aus der Liste oder mit "none".
        Nutzerfrage: "${message}"
      `;

      const gptMatch = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: gptPrompt }],
        max_tokens: 20,
      });

      const matchedKey = gptMatch.choices[0].message.content.trim().toLowerCase();

      if (matchedKey !== "none" && data[matchedKey]) {
        return ctx.reply(`💡 ${matchedKey}: ${data[matchedKey]}`);
      }
    }
  } catch (err) {
    console.error("⚠️ Fehler bei GPT-Erkennung:", err);
  }

  // --- Allgemeine Fragen (Datum, Smalltalk etc.) ---
  try {
    const now = new Date();
    const weekday = now.toLocaleDateString("de-DE", { weekday: "long" });
    const dateStr = now.toLocaleDateString("de-DE");

    const prompt = `
      Du bist ein freundlicher digitaler Assistent eines Geschäfts.
      Heutiges Datum: ${dateStr}
      Wochentag: ${weekday}

      Regeln:
      - Nutze gespeicherte Daten (${Object.keys(data).length} Einträge), wenn sie relevant sind.
      - Falls der Nutzer etwas über "heute" fragt, beziehe dich auf den heutigen Tag (${weekday}).
      - Wenn du etwas nicht weißt, sage: "Diese Information habe ich leider nicht, bitte frage direkt beim Geschäft nach."

      Gespeicherte Informationen:
      ${Object.entries(data)
        .map(([k, v]) => `${k}: ${v}`)
        .join("\n")}

      Nutzerfrage: "${message}"
    `;

    const gptResponse = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: prompt }],
      max_tokens: 150,
    });

    const reply = gptResponse.choices[0].message.content.trim();
    await ctx.reply(reply);
  } catch (err) {
    console.error("❌ GPT-Fehler:", err);
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

    // === Persistenz-Test ===
    const testFile = path.join(DATA_DIR, "persistenztest.txt");
    try {
      fs.writeFileSync(testFile, `Test gespeichert am ${new Date().toISOString()}\n`, { flag: "a" });
      console.log("✅ Persistenz-Test erfolgreich: Datei geschrieben ->", testFile);
    } catch (err) {
      console.error("❌ Persistenz-Test FEHLER:", err);
    }

  } catch (err) {
    console.error("❌ Fehler beim Starten des Bots:", err);
  }
})();






