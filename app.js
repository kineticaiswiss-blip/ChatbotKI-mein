import express from "express";
import { Telegraf } from "telegraf";
import fs from "fs";
import path from "path";
import OpenAI from "openai";

const app = express();

// === Pfad zur persistenten Render-Disk ===
const DATA_DIR = "/data";

// ✅ Stelle sicher, dass der Ordner /data existiert
if (!fs.existsSync(DATA_DIR)) {
  console.log("📁 Erstelle Datenverzeichnis:", DATA_DIR);
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// === Datei für Textdaten ===
const DATA_TEXT_FILE = path.join(DATA_DIR, "businessinfo.txt");
console.log("💾 Textdaten werden gespeichert in:", DATA_TEXT_FILE);

// Falls Datei fehlt, mit Standard-Template anlegen
if (!fs.existsSync(DATA_TEXT_FILE)) {
  const defaultText = `Produkte:
ChattbotKI, SocialmediaKI

Preise:
ChattbotKI = 1000.- monatlich
SocialmediaKI = 450.- bis 1200.- monatlich

Produktinfos:
ChattbotKI = KI-gestützter Chatbot für Unternehmen
SocialmediaKI = Automatisierte Social-Media-Inhalte und Planung

Telefonsupport:
Telefonnummer = 1234567890
Verfügbar = Mo–Fr, 9–17 Uhr
`;
  fs.writeFileSync(DATA_TEXT_FILE, defaultText, "utf8");
  console.log("🗂️ businessinfo.txt erstellt.");
}

// === Hilfsfunktionen ===
function loadTextData() {
  try {
    return fs.readFileSync(DATA_TEXT_FILE, "utf8").trim();
  } catch (err) {
    console.error("❌ Fehler beim Laden von businessinfo.txt:", err);
    return "";
  }
}

function saveTextData(text) {
  try {
    fs.writeFileSync(DATA_TEXT_FILE, text, "utf8");
    console.log("💾 Textdaten gespeichert.");
  } catch (err) {
    console.error("❌ Fehler beim Speichern:", err);
  }
}

// === BOT & OPENAI Setup ===
const bot = new Telegraf(process.env.BOT_TOKEN);
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// === Admin-Einstellungen ===
const ADMIN_USERNAME = "laderakh".toLowerCase();
const adminSessions = {};

// === BOT START ===
bot.start((ctx) => {
  ctx.reply("👋 Hallo! Ich bin der Business-KI-Bot. Frag mich etwas über Produkte, Preise oder Öffnungszeiten!");
});

// === ADMIN BEFEHL: /businessinfo ===
bot.command("businessinfo", async (ctx) => {
  const username = (ctx.from.username || "").toLowerCase();
  if (username !== ADMIN_USERNAME) {
    return ctx.reply("🚫 Nur der Geschäftsinhaber darf diesen Befehl verwenden.");
  }

  adminSessions[ctx.from.id] = true;
  ctx.reply(
    "🧾 Du bist jetzt im Admin-Modus.\n" +
      "Du kannst die Businessdaten mit `/data` ansehen, kopieren, bearbeiten und zurückschicken.\n" +
      "Mit `/exit` verlässt du den Admin-Modus."
  );
});

// === ADMIN BEFEHL: /data ===
bot.command("data", async (ctx) => {
  const username = (ctx.from.username || "").toLowerCase();
  if (username !== ADMIN_USERNAME) {
    return ctx.reply("🚫 Nur der Geschäftsinhaber darf diesen Befehl verwenden.");
  }

  const textData = loadTextData();
  ctx.reply(
    "🧾 Aktuell gespeicherte Business-Infos:\n\n" +
      "```text\n" +
      textData +
      "\n```\n" +
      "✏️ Du kannst diesen Text kopieren, bearbeiten und **im Admin-Modus** zurückschicken.\n" +
      "Ich speichere ihn dann dauerhaft in `/data/businessinfo.txt`."
  );
});

// === TEXT-NACHRICHTEN ===
bot.on("text", async (ctx) => {
  const username = (ctx.from.username || "").toLowerCase();
  const userId = ctx.from.id;
  const message = ctx.message.text.trim();

  // === ADMIN FUNKTION: bearbeiteter Text ===
  if (adminSessions[userId] && message.includes(":")) {
    // Prüfen ob es formatiert ist
    const looksLikeFormattedData = message.match(/^[A-Za-zäöüÄÖÜß ]+:/m);
    if (looksLikeFormattedData) {
      saveTextData(message);
      return ctx.reply("✅ Alle Business-Infos wurden erfolgreich aktualisiert und dauerhaft gespeichert.");
    }
  }

  // === ADMIN BEFEHL /exit ===
  if (adminSessions[userId] && message.toLowerCase() === "/exit") {
    delete adminSessions[userId];
    return ctx.reply("✅ Admin-Modus beendet.");
  }

  // === NORMALER NUTZER: GPT-Antwort ===
  const textData = loadTextData();

  const prompt = `
Du bist ein digitaler Assistent eines Unternehmens. Antworte auf Nutzerfragen mithilfe der gespeicherten Informationen unten.

Gespeicherte Informationen:
${textData}

Wenn der Nutzer eine unklare Frage stellt, bitte ihn höflich, zu präzisieren, ob er etwas zu einem der folgenden Themen wissen möchte:
${textData
  .split("\n")
  .filter((line) => line.endsWith(":"))
  .map((line) => "- " + line.replace(":", ""))
  .join("\n")}

Nutzerfrage: "${message}"
`;

  try {
    const gptResponse = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: prompt }],
      max_tokens: 200,
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
    fs.writeFileSync(testFile, `Test gespeichert am ${new Date().toISOString()}\n`, { flag: "a" });
    console.log("✅ Persistenz-Test erfolgreich: Datei geschrieben ->", testFile);

  } catch (err) {
    console.error("❌ Fehler beim Starten des Bots:", err);
  }
})();








