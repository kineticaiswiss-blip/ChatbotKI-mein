import express from "express";
import { Telegraf } from "telegraf";

const app = express();

// Setze hier deinen Telegram Bot Token ein
const bot = new Telegraf(process.env.BOT_TOKEN || "DEIN_BOT_TOKEN_HIER");

bot.start((ctx) => ctx.reply("👋 Hallo! Ich bin dein Chatbot."));
bot.on("text", (ctx) => ctx.reply(`Du hast gesagt: ${ctx.message.text}`));

bot.launch();

app.get("/", (req, res) => res.send("✅ Bot läuft auf Render!"));
app.listen(10000, () => console.log("Server läuft auf Port 10000"));
