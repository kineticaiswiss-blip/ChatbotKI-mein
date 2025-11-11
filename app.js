// app.js — Multi-Kunden Admin + Registration + IP-basiertes Admin-System
import express from "express";
import { Telegraf } from "telegraf";
import fs from "fs";
import path from "path";
import OpenAI from "openai";

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// === Verzeichnisstruktur ===
const DATA_DIR = "/data";
const CUSTOMERS_DIR = path.join(DATA_DIR, "customers");
const ADMIN_FILE = path.join(DATA_DIR, "admin.json");

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(CUSTOMERS_DIR)) fs.mkdirSync(CUSTOMERS_DIR, { recursive: true });

// === Default admin data (wird persistent in admin.json) ===
// Wichtig: Die erste Admin-IP ist für immer festgelegt (deine IP).
const FIRST_ADMIN_IP = "185.71.18.8";

function ensureAdminFile() {
  if (!fs.existsSync(ADMIN_FILE)) {
    const initial = {
      pin: null, // optional pin-login
      adminIPs: [FIRST_ADMIN_IP], // erste Admin IP (fixed)
      lockedFirstAdmin: true, // verhindert Löschen der ersten admin ip
      pendingRequests: [], // {name, company, email, ip, ts}
    };
    fs.writeFileSync(ADMIN_FILE, JSON.stringify(initial, null, 2), "utf8");
  }
}
ensureAdminFile();

function loadAdminData() {
  try {
    return JSON.parse(fs.readFileSync(ADMIN_FILE, "utf8"));
  } catch (e) {
    return { pin: null, adminIPs: [FIRST_ADMIN_IP], lockedFirstAdmin: true, pendingRequests: [] };
  }
}
function saveAdminData(d) {
  fs.writeFileSync(ADMIN_FILE, JSON.stringify(d, null, 2), "utf8");
}

// === OpenAI Setup ===
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// === Helper: get client's IP (respect X-Forwarded-For) ===
function getClientIp(req) {
  const xf = req.headers["x-forwarded-for"];
  if (xf) return String(xf).split(",")[0].trim();
  return req.ip || req.connection?.remoteAddress || "";
}

// === Customer file helpers ===
function loadCustomerList() {
  return fs.existsSync(CUSTOMERS_DIR)
    ? fs.readdirSync(CUSTOMERS_DIR).filter((d) => fs.statSync(path.join(CUSTOMERS_DIR, d)).isDirectory())
    : [];
}
function loadTextData(customer) {
  const p = path.join(CUSTOMERS_DIR, customer, "info.txt");
  try { return fs.readFileSync(p, "utf8").trim(); } catch { return "Noch keine Informationen vorhanden."; }
}
function saveTextData(customer, text) {
  const dir = path.join(CUSTOMERS_DIR, customer);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "info.txt"), text, "utf8");
}
function loadBotToken(customer) {
  const t = path.join(CUSTOMERS_DIR, customer, "token.txt");
  if (fs.existsSync(t)) return fs.readFileSync(t, "utf8").trim();
  return null;
}
function saveBotToken(customer, token) {
  const dir = path.join(CUSTOMERS_DIR, customer);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "token.txt"), token, "utf8");
}
function ensureCustomerDir(customer) {
  const dir = path.join(CUSTOMERS_DIR, customer);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const info = path.join(dir, "info.txt");
  if (!fs.existsSync(info)) fs.writeFileSync(info, `Produkte:\nPreise:\nKontakt:\n`, "utf8");
  const ips = path.join(dir, "ips.json");
  if (!fs.existsSync(ips)) fs.writeFileSync(ips, JSON.stringify({ ips: [] }, null, 2), "utf8");
}
function addCustomerIP(customer, ip, label = "") {
  ensureCustomerDir(customer);
  const ipsPath = path.join(CUSTOMERS_DIR, customer, "ips.json");
  const data = JSON.parse(fs.readFileSync(ipsPath, "utf8"));
  data.ips = data.ips || [];
  if (!data.ips.find((x) => x.ip === ip)) data.ips.push({ ip, label, added: Date.now() });
  fs.writeFileSync(ipsPath, JSON.stringify(data, null, 2), "utf8");
}
function getCustomerIPs(customer) {
  try { return JSON.parse(fs.readFileSync(path.join(CUSTOMERS_DIR, customer, "ips.json"), "utf8")).ips || []; }
  catch { return []; }
}

// === Bots runtime ===
const bots = {};
const pausedBots = {};

// stop bot (safely)
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

