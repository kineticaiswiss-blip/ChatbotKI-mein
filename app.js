import express from "express";
import { Telegraf } from "telegraf";
import fs from "fs";
import path from "path";
import OpenAI from "openai";

const app = express();
app.use(express.json());

// === WICHTIG: Datenstruktur vorbereiten ===
const DATA_DIR = "/data";
const CUSTOMERS_DIR = path.join(DATA_DIR, "customers");

if (!fs.existsSync(CUSTOMERS_DIR)) {
  fs.mkdirSync(CUSTOMERS_DIR, { recursive: true });
  console.log("📁 Kundenverzeichnis erstellt:", CUSTOMERS_DIR);
}

// === OpenAI Setup ===
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// === Hilfsfunktionen ===
function loadCustomerList() {
  return fs
    .readdirSync(CUSTOMERS_DIR)
    .filter((d) => fs.statSync(path.join(CUSTOMERS_DIR, d)).isDirectory());
}

function loadTextData(customer) {
  const filePath = path.join(CUSTOMERS_DIR, customer, "info.txt");
  try {
    return fs.readFileSync(filePath, "utf8").trim();
  } catch {
    return "Noch keine Informationen vorhanden.";
  }
}

function saveTextData(customer, text) {
  const filePath = path.join(CUSTOMERS_DIR, customer, "info.txt");
  fs.writeFileSync(filePath, text, "utf8");
  console.log(`💾 Daten für ${customer} gespeichert.`);
}

function loadBotToken(customer) {
  const tokenPath = path.join(CUSTOMERS_DIR, customer, "token.txt");
  if (fs.existsSync(tokenPath)) return fs.readFileSync(tokenPath, "utf8").trim();
  return null;
}

// === Bots dynamisch laden ===
const bots = {};

function initCustomerBot(customerName) {
  const token = loadBotToken(customerName);
  if (!token) {
    console.warn(`⚠️ Kein Token für ${customerName} gefunden — Bot wird übersprungen.`);
    return;
  }

  const bot = new Telegraf(token);
  const ADMIN_USERNAME = "laderakh".toLowerCase();
  const adminSessions = {};

  bot.start((ctx) =>
    ctx.reply(`👋 Willkommen beim Chatbot von ${customerName}! Wie kann ich helfen?`)
  );

  // === Admin-Modus aktivieren ===
  bot.command("businessinfo", async (ctx) => {
    const username = (ctx.from.username || "").toLowerCase();
    if (username !== ADMIN_USERNAME)
      return ctx.reply("🚫 Nur der Admin darf diesen Befehl verwenden.");

    adminSessions[ctx.from.id] = true;
    ctx.reply(
      "🧾 Du bist jetzt im Admin-Modus.\n" +
        "Verwende `/data` zum Anzeigen, sende bearbeiteten Text direkt hierher,\n" +
        "oder `/exit` zum Beenden."
    );
  });

  // === Businessdaten anzeigen ===
  bot.command("data", async (ctx) => {
    const username = (ctx.from.username || "").toLowerCase();
    if (username !== ADMIN_USERNAME)
      return ctx.reply("🚫 Nur der Admin darf diesen Befehl verwenden.");

    const textData = loadTextData(customerName);
    ctx.reply(
      "📋 Aktuell gespeicherte Infos:\n\n```text\n" +
        textData +
        "\n```\n✏️ Bearbeite und sende sie zurück, um sie zu speichern."
    );
  });

  // === Textnachrichten ===
  bot.on("text", async (ctx) => {
    const message = ctx.message.text.trim();
    const userId = ctx.from.id;
    const username = (ctx.from.username || "").toLowerCase();

    // Adminbearbeitung
    if (adminSessions[userId] && message.includes(":")) {
      saveTextData(customerName, message);
      return ctx.reply("✅ Infos gespeichert!");
    }

    if (adminSessions[userId] && message.toLowerCase() === "/exit") {
      delete adminSessions[userId];
      return ctx.reply("🚪 Admin-Modus beendet.");
    }

    // GPT-Abfrage
    const info = loadTextData(customerName);
    const prompt = `
Du bist der KI-Assistent von ${customerName}. Verwende nur die folgenden Infos:

${info}

Nutzerfrage: "${message}"
`;

    try {
      const gpt = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: prompt }],
        max_tokens: 200,
      });
      const reply = gpt.choices[0].message.content.trim();
      ctx.reply(reply);
    } catch (err) {
      console.error("❌ GPT Fehler:", err);
      ctx.reply("⚠️ Entschuldigung, ich konnte das gerade nicht beantworten.");
    }
  });

  // === Webhook einrichten ===
  const RENDER_URL = process.env.RENDER_URL || "https://chatbotki-mein.onrender.com";
  bot.telegram.setWebhook(`${RENDER_URL}/bot/${customerName}`);
  app.use(`/bot/${customerName}`, bot.webhookCallback(`/bot/${customerName}`));

  bots[customerName] = bot;
  console.log(`🤖 Bot für ${customerName} gestartet.`);
}

