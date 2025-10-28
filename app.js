import express from "express";
import { Telegraf } from "telegraf";
import fs from "fs";
import OpenAI from "openai";

const app = express();
const bot = new Telegraf(process.env.BOT_TOKEN);
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// Pfad zur Business-Datenbank
const DATA_FILE = "./businessinfo.json";

// Wenn die Datei nicht existiert → leere Datei anlegen
if (!fs.existsSync(DATA_FILE)) {
  fs.writeFileSync(DATA_FILE, JSON.stringify({ produkte: {}, info: {} }, null, 2));
}

// Hilfsfunktionen zum Laden/Speichern
function loadData() {
  return JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
}
function saveData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

// Admin-Telegram-Benutzername
const ADMIN_USERNAME = "laderakh";

// 🟢 Befehl: Start
bot.start((ctx) => {
  ctx.reply(
    "👋 Hallo! Ich bin der Business-KI-Bot. Frag mich gern etwas über unsere Produkte oder Allgemeines!"
  );
});

// 🟢 Befehl: Businessdaten bearbeiten (nur für Admin)
const adminSessions = {}; // Speichert Admin-Modus pro Benutzer

bot.command("businessinfo", async (ctx) => {
  const username = ctx.from.username;
  if (username !== ADMIN_USERNAME) {
    return ctx.reply("🚫 Nur der Geschäftsinhaber darf diesen Befehl verwenden.");
  }

  adminSessions[ctx.from.id] = true;
  ctx.reply(
    "🧾 Du bist im Admin-Modus.\n" +
    "Schreibe im Format:\n`produkt: apfelsaft = 2.50 €`\noder\n`info: öffnungszeiten = Mo–Fr 8–18 Uhr`\n" +
    "Schreibe `/exit`, um den Modus zu beenden."
  );
});


// 🟡 Textnachrichten
bot.on("text", async (ctx) => {
  const username = ctx.from.username || "";
  const message = ctx.message.text.toLowerCase().trim();
  const data = loadData();

  // Wenn Admin im Bearbeitungsmodus ist
if (adminSessions[ctx.from.id]) {
  if (message === "/exit") {
    delete adminSessions[ctx.from.id];
    return ctx.reply("✅ Admin-Modus beendet.");
  }
  ...
}


    // Eintrag speichern
    try {
      if (message.startsWith("produkt:")) {
        const [key, value] = message.replace("produkt:", "").split("=");
        data.produkte[key.trim()] = value.trim();
        saveData(data);
        return ctx.reply(`💾 Produkt gespeichert: ${key.trim()} = ${value.trim()}`);
      } else if (message.startsWith("info:")) {
        const [key, value] = message.replace("info:", "").split("=");
        data.info[key.trim()] = value.trim();
        saveData(data);
        return ctx.reply(`💾 Info gespeichert: ${key.trim()} = ${value.trim()}`);
      } else {
        return ctx.reply("⚠️ Bitte verwende das Format `produkt:` oder `info:`.");
      }
    } catch (err) {
      console.error(err);
      return ctx.reply("❌ Fehler beim Speichern.");
    }
  }

  // 🧩 Schritt 1: Prüfen, ob Frage in Businessdaten vorkommt
  for (const [produkt, antwort] of Object.entries(data.produkte)) {
    if (message.includes(produkt.toLowerCase())) {
      return ctx.reply(`🛍️ ${antwort}`);
    }
  }
  for (const [info, antwort] of Object.entries(data.info)) {
    if (message.includes(info.toLowerCase())) {
      return ctx.reply(`ℹ️ ${antwort}`);
    }
  }

  // 🧩 Schritt 2: Allgemeine Fragen mit ChatGPT verstehen
const prompt = `
Du bist ein smarter, freundlicher KI-Assistent eines Geschäfts.
Du darfst nur auf allgemeine, neutrale Fragen antworten (z. B. Wochentag, Zeit, Wetter, Smalltalk).
Wenn du unsicher bist oder die Frage nicht verstehst, formuliere sie klarer
und frage höflich beim Nutzer nach, ob du sie richtig verstanden hast.
Wenn die Frage geschäftlich ist (Produkte, Preise, Öffnungszeiten),
sage höflich: "Diese Information habe ich nicht, bitte frage direkt beim Geschäft nach."
Frage: "${message}"
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

// Serverstart
process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
bot.launch();
app.get("/", (req, res) => res.send("🤖 Business-KI-Bot läuft"));
app.listen(10000, () => console.log("🌐 Server läuft auf Port 10000"));