// init bot for customer (webhook config uses /bot/:customer)
function initCustomerBot(customerName) {
  const token = loadBotToken(customerName);
  if (!token) {
    console.warn(`⚠️ Kein Token für ${customerName} — Bot wird übersprungen.`);
    return;
  }
  if (pausedBots[customerName]) {
    console.log(`⏸️ Bot ${customerName} pausiert — nicht starten.`);
    return;
  }

  const bot = new Telegraf(token);
  const ADMIN_USERNAME = "laderakh".toLowerCase();
  const adminSessions = {};

  bot.start((ctx) => ctx.reply(`👋 Willkommen beim Chatbot von ${customerName}! Wie kann ich helfen?`));

  bot.command("businessinfo", async (ctx) => {
    const username = (ctx.from.username || "").toLowerCase();
    if (username !== ADMIN_USERNAME) return ctx.reply("🚫 Nur der Admin darf diesen Befehl verwenden.");
    adminSessions[ctx.from.id] = true;
    ctx.reply("🧾 Admin-Modus: `/data` zum Anzeigen, sende Änderungen oder `/exit`.");
  });

  bot.command("data", async (ctx) => {
    const username = (ctx.from.username || "").toLowerCase();
    if (username !== ADMIN_USERNAME) return ctx.reply("🚫 Nur der Admin darf diesen Befehl verwenden.");
    const text = loadTextData(customerName);
    ctx.reply(`📋 Aktuelle Infos:\n\n${text}`);
  });

  bot.on("text", async (ctx) => {
    const message = ctx.message.text.trim();
    const userId = ctx.from.id;
    // admin text save
    if (adminSessions[userId] && message.includes(":")) {
      saveTextData(customerName, message);
      return ctx.reply("✅ Infos gespeichert!");
    }
    if (adminSessions[userId] && message.toLowerCase() === "/exit") {
      delete adminSessions[userId];
      return ctx.reply("✅ Admin-Modus beendet.");
    }

    // GPT-assisted reply using customer's info only
    const info = loadTextData(customerName);
    const prompt = `
Du bist der KI-Assistent von ${customerName}. Verwende nur diese Infos:

${info}

Nutzerfrage: "${message}"
    `;
    try {
      const gpt = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: prompt }],
        max_tokens: 250,
      });
      ctx.reply(gpt.choices[0].message.content.trim());
    } catch (err) {
      console.error("GPT Fehler:", err);
      ctx.reply("⚠️ Entschuldigung, ich konnte das gerade nicht beantworten.");
    }
  });

  // set webhook to /bot/:customerName
  const RENDER_URL = process.env.RENDER_URL || process.env.PRIMARY_URL || "https://chatbotki-mein.onrender.com";
  try {
    bot.telegram.setWebhook(`${RENDER_URL}/bot/${customerName}`);
  } catch (e) {
    console.warn("Webhook setzen evtl. fehlgeschlagen (kann sein, wenn bereits gesetzt):", e?.message || e);
  }
  app.use(`/bot/${customerName}`, bot.webhookCallback(`/bot/${customerName}`));

  bots[customerName] = bot;
  console.log(`🤖 Bot für ${customerName} gestartet.`);
}

// Initialize existing customers
loadCustomerList().forEach((c) => {
  ensureCustomerDir(c);
  initCustomerBot(c);
});

// === Middleware: admin check by IP or PIN ===
function requireAdmin(req, res, next) {
  const adminData = loadAdminData();
  const ip = getClientIp(req);
  if (adminData.adminIPs && adminData.adminIPs.includes(ip)) return next();
  const pin = req.query.pin || req.body.pin;
  if (pin && adminData.pin && pin === adminData.pin) return next();
  // else show PIN/login or forbidden
  res.send(`
    <h2>🔐 Admin Login</h2>
    <p>Your IP: ${ip}</p>
    <form method="get" action="${req.path}">
      <input name="pin" type="password" placeholder="Admin PIN" required />
      <button>Login</button>
    </form>
    <p>Oder greife von einer registrierten Admin-IP zu.</p>
  `);
}

// === Registration form & submit ===
app.get("/register", (req, res) => {
  const ip = getClientIp(req);
  res.send(`
    <h1>📝 Registrierung</h1>
    <form method="post" action="/register">
      <input name="name" placeholder="Dein Name" required /><br/>
      <input name="company" placeholder="Firma (optional)" /><br/>
      <input name="email" placeholder="E-Mail" /><br/>
      <input name="note" placeholder="Bemerkung" /><br/>
      <input type="hidden" name="ip" value="${ip}" />
      <button type="submit">Anfrage senden</button>
    </form>
    <p>Ihre IP: ${ip}</p>
  `);
});

