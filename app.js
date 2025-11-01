import express from "express";
import { Telegraf } from "telegraf";
import fs from "fs";
import path from "path";
import OpenAI from "openai";

const app = express();
app.use(express.json());

// === Verzeichnisstruktur ===
const DATA_DIR = "/data";
const CUSTOMERS_DIR = path.join(DATA_DIR, "customers");
const ADMIN_FILE = path.join(DATA_DIR, "admin.json");

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

// === Admin-PIN Verwaltung ===
function loadAdminData() {
  try {
    return JSON.parse(fs.readFileSync(ADMIN_FILE, "utf8"));
  } catch {
    return { pin: null };
  }
}

function saveAdminData(data) {
  fs.writeFileSync(ADMIN_FILE, JSON.stringify(data, null, 2), "utf8");
}

function requirePIN(req, res, next) {
  const adminData = loadAdminData();

  // Kein PIN gesetzt → Ersteinrichtung
  if (!adminData.pin) {
    return res.send(`
      <h1>🔐 Admin-PIN festlegen</h1>
      <form method="post" action="/set-pin">
        <input name="pin" type="password" placeholder="Neuer PIN" required />
        <button type="submit">PIN speichern</button>
      </form>
    `);
  }

  // PIN korrekt übergeben
  if (req.query.pin === adminData.pin) {
    return next();
  }

  // PIN falsch oder fehlt
  res.send(`
    <h1>🔑 PIN eingeben</h1>
    <form method="get" action="${req.path}">
      <input name="pin" type="password" placeholder="Admin PIN" required />
      <button type="submit">Login</button>
    </form>
  `);
}

// === PIN-Routen ===
app.post("/set-pin", express.urlencoded({ extended: true }), (req, res) => {
  const { pin } = req.body;
  saveAdminData({ pin });
  res.send(`<h2>✅ PIN gespeichert!</h2><a href="/admin?pin=${pin}">Zum Adminbereich</a>`);
});

app.post("/admin/change-pin", express.urlencoded({ extended: true }), (req, res) => {
  const { newPin } = req.body;
  saveAdminData({ pin: newPin });
  res.send(`<h2>🔄 PIN geändert!</h2><a href="/admin?pin=${newPin}">Zurück zum Adminbereich</a>`);
});

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

  // Admin-Modus aktivieren
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

  // Businessdaten anzeigen
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

  // Textnachrichten
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

  // Webhook einrichten
  const RENDER_URL = process.env.RENDER_URL || "https://chatbotki-mein.onrender.com";
  bot.telegram.setWebhook(`${RENDER_URL}/bot/${customerName}`);
  app.use(`/bot/${customerName}`, bot.webhookCallback(`/bot/${customerName}`));

  bots[customerName] = bot;
  console.log(`🤖 Bot für ${customerName} gestartet.`);
}

// === Alle Kundenbots laden ===
loadCustomerList().forEach(initCustomerBot);

// === Admin Dashboard ===
app.get("/admin", requirePIN, (req, res) => {
  const customers = loadCustomerList();
  const currentPIN = loadAdminData().pin;

  res.send(`
    <h1>🧠 Kundenübersicht</h1>
    <ul>
      ${customers.map((c) => `<li><a href="/admin/view/${c}?pin=${currentPIN}">${c}</a></li>`).join("")}
    </ul>
    <hr />
    <form method="post" action="/admin/new?pin=${currentPIN}">
      <h2>➕ Neuen Kunden hinzufügen</h2>
      <input name="name" placeholder="Kundenname" required />
      <input name="token" placeholder="Bot Token" required />
      <button type="submit">Erstellen</button>
    </form>
    <hr />
    <form method="post" action="/admin/change-pin?pin=${currentPIN}">
      <h2>🔑 PIN ändern</h2>
      <input name="newPin" type="password" placeholder="Neuer PIN" required />
      <button type="submit">PIN ändern</button>
    </form>
  `);
});

// === Kunden-Detailansicht ===
app.get("/admin/view/:customer", requirePIN, (req, res) => {
  const { customer } = req.params;
  const info = loadTextData(customer);
  const currentPIN = loadAdminData().pin;

  res.send(`
    <h1>📄 Daten von ${customer}</h1>
    <form method="post" action="/admin/save/${customer}?pin=${currentPIN}">
      <textarea name="data" rows="20" cols="80">${info}</textarea><br/>
      <button type="submit">💾 Speichern</button>
    </form>
    <p><a href="/admin?pin=${currentPIN}">⬅️ Zurück</a></p>
  `);
});

// === Kundendaten speichern ===
app.post("/admin/save/:customer", requirePIN, express.urlencoded({ extended: true }), (req, res) => {
  const { customer } = req.params;
  const { data } = req.body;
  saveTextData(customer, data);
  const currentPIN = loadAdminData().pin;
  res.send(`<h2>✅ Gespeichert!</h2><a href="/admin/view/${customer}?pin=${currentPIN}">Zurück</a>`);
});

// === Neuen Kunden hinzufügen ===
app.post("/admin/new", requirePIN, express.urlencoded({ extended: true }), (req, res) => {
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
  const currentPIN = loadAdminData().pin;
  res.send(`✅ Kunde ${name} wurde hinzugefügt und Bot gestartet! <a href="/admin?pin=${currentPIN}">Zurück</a>`);
});

// === Root ===
app.get("/", (req, res) => res.send("🤖 Multi-Kunden-Bot läuft!"));

// === Server starten ===
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`🌍 Server läuft auf Port ${PORT}`));











