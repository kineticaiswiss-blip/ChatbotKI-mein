import express from "express";
import { Telegraf } from "telegraf";
import OpenAI from "openai";
import fs from "fs";

const app = express();

// 🔑 Bot & API Keys
const BOT_TOKEN = process.env.BOT_TOKEN || "DEIN_TELEGRAM_TOKEN_HIER";
const OPENAI_KEY = process.env.OPENAI_API_KEY || "DEIN_OPENAI_KEY_HIER";

// 🧠 OpenAI Client
const openai = new OpenAI({ apiKey: OPENAI_KEY });
const bot = new Telegraf(BOT_TOKEN);

// 🗂 Speicherdatei
const DATA_FILE = "./memory.json";
if (!fs.existsSync(DATA_FILE)) fs.writeFileSync(DATA_FILE, JSON.stringify({}));

const loadMemory = () => JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
const saveMemory = (m) => fs.writeFileSync(DATA_FILE, JSON.stringify(m, null, 2));

// 🧩 Startbefehl
bot.start((ctx) => ctx.reply("👋 Hallo! Ich bin dein lernender KI-Bot."));

// 💬 Hauptlogik
bot.on("text", async (ctx) => {
  try {
    const userText = ctx.message.text.trim();
    const memory = loadMemory();

    // Wenn der Nutzer gerade im Lehrmodus ist
    if (memory._teaching && memory._teaching[ctx.from.id]) {
      const intent = memory._teaching[ctx.from.id];
      memory[intent] = userText;
      delete memory._teaching[ctx.from.id];
      saveMemory(memory);
      await ctx.reply(`💾 Ich habe gelernt, wie ich auf "${intent}" antworten soll.`);
      return;
    }

    // Schritt 1: ChatGPT sagt, was der Nutzer *meint*
    const aiResp = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: "Du bist ein Intent-Classifier. Sag nur das Thema oder die Bedeutung in 1-3 Wörtern." },
        { role: "user", content: userText }
      ]
    });

    const intent = aiResp.choices[0].message.content.toLowerCase().trim();

    // Schritt 2: Prüfen, ob der Bot schon weiß, was zu tun ist
    if (memory[intent]) {
      await ctx.reply(memory[intent]);
      return;
    }

    // Schritt 3: Wenn er das Thema nicht kennt → fragen
    if (!memory._teaching) memory._teaching = {};
    memory._teaching[ctx.from.id] = intent;
    saveMemory(memory);
    await ctx.reply(`Ich kenne "${intent}" noch nicht. Was soll ich darauf antworten?`);

  } catch (err) {
    console.error("❌ Fehler:", err);
    await ctx.reply("⚠️ Es gab einen Fehler. Bitte versuch es nochmal!");
  }
});

// 🌐 Server für Render
bot.launch();
app.get("/", (req, res) => res.send("🤖 Lernender Bot läuft!"));
app.listen(10000, () => console.log("🌐 Server läuft auf Port 10000"));

