require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');

const token = process.env.TELEGRAM_TOKEN;
const bot = new TelegramBot(token, { polling: true });

bot.on('message', (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text;

  if (text.toLowerCase() === 'hallo') {
    bot.sendMessage(chatId, 'Hallo 👋 Ich bin dein neuer KI-Bot!');
  } else {
    bot.sendMessage(chatId, `Ich habe "${text}" gehört, aber ich lerne noch 😅`);
  }
});

console.log('🤖 Bot läuft! Warte auf Nachrichten...');
