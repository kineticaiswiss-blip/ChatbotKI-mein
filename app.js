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
  try {
    const userText = ctx.message.text.toLowerCase().trim();
    const userId = ctx.from.id;
    const memory = loadMemory();

    // Wenn der Nutzer gerade "Lehrmodus" aktiv hat
    if (memory._learning && memory._learning[userId]) {
      const question = memory._learning[userId];
      const answer = userText;
      memory[question] = answer;
      delete memory._learning[userId];
      saveMemory(memory);
      await ctx.reply("💾 Danke! Ich habe das gelernt.");
      return;
    }

    // Wenn der Bot die Frage schon kennt
  let pendingQuestion = null;

bot.on("text", async (ctx) => {
  const text = ctx.message.text.toLowerCase();

  // Wenn der Bot gerade auf eine Antwort wartet:
  if (pendingQuestion) {
    memory[pendingQuestion] = text;
    await fs.writeFile("memory.json", JSON.stringify(memory, null, 2));
    await ctx.reply(`Super! Ich habe gelernt: Wenn jemand "${pendingQuestion}" sagt, antworte "${text}".`);
    pendingQuestion = null;
    return;
  }

  // Wenn der Bot die Eingabe schon kennt:
  if (memory[text]) {
    await ctx.reply(memory[text]);
  } else {
    // Wenn der Bot das Wort noch nicht kennt:
    await ctx.reply(`Ich kenne "${text}" noch nicht. Was soll ich darauf antworten?`);
    pendingQuestion = text; // Speichern, worauf er gerade wartet
  }
});


      // Nutzer merken, dass er gerade etwas beibringt
      if (!memory._learning) memory._learning = {};
      memory._learning[userId] = userText;
      saveMemory(memory);
    }
  } catch (error) {
    console.error("❌ Fehler im Bot:", error);
    await ctx.reply("⚠️ Es ist ein Fehler aufgetreten. Bitte versuche es nochmal!");
  }
});


bot.launch();

// 🔹 Express-Webserver (für Render)
app.get("/", (req, res) => res.send("🤖 KI-Chatbot läuft und lernt!"));
app.listen(10000, () => console.log("Server läuft auf Port 10000"));