// === Alle Kundenbots laden ===
loadCustomerList().forEach(initCustomerBot);

// === Admin Dashboard ===
// === Admin Dashboard ===
app.get("/admin", (req, res) => {
  const customers = loadCustomerList();
  res.send(`
    <h1>🧠 Kundenübersicht</h1>
    <ul>
      ${customers
        .map(
          (c) =>
            `<li>${c} - <a href="/admin/view/${c}">📄 Anzeigen / Bearbeiten</a></li>`
        )
        .join("")}
    </ul>
    <hr>
    <form method="post" action="/admin/new">
      <h2>➕ Neuen Kunden hinzufügen</h2>
      <input name="name" placeholder="Kundenname" required />
      <input name="token" placeholder="Bot Token" required />
      <button type="submit">Erstellen</button>
    </form>
  `);
});

// === Einzelkunden ansehen/bearbeiten ===
app.get("/admin/view/:customer", (req, res) => {
  const { customer } = req.params;
  const info = loadTextData(customer);
  res.send(`
    <h1>📝 ${customer} bearbeiten</h1>
    <form method="post" action="/admin/save/${customer}">
      <textarea name="text" rows="20" cols="80">${info}</textarea><br>
      <button type="submit">💾 Speichern</button>
    </form>
    <br>
    <a href="/admin">⬅️ Zurück zur Übersicht</a>
  `);
});

// === Änderungen speichern ===
app.post("/admin/save/:customer", express.urlencoded({ extended: true }), (req, res) => {
  const { customer } = req.params;
  const { text } = req.body;
  saveTextData(customer, text);
  res.send(`
    <h2>✅ Daten für ${customer} gespeichert!</h2>
    <a href="/admin/view/${customer}">⬅️ Zurück</a> |
    <a href="/admin">🏠 Übersicht</a>
  `);
});


// === POST /admin/new ===
app.post("/admin/new", express.urlencoded({ extended: true }), (req, res) => {
  const { name, token } = req.body;
  const customerDir = path.join(CUSTOMERS_DIR, name.toLowerCase().replace(/\s+/g, "-"));

  if (fs.existsSync(customerDir)) return res.send("❌ Kunde existiert bereits.");

  fs.mkdirSync(customerDir);
  fs.writeFileSync(path.join(customerDir, "token.txt"), token);
  fs.writeFileSync(
    path.join(customerDir, "info.txt"),
    `Produkte:\nPreise:\nKontakt:\n`,
    "utf8"
  );

  initCustomerBot(name.toLowerCase().replace(/\s+/g, "-"));
  res.send(`✅ Kunde ${name} wurde hinzugefügt und Bot gestartet!`);
});

// === Root ===
app.get("/", (req, res) => res.send("🤖 Multi-Kunden-Bot läuft!"));

// === Server starten ===
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`🌍 Server läuft auf Port ${PORT}`));