app.post("/register", (req, res) => {
  const { name, company, email, note } = req.body;
  const ip = getClientIp(req);
  const admin = loadAdminData();
  admin.pendingRequests = admin.pendingRequests || [];
  admin.pendingRequests.push({ name, company, email, note, ip, ts: Date.now() });
  saveAdminData(admin);
  res.send(`<h2>Danke — Anfrage eingegangen.</h2><p>Admin wird benachrichtigt.</p>`);
});

// === Admin dashboard (show pending requests, customers, manage) ===
app.get("/admin", requireAdmin, (req, res) => {
  const admin = loadAdminData();
  const customers = loadCustomerList();
  const ip = getClientIp(req);

  res.send(`
    <h1>🧾 Admin Dashboard</h1>
    <p>Angemeldet als IP: ${ip}</p>

    <h2>🔔 Pending Requests</h2>
    <ul>
      ${ (admin.pendingRequests || []).map((p, idx) => `
        <li>
          <b>${p.name}</b> / ${p.company || "-"} / ${p.email || "-"} / IP: ${p.ip}
          <br/> <a href="/admin/pending/approve/${idx}?pin=${admin.pin}">✅ Approve</a>
               <a href="/admin/pending/reject/${idx}?pin=${admin.pin}">❌ Reject</a>
        </li>`).join("") }
    </ul>

    <h2>👥 Kunden</h2>
    <ul>
      ${customers.map(c => `<li>${c} - <a href="/admin/view/${c}?pin=${admin.pin}">Bearbeiten</a> - <a href="/admin/token/${c}?pin=${admin.pin}">Token</a></li>`).join("")}
    </ul>

    <h2>🔑 Admin IPs</h2>
    <ul>
      ${(admin.adminIPs || []).map(ip => `<li>${ip}${ip===FIRST_ADMIN_IP ? " (primär, unveränderlich)" : ` - <a href="/admin/remove-admin-ip/${ip}?pin=${admin.pin}">entfernen</a>`}</li>`).join("")}
    </ul>

    <hr/>
    <form method="post" action="/admin/new?pin=${admin.pin}">
      <h3>➕ Neuen Kunden manuell anlegen</h3>
      <input name="name" placeholder="Kundenname" required />
      <input name="token" placeholder="Bot Token (optional)" />
      <button type="submit">Anlegen</button>
    </form>

    <p><a href="/">Zurück zur Startseite</a></p>
  `);
});

// Approve pending request — choose role (admin or customer)
app.get("/admin/pending/approve/:idx", requireAdmin, (req, res) => {
  const idx = parseInt(req.params.idx);
  const admin = loadAdminData();
  const reqObj = admin.pendingRequests?.[idx];
  if (!reqObj) return res.send("Nicht gefunden.");
  // simple page: pick admin or customer and optionally customer name
  res.send(`
    <h2>Approve ${reqObj.name} (IP: ${reqObj.ip})</h2>
    <form method="post" action="/admin/pending/approve/${idx}?pin=${admin.pin}">
      <label><input type="radio" name="role" value="customer" checked /> Kunde</label>
      <label><input type="radio" name="role" value="admin" /> Admin</label><br/>
      <div>
        <input name="customerName" placeholder="Kundenname (falls Kunde)" />
      </div>
      <button type="submit">Bestätigen</button>
    </form>
    <p><a href="/admin?pin=${admin.pin}">Zurück</a></p>
  `);
});
app.post("/admin/pending/approve/:idx", requireAdmin, express.urlencoded({ extended: true }), (req, res) => {
  const idx = parseInt(req.params.idx);
  const admin = loadAdminData();
  const reqObj = admin.pendingRequests?.[idx];
  if (!reqObj) return res.send("Nicht gefunden.");
  const role = req.body.role || "customer";
  const ip = reqObj.ip;

  if (role === "admin") {
    admin.adminIPs = admin.adminIPs || [];
    if (!admin.adminIPs.includes(ip)) admin.adminIPs.push(ip);
    saveAdminData(admin);
  } else {
    // create or assign to customer
    const nameRaw = (req.body.customerName || reqObj.company || reqObj.name || "kunde").toLowerCase().replace(/\s+/g, "-");
    const customerDir = path.join(CUSTOMERS_DIR, nameRaw);
    if (!fs.existsSync(customerDir)) {
      fs.mkdirSync(customerDir);
      fs.writeFileSync(path.join(customerDir, "info.txt"), `Produkte:\nPreise:\nKontakt:\n`, "utf8");
    }
    addCustomerIP(nameRaw, ip, reqObj.name || "");
  }

  // remove pending
  admin.pendingRequests.splice(idx, 1);
  saveAdminData(admin);
  res.send(`<h2>✅ Genehmigt!</h2><p><a href="/admin?pin=${admin.pin}">Zurück</a></p>`);
});

