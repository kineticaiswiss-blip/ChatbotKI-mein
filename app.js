import express from "express";
import { Telegraf } from "telegraf";
import fs from "fs";

const app = express();

// Bot-Token aus Render Environment oder direkt im Code
const bot = new Telegraf(process.env.BOT_TOKEN || "8095209153:AAEf26PD2H0m4xUSxSsYXQ70zQRlRF8L5Tk");

// 🔹 Speicherdatei für Wissen
const DATA_FILE = "./memory.json";

// Wenn Datei noch nicht existiert → anlegen
if (!fs.existsSync(DATA_FILE)) {
  fs.writeFileSync(DATA_FILE, JSON.stringify({}));
}

// Hilfsfunktion: Wissen laden/speichern
function loadMemory() {
  return JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
}
function saveMemory(memory) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(memory, null, 2));
}

// 🔹 Bot-Start
bot.start((ctx) =>
  ctx.reply("👋 Hallo! Ich bin ein lernender Chatbot. Frag mich etwas!")
);

// 🔹 Wenn jemand etwas schreibt
bot.on("text", async (ctx) => {
  const userText = ctx.message.text.toLowerCase().trim();
  const memory = loadMemory();

  if (memory[userText]) {
    // Kennt die Antwort schon
    await ctx.reply(memory[userText]);
  } else {
    // Kennt es noch nicht
    await ctx.reply(`🤔 Ich kenne "${userText}" noch nicht. Was soll ich darauf antworten?`);

    // Warte auf die nächste Nachricht vom gleichen Nutzer
    bot.once("text", async (newCtx) => {
      const answer = newCtx.message.text.trim();
      memory[userText] = answer; // speichern
      saveMemory(memory);
      await newCtx.reply("💾 Danke! Ich habe das gelernt.");
    });
  }
});

bot.launch();

// 🔹 Express-Webserver (für Render)
app.get("/", (req, res) => res.send("🤖 KI-Chatbot läuft und lernt!"));
app.listen(10000, () => console.log("Server läuft auf Port 10000"));
