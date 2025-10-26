import express from "express";
import { Telegraf } from "telegraf";
import fs from "fs";
import OpenAI from "openai";
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });


const app = express();

// 🔹 Telegram-Bot-Token (aus Render Environment oder hier direkt)
const bot = new Telegraf(process.env.BOT_TOKEN || "8095209153:AAEf26PD2H0m4xUSxSsYXQ70zQRlRF8L5Tk");

// 🔹 Datei für das gespeicherte Wissen
const DATA_FILE = "./memory.json";

// Wenn Datei noch nicht existiert → anlegen
if (!fs.existsSync(DATA_FILE)) {
  fs.writeFileSync(DATA_FILE, JSON.stringify({}));
}

// 🔹 Speicherfunktionen
function loadMemory() {
  return JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
}
function saveMemory(memory) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(memory, null, 2));
}

// 🔹 Variable, um zu merken, ob jemand gerade dem Bot etwas beibringt
let pendingQuestion = null;

// 🔹 Startbefehl
bot.start((ctx) =>
  ctx.reply("👋 Hallo! Ich bin ein lernender Chatbot. Frag mich etwas!")
);

// 🔹 Lern- und Antwortlogik
bot.on("text", async (ctx) => {
  try {
    const text = ctx.message.text.toLowerCase().trim();
    const memory = loadMemory();

    // Wenn der Bot gerade auf eine Antwort wartet
    if (pendingQuestion) {
      memory[pendingQuestion] = text;
      saveMemory(memory);
      await ctx.reply(
        `💾 Super! Ich habe gelernt: Wenn jemand "${pendingQuestion}" sagt, antworte "${text}".`
      );
      pendingQuestion = null;
      return;
    }

    // Wenn der Bot das Wort bereits kennt
    if (memory[text]) {
      await ctx.reply(memory[text]);
    } else {
      // Wenn der Bot das Wort noch nicht kennt
      await ctx.reply(`Ich kenne "${text}" noch nicht. Was soll ich darauf antworten?`);
      pendingQuestion = text;
    }
  } catch (error) {
    console.error("❌ Fehler im Bot:", error);
    await ctx.reply("⚠️ Es ist ein Fehler aufgetreten. Bitte versuche es nochmal!");
  }
});

// 🔹 Bot starten
try {
  bot.launch();
  console.log("🤖 Bot wurde gestartet!");
} catch (error) {
  console.error("Fehler beim Starten des Bots:", error);
}

// 🔹 Webserver für Render
app.get("/", (req, res) => res.send("🤖 KI-Chatbot läuft und lernt!"));
app.listen(10000, () => console.log("🌐 Server läuft auf Port 10000"));