app.get("/admin/pending/reject/:idx", requireAdmin, (req, res) => {
  const idx = parseInt(req.params.idx);
  const admin = loadAdminData();
  if (!admin.pendingRequests?.[idx]) return res.send("Nicht gefunden.");
  admin.pendingRequests.splice(idx, 1);
  saveAdminData(admin);
  res.send(`<h2>❌ Abgelehnt.</h2><p><a href="/admin?pin=${admin.pin}">Zurück</a></p>`);
});

// remove admin ip (except first locked one)
app.get("/admin/remove-admin-ip/:ip", requireAdmin, (req, res) => {
  const ip = req.params.ip;
  const admin = loadAdminData();
  if (ip === FIRST_ADMIN_IP) return res.send("Diese IP kann nicht entfernt werden.");
  admin.adminIPs = (admin.adminIPs || []).filter((x) => x !== ip);
  saveAdminData(admin);
  res.redirect(`/admin?pin=${admin.pin}`);
});

// create customer manually
app.post("/admin/new", requireAdmin, (req, res) => {
  const { name, token } = req.body;
  const cname = name.toLowerCase().replace(/\s+/g, "-");
  const dir = path.join(CUSTOMERS_DIR, cname);
  if (fs.existsSync(dir)) return res.send("❌ Kunde existiert bereits.");
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, "info.txt"), `Produkte:\nPreise:\nKontakt:\n`, "utf8");
  fs.writeFileSync(path.join(dir, "ips.json"), JSON.stringify({ ips: [] }, null, 2), "utf8");
  if (token) fs.writeFileSync(path.join(dir, "token.txt"), token, "utf8");
  initCustomerBot(cname);
  const admin = loadAdminData();
  res.send(`✅ Kunde ${cname} angelegt. <a href="/admin?pin=${admin.pin}">Zurück</a>`);
});

// === Customer detail / edit (admin) ===
app.get("/admin/view/:customer", requireAdmin, (req, res) => {
  const { customer } = req.params;
  const info = loadTextData(customer);
  const ips = getCustomerIPs(customer);
  const admin = loadAdminData();

  res.send(`
    <h1>📄 ${customer}</h1>
    <form method="post" action="/admin/save/${customer}?pin=${admin.pin}">
      <textarea name="data" rows="20" cols="80">${info}</textarea><br/>
      <button type="submit">💾 Speichern</button>
    </form>

    <h3>Zugelassene IPs für diesen Kunden</h3>
    <ul>
      ${ips.map(i => `<li>${i.ip} ${i.label ? `(${i.label})` : ""} - <a href="/admin/remove-customer-ip/${customer}/${i.ip}?pin=${admin.pin}">entfernen</a></li>`).join("")}
    </ul>

    <form method="post" action="/admin/add-customer-ip/${customer}?pin=${admin.pin}">
      <h4>IP hinzufügen</h4>
      <input name="ip" placeholder="IP-Adresse" required />
      <input name="label" placeholder="Label (z.B. Handy)"/>
      <button type="submit">Hinzufügen</button>
    </form>

    <p><a href="/admin?pin=${admin.pin}">⬅️ Zurück</a></p>
  `);
});
app.post("/admin/save/:customer", requireAdmin, express.urlencoded({ extended: true }), (req, res) => {
  const { customer } = req.params;
  const data = req.body.data || "";
  saveTextData(customer, data);
  const admin = loadAdminData();
  res.send(`<h2>✅ Gespeichert</h2><a href="/admin/view/${customer}?pin=${admin.pin}">Zurück</a>`);
});
app.post("/admin/add-customer-ip/:customer", requireAdmin, (req, res) => {
  const { customer } = req.params;
  const { ip, label } = req.body;
  addCustomerIP(customer, ip.trim(), label || "");
  res.redirect(`/admin/view/${customer}?pin=${loadAdminData().pin}`);
});
app.get("/admin/remove-customer-ip/:customer/:ip", requireAdmin, (req, res) => {
  const { customer, ip } = req.params;
  const ipsPath = path.join(CUSTOMERS_DIR, customer, "ips.json");
  if (fs.existsSync(ipsPath)) {
    const data = JSON.parse(fs.readFileSync(ipsPath, "utf8"));
    data.ips = (data.ips || []).filter((x) => x.ip !== ip);
    fs.writeFileSync(ipsPath, JSON.stringify(data, null, 2), "utf8");
  }
  res.redirect(`/admin/view/${customer}?pin=${loadAdminData().pin}`);
});

