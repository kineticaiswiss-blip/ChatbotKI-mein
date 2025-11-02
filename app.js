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

  if (!adminData.pin) {
    return res.send(`
      <h1>🔐 Admin-PIN festlegen</h1>
      <form method="post" action="/set-pin">
        <input name="pin" type="password" placeholder="Neuer PIN" required />
        <button type="submit">PIN speichern</button>
      </form>
    `);
  }

  if (req.query.pin === adminData.pin) {
    return next();
  }

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
const pausedBots = {};

function stopCustomerBot(customer) {
  if (bots[customer]) {
    try {
      bots[customer].stop();
      delete bots[customer];
      console.log(`⏹️ Bot für ${customer} gestoppt.`);
    } catch (err) {
      console.error(`Fehler beim Stoppen von ${customer}:`, err);
    }
  }
}

function initCustomerBot(customerName) {
  const token = loadBotToken(customerName);
  if (!token) {
    console.warn(`⚠️ Kein Token für ${customerName} gefunden — Bot wird übersprungen.`);
    return;
  }

  if (pausedBots[customerName]) {
    console.log(`⏸️ Bot ${customerName} ist pausiert — wird nicht gestartet.`);
    return;
  }

  const bot = new Telegraf(token);
  const ADMIN_USERNAME = "laderakh".toLowerCase();
  const adminSessions = {};

  bot.start((ctx) =>
    ctx.reply(`👋 Willkommen beim Chatbot von ${customerName}! Wie kann ich helfen?`)
  );

  bot.command("businessinfo", async (ctx) => {
    const username = (ctx.from.username || "").toLowerCase();
    if (username !== ADMIN_USERNAME)
      return ctx.reply("🚫 Nur der Admin darf diesen Befehl verwenden.");

    adminSessions[ctx.from.id] = true;
    ctx.reply("🧾 Du bist jetzt im Admin-Modus.\nVerwende `/data`, sende Änderungen oder `/exit`.");
  });

  bot.command("data", async (ctx) => {
    const username = (ctx.from.username || "").toLowerCase();
    if (username !== ADMIN_USERNAME)
      return ctx.reply("🚫 Nur der Admin darf diesen Befehl verwenden.");
    const textData = loadTextData(customerName);
    ctx.reply(`📋 Aktuell gespeicherte Infos:\n\n${textData}`);
  });

  bot.on("text", async (ctx) => {
    const message = ctx.message.text.trim();
    const userId = ctx.from.id;
    const username = (ctx.from.username || "").toLowerCase();

    if (adminSessions[userId] && message.includes(":")) {
      saveTextData(customerName, message);
      return ctx.reply("✅ Infos gespeichert!");
    }

    if (adminSessions[userId] && message.toLowerCase() === "/exit") {
      delete adminSessions[userId];
      return ctx.reply("🚪 Admin-Modus beendet.");
    }

    const info = loadTextData(customerName);
    const prompt = `
Du bist der KI-Assistent von ${customerName}. Verwende nur folgende Infos:

${info}

Nutzerfrage: "${message}"
`;

    try {
      const gpt = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: prompt }],
        max_tokens: 200,
      });
      ctx.reply(gpt.choices[0].message.content.trim());
    } catch (err) {
      console.error("❌ GPT Fehler:", err);
      ctx.reply("⚠️ Entschuldigung, ich konnte das gerade nicht beantworten.");
    }
  });

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
  <style>
    body { font-family: Arial; margin: 40px; background: #f7f7f7; color:#333; }
    h1 { color:#222; }
    ul { list-style:none; padding:0; }
    li { background:#fff; margin:10px 0; padding:10px 15px; border-radius:8px; box-shadow:0 1px 3px rgba(0,0,0,0.1); }
    a { text-decoration:none; margin:0 5px; }
    button, input { padding:8px; border-radius:6px; border:1px solid #ccc; }
  </style>
  <h1>🧠 Kundenübersicht</h1>
  <ul>
    ${customers
      .map(
        (c) => `
      <li>
        <b>${c}</b> 
        ${pausedBots[c] ? "⏸️ (Pausiert)" : "🟢 (Aktiv)"}
        - <a href="/admin/view/${c}?pin=${currentPIN}">📄 Bearbeiten</a>
        - <a href="/admin/token/${c}?pin=${currentPIN}">🔑 Token</a>
        - ${
          pausedBots[c]
            ? `<a href="/admin/bot/resume/${c}?pin=${currentPIN}">▶️ Fortsetzen</a>`
            : `<a href="/admin/bot/pause/${c}?pin=${currentPIN}">⏸️ Pausieren</a>`
        }
      </li>`
      )
      .join("")}
  </ul>

  <hr/>
  <form method="post" action="/admin/new?pin=${currentPIN}">
    <h2>➕ Neuen Kunden hinzufügen</h2>
    <input name="name" placeholder="Kundenname" required />
    <input name="token" placeholder="Bot Token" required />
    <button type="submit">Erstellen</button>
  </form>

  <hr/>
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
  <style>
    body { font-family: Arial; margin: 40px; background: #f7f7f7; }
    textarea { width:100%; height:60vh; font-family: monospace; border-radius:8px; padding:10px; }
    button { margin-top:10px; padding:10px 15px; border-radius:8px; background:#007bff; color:#fff; border:none; cursor:pointer; }
    button:hover { background:#0056b3; }
    a { text-decoration:none; }
  </style>
  <h1>📄 Daten von ${customer}</h1>
  <form method="post" action="/admin/save/${customer}?pin=${currentPIN}">
    <textarea name="data">${info}</textarea><br/>
    <button type="submit">💾 Speichern</button>
  </form>
  <p><a href="/admin?pin=${currentPIN}">⬅️ Zurück zur Übersicht</a></p>
  `);
});

// === Kundendaten speichern ===
app.post("/admin/save/:customer", requirePIN, express.urlencoded({ extended: true }), (req, res) => {
  const { customer } = req.params;
  const { data } = req.body;
  saveTextData(customer, data);
  const currentPIN = loadAdminData().pin;
  res.send(`
    <h2>✅ Gespeichert!</h2>
    <a href="/admin/view/${customer}?pin=${currentPIN}">⬅️ Zurück</a>
  `);
});

// === Bot pausieren / fortsetzen ===
app.get("/admin/bot/pause/:customer", requirePIN, (req, res) => {
  const { customer } = req.params;
  stopCustomerBot(customer);
  pausedBots[customer] = true;
  res.redirect(`/admin?pin=${loadAdminData().pin}`);
});

app.get("/admin/bot/resume/:customer", requirePIN, (req, res) => {
  const { customer } = req.params;
  delete pausedBots[customer];
  initCustomerBot(customer);
  res.redirect(`/admin?pin=${loadAdminData().pin}`);
});

// === Token ändern ===
app.get("/admin/token/:customer", requirePIN, (req, res) => {
  const { customer } = req.params;
  const pin = loadAdminData().pin;
  const tokenPath = path.join(CUSTOMERS_DIR, customer, "token.txt");
  const currentToken = fs.existsSync(tokenPath)
    ? fs.readFileSync(tokenPath, "utf8").trim()
    : "(kein Token gefunden)";
  res.send(`
    <h1>🔑 Token für ${customer} ändern</h1>
    <p>Aktueller Token (gekürzt): ${currentToken.slice(0, 10)}...</p>
    <form method="post" action="/admin/token/${customer}?pin=${pin}">
      <input name="newToken" placeholder="Neuer Bot Token" required />
      <button type="submit">💾 Speichern & Bot neu starten</button>
    </form>
    <p><a href="/admin?pin=${pin}">⬅️ Zurück</a></p>
  `);
});

app.post("/admin/token/:customer", requirePIN, express.urlencoded({ extended: true }), (req, res) => {
  const { customer } = req.params;
  const { newToken } = req.body;
  const pin = loadAdminData().pin;

  fs.writeFileSync(path.join(CUSTOMERS_DIR, customer, "token.txt"), newToken, "utf8");
  stopCustomerBot(customer);
  initCustomerBot(customer);

  res.send(`
    <h2>✅ Token für ${customer} aktualisiert!</h2>
    <p>Der Bot wurde neu gestartet.</p>
    <a href="/admin?pin=${pin}">⬅️ Zurück zum Adminbereich</a>
  `);
});

// === Root ===
app.get("/", (req, res) => res.send("🤖 Multi-Kunden-Bot läuft!"));


// === Root ===
app.get("/", (req, res) => res.send("🤖 Multi-Kunden-Bot läuft!"));

// === Webhook-Eingang für Telegram-Bots ===
app.post("/bot/:customerId", express.json(), async (req, res) => {
  const { customerId } = req.params;
  const bot = bots[customerId];

  if (!bot) {
    console.error(`❌ Kein Bot gefunden für ${customerId}`);
    return res.sendStatus(404);
  }

  try {
    await bot.handleUpdate(req.body, res);
  } catch (err) {
    console.error(`⚠️ Fehler beim Verarbeiten des Updates von ${customerId}:`, err);
    res.sendStatus(500);
  }
});

// ✅ Test-Route im Browser für Webhook
app.get("/bot/:customerId", (req, res) => {
  res.send(`✅ Webhook aktiv für Bot: ${req.params.customerId}`);
});

// === Server starten ===
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`🌍 Server läuft auf Port ${PORT}`));










