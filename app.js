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

// Wenn Datei nicht existiert → neue erstellen
if (!fs.existsSync(DATA_FILE)) {
  fs.writeFileSync(DATA_FILE, JSON.stringify({ produkte: {}, info: {} }, null, 2));
}

// Hilfsfunktionen
function loadData() {
  return JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
}
function saveData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

// Admin-Benutzername
const ADMIN_USERNAME = "laderakh";
const adminSessions = {}; // speichert, wer gerade im Admin-Modus ist

// 🟢 /start
bot.start((ctx) => {
  ctx.reply("👋 Hallo! Ich bin der Business-KI-Bot. Frag mich gern etwas über unsere Produkte oder Allgemeines!");
});

// 🟢 /businessinfo (nur Admin)
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

  // 🧩 Admin-Modus aktiv
  if (adminSessions[ctx.from.id]) {
    if (message === "/exit") {
      delete adminSessions[ctx.from.id];
      return ctx.reply("✅ Admin-Modus beendet.");
    }

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

  // 🧩 Schritt 1: Datenbank prüfen
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

  // 🧩 Schritt 2: Allgemeine Fragen mit ChatGPT
  try {
    const prompt = `
      Du bist ein smarter, höflicher KI-Assistent eines Geschäfts.
      Es gibt zwei Regelarten:
      1️⃣ Wenn die Frage allgemein ist (z. B. Wochentag, Zeit, Smalltalk, Wetter),
          antworte kurz, klar und korrekt.
          - Wenn nach dem Wochentag gefragt wird, nutze das heutige Datum (${new Date().toLocaleDateString("de-DE", { weekday: "long", day: "numeric", month: "long", year: "numeric" })}).
      2️⃣ Wenn die Frage geschäftlich ist (Produkte, Preise, Öffnungszeiten, Bestellungen usw.),
          antworte NICHT selbst, sondern sage:
          "Diese Information habe ich nicht, bitte frage direkt beim Geschäft nach."

      Wenn du die Frage nicht verstehst oder sie unklar ist:
      - Formuliere si