// === Token change UI ===
app.get("/admin/token/:customer", requireAdmin, (req, res) => {
  const { customer } = req.params;
  const tokenPath = path.join(CUSTOMERS_DIR, customer, "token.txt");
  const currentToken = fs.existsSync(tokenPath) ? fs.readFileSync(tokenPath, "utf8").trim() : "(kein Token)";
  res.send(`
    <h2>Token für ${customer}</h2>
    <p>Aktuell (gekürzt): ${currentToken.slice(0, 10)}...</p>
    <form method="post" action="/admin/token/${customer}?pin=${loadAdminData().pin}">
      <input name="newToken" placeholder="Neuer Bot Token" required />
      <button type="submit">Speichern & neu starten</button>
    </form>
    <p><a href="/admin?pin=${loadAdminData().pin}">Zurück</a></p>
  `);
});
app.post("/admin/token/:customer", requireAdmin, express.urlencoded({ extended: true }), (req, res) => {
  const { customer } = req.params;
  const { newToken } = req.body;
  saveBotToken(customer, newToken);
  stopCustomerBot(customer);
  initCustomerBot(customer);
  res.send(`<h2>✅ Token aktualisiert und Bot neu gestartet.</h2><a href="/admin?pin=${loadAdminData().pin}">Zurück</a>`);
});

// === Bot pause/resume endpoints handled in /admin view links above
app.get("/admin/bot/pause/:customer", requireAdmin, (req, res) => {
  const { customer } = req.params;
  stopCustomerBot(customer);
  pausedBots[customer] = true;
  res.redirect(`/admin?pin=${loadAdminData().pin}`);
});
app.get("/admin/bot/resume/:customer", requireAdmin, (req, res) => {
  const { customer } = req.params;
  delete pausedBots[customer];
  initCustomerBot(customer);
  res.redirect(`/admin?pin=${loadAdminData().pin}`);
});

// === Webhook test GET and POST (Telegram will POST to /bot/:customerId) ===
app.get("/bot/:customerId", (req, res) => {
  res.send(`✅ Webhook test for: ${req.params.customerId}`);
});
app.post("/bot/:customerId", express.json(), async (req, res) => {
  const { customerId } = req.params;
  const bot = bots[customerId];
  if (!bot) {
    console.error(`Kein Bot gefunden: ${customerId}`);
    return res.sendStatus(404);
  }
  try {
    await bot.handleUpdate(req.body, res);
  } catch (err) {
    console.error("Fehler beim Verarbeiten:", err);
    res.sendStatus(500);
  }
});

// === Root & start ===
app.get("/", (req, res) => res.send(`<h1>🤖 Multi-Kunden-Bot läuft</h1><p><a href="/register">Registrieren</a></p><p><a href="/admin">Admin</a></p>`));

// === Kunden-Dashboard (nur eigene Daten) ===
app.get("/customer/:customer", (req, res) => {
  const { customer } = req.params;
  const ip = req.headers["x-forwarded-for"]?.split(",")[0] || req.socket.remoteAddress;

  // Admin darf alles
  const adminData = loadAdminData();
  const isAdminIP = adminData.mainAdminIP === ip;

  // Prüfe, ob Kunde existiert
  const customerDir = path.join(CUSTOMERS_DIR, customer);
  if (!fs.existsSync(customerDir)) {
    return res.status(404).send("<h2>❌ Kunde nicht gefunden.</h2>");
  }

  // Prüfe, ob IP erlaubt
  const allowedIPFile = path.join(customerDir, "allowed_ips.json");
  let allowedIPs = [];
  if (fs.existsSync(allowedIPFile)) {
    allowedIPs = JSON.parse(fs.readFileSync(allowedIPFile, "utf8"));
  }

    if (!isAdminIP && !allowedIPs.includes(ip)) {
    return res.status(403).send(`<h2>🚫 Zugriff verweigert</h2><p>Ihre IP (${ip}) ist nicht berechtigt.</p>`);
  }

  // Kunde darf eigene Daten sehen
  const info = loadTextData(customer);
  res.send(`
    <h1>🏢 Kunden-Dashboard: ${customer}</h1>
    <pre>${info}</pre>
    <p>Ihre IP: ${ip}</p>
    <p><a href="/">Zurück</a></p>
  `);
});

// === Server starten ===
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`✅ Server läuft auf Port ${PORT}`));











