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
const PAUSED_FILE = path.join(DATA_DIR, "paused.json");

// Ordner sicherstellen
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(CUSTOMERS_DIR)) fs.mkdirSync(CUSTOMERS_DIR, { recursive: true });

// === Admin-Persistenz ===
const FIRST_ADMIN_IP = "185.71.18.8";

function ensureAdminFile() {
  if (!fs.existsSync(ADMIN_FILE)) {
    const initial = {
      pin: null,
      adminIPs: [FIRST_ADMIN_IP],
      lockedFirstAdmin: true,
      pendingRequests: []
    };
    fs.writeFileSync(ADMIN_FILE, JSON.stringify(initial, null, 2), "utf8");
  }
}
ensureAdminFile();

function loadAdminData() {
  try {
    return JSON.parse(fs.readFileSync(ADMIN_FILE, "utf8"));
  } catch {
    return { pin: null, adminIPs: [FIRST_ADMIN_IP], lockedFirstAdmin: true, pendingRequests: [] };
  }
}
function saveAdminData(d) {
  fs.writeFileSync(ADMIN_FILE, JSON.stringify(d, null, 2), "utf8");
}

// === Paused Bots persistieren ===
let pausedBots = fs.existsSync(PAUSED_FILE)
  ? JSON.parse(fs.readFileSync(PAUSED_FILE, "utf8"))
  : {};

function savePausedBots() {
  fs.writeFileSync(PAUSED_FILE, JSON.stringify(pausedBots, null, 2), "utf8");
}

// === OpenAI Setup ===
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// === Helper Functions ===
function getClientIp(req) {
  const xf = req.headers["x-forwarded-for"];
  if (xf) return String(xf).split(",")[0].trim();
  return req.ip || req.connection?.remoteAddress || "";
}

function loadCustomerList() {
  if (!fs.existsSync(CUSTOMERS_DIR)) return [];
  return fs.readdirSync(CUSTOMERS_DIR)
    .filter((d) => fs.statSync(path.join(CUSTOMERS_DIR, d)).isDirectory());
}

function ensureCustomerDir(c) {
  const dir = path.join(CUSTOMERS_DIR, c);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  if (!fs.existsSync(path.join(dir, "info.txt")))
    fs.writeFileSync(path.join(dir, "info.txt"), `Produkte:\nPreise:\nKontakt:\n`, "utf8");

  if (!fs.existsSync(path.join(dir, "ips.json")))
    fs.writeFileSync(path.join(dir, "ips.json"), JSON.stringify({ ips: [] }, null, 2), "utf8");
}

function loadTextData(c) {
  try {
    return fs.readFileSync(path.join(CUSTOMERS_DIR, c, "info.txt"), "utf8");
  } catch {
    return "Noch keine Informationen vorhanden.";
  }
}

function saveTextData(c, text) {
  const dir = path.join(CUSTOMERS_DIR, c);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "info.txt"), text, "utf8");
}

function loadBotToken(c) {
  const p = path.join(CUSTOMERS_DIR, c, "token.txt");
  if (fs.existsSync(p)) return fs.readFileSync(p, "utf8").trim();
  return null;
}

function saveBotToken(c, token) {
  const dir = path.join(CUSTOMERS_DIR, c);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "token.txt"), token, "utf8");
}

function getCustomerIPs(customer) {
  try {
    return JSON.parse(fs.readFileSync(path.join(CUSTOMERS_DIR, customer, "ips.json"), "utf8")).ips || [];
  } catch {
    return [];
  }
}

function addCustomerIP(customer, ip, label = "") {
  ensureCustomerDir(customer);
  const ipsPath = path.join(CUSTOMERS_DIR, customer, "ips.json");
  const data = JSON.parse(fs.readFileSync(ipsPath, "utf8"));
  if (!data.ips.find((x) => x.ip === ip)) {
    data.ips.push({ ip, label, added: Date.now() });
    fs.writeFileSync(ipsPath, JSON.stringify(data, null, 2), "utf8");
  }
}

// === Bots runtime ===
const bots = {};

// Stop bot (safe)
function stopCustomerBot(customer) {
  if (bots[customer]) {
    try {
      bots[customer].stop();
      delete bots[customer];
      console.log(`⏹️ Bot für ${customer} gestoppt.`);
    } catch (e) {
      console.log("Fehler beim Stoppen:", e);
    }
  }
}

// INIT CUSTOMER BOT
// INIT CUSTOMER BOT — stabiler mit Pause/Resume und Polling-Fallback
// === INIT CUSTOMER BOT (nur Polling) ===
async function initCustomerBot(customer) {
  const token = loadBotToken(customer);
  if (!token) return console.log(`⚠️ Kein Token für ${customer}`);
  if (pausedBots[customer]) return console.log(`⏸️ Bot ${customer} ist pausiert.`);

  const bot = new Telegraf(token);
  const ADMIN_USERNAME = "laderakh".toLowerCase();
  const sessions = {};

  // Start-Nachricht
  bot.start((ctx) =>
    ctx.reply(`👋 Willkommen beim Chatbot von ${customer}! Wie kann ich helfen?`)
  );

  // Admin-Kommandos
  bot.command("businessinfo", (ctx) => {
    if ((ctx.from.username || "").toLowerCase() !== ADMIN_USERNAME)
      return ctx.reply("🚫 Nur Admin.");
    sessions[ctx.from.id] = true;
    ctx.reply("Admin-Modus aktiv. Nutze /data oder sende Änderungen. /exit zum Beenden.");
  });

  bot.command("data", (ctx) => {
    if ((ctx.from.username || "").toLowerCase() !== ADMIN_USERNAME)
      return ctx.reply("🚫 Nur Admin.");
    ctx.reply(`📋 Infos:\n\n${loadTextData(customer)}`);
  });

  // Textnachrichten (GPT-Antwort)
  bot.on("text", async (ctx) => {
    const msg = ctx.message.text.trim();
    const uid = ctx.from.id;

    if (sessions[uid] && msg.includes(":")) {
      saveTextData(customer, msg);
      return ctx.reply("✔️ Gespeichert!");
    }
    if (sessions[uid] && msg.toLowerCase() === "/exit") {
      delete sessions[uid];
      return ctx.reply("Admin-Modus beendet.");
    }

    const prompt = `Du bist der KI-Assistent von ${customer}.
Infos:
${loadTextData(customer)}

Frage: "${msg}"`;

    try {
      const gpt = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: prompt }],
      });

      ctx.reply(gpt.choices[0].message.content.trim());
    } catch (err) {
      console.log("GPT Fehler:", err);
      ctx.reply("⚠️ Fehler beim Verarbeiten der Anfrage.");
    }
  });

  // Nur Polling, kein Webhook
  try {
    await bot.launch(); // Polling starten
    bots[customer] = bot;
    console.log(`🤖 Bot gestartet: ${customer} (Polling)`);
  } catch (e) {
    console.error(`Bot für ${customer} konnte nicht gestartet werden:`, e.message);
  }
}


// === Admin Middleware ===
function requireAdmin(req, res, next) {
  const admin = loadAdminData();
  const ip = getClientIp(req);

  if (admin.adminIPs.includes(ip)) return next();

  const pin = req.query.pin || req.body.pin;
  if (pin && admin.pin && pin === admin.pin) return next();

  res.send(`<h2>🔐 Admin Login</h2>
    <form method="get">
      <input name="pin" type="password" placeholder="PIN"/>
      <button>Login</button>
    </form>`);
}

// === Bot Status Helper ===
function getBotStatus(customer) {
  if (pausedBots[customer]) return "⏸️ pausiert";
  if (bots[customer]) return "✅ läuft";
  return "❌ nicht gestartet";
}

// === Admin Dashboard ===
app.get("/admin", requireAdmin, (req, res) => {
  const admin = loadAdminData();
  const customers = loadCustomerList();
  const ip = getClientIp(req);

  res.send(`
    <h1>🧾 Admin Dashboard</h1>
    <p>Angemeldet als IP: ${ip}</p>

    <h2>🔔 Pending Requests</h2>
    <ul>
      ${(admin.pendingRequests || [])
        .map(
          (p, i) =>
            `<li>${p.name}/${p.company || "-"} - 
              <a href="/admin/pending/approve/${i}?pin=${admin.pin}">✅</a> 
              <a href="/admin/pending/reject/${i}?pin=${admin.pin}">❌</a>
            </li>`
        )
        .join("")}
    </ul>

    <h2>👥 Kunden</h2>
    <ul>
      ${customers
        .map(
          (c) =>
            `<li>${c} - Status: ${getBotStatus(c)} - 
              <a href="/admin/view/${c}?pin=${admin.pin}">Bearbeiten</a> - 
              <a href="/admin/token/${c}?pin=${admin.pin}">Token</a> - 
              ${
                pausedBots[c]
                  ? `<a href="/admin/bot/resume/${c}?pin=${admin.pin}">▶️ Resume</a>`
                  : `<a href="/admin/bot/pause/${c}?pin=${admin.pin}">⏸️ Pause</a>`
              }
            </li>`
        )
        .join("")}
    </ul>

    <h2>🔑 Admin IPs</h2>
    <ul>
      ${admin.adminIPs
        .map(
          (i) =>
            `<li>${i}${
              i === FIRST_ADMIN_IP ? " (primär)" : ` - <a href='/admin/remove-admin-ip/${i}?pin=${admin.pin}'>entfernen</a>`
            }</li>`
        )
        .join("")}
    </ul>

    <hr/>
    <form method="post" action="/admin/new?pin=${admin.pin}">
      <h3>➕ Neuen Kunden anlegen</h3>
      <input name="name" placeholder="Kundenname" required/>
      <input name="token" placeholder="Bot Token"/>
      <button>Speichern</button>
    </form>
  `);
});

// === Pending Approve / Reject ===
app.get("/admin/pending/approve/:idx", requireAdmin, (req, res) => {
  const admin = loadAdminData();
  const idx = parseInt(req.params.idx);
  const reqObj = admin.pendingRequests[idx];
  if (!reqObj) return res.send("Nicht gefunden");

  res.send(`
    <h2>Approve ${reqObj.name}</h2>
    <form method="post" action="/admin/pending/approve/${idx}?pin=${admin.pin}">
      <label><input type="radio" name="role" value="customer" checked /> Kunde</label>
      <label><input type="radio" name="role" value="admin" /> Admin</label><br/>
      <input name="customerName" placeholder="Kundenname falls Kunde"/>
      <button type="submit">Bestätigen</button>
    </form>
  `);
});

app.post(
  "/admin/pending/approve/:idx",
  requireAdmin,
  express.urlencoded({ extended: true }),
  (req, res) => {
    const idx = parseInt(req.params.idx);
    const admin = loadAdminData();
    const reqObj = admin.pendingRequests[idx];
    if (!reqObj) return res.send("Nicht gefunden");

    const role = req.body.role || "customer";

    if (role === "admin") {
      if (!admin.adminIPs.includes(reqObj.ip)) admin.adminIPs.push(reqObj.ip);
    } else {
      const cname = (req.body.customerName || reqObj.company || reqObj.name || "kunde")
        .toLowerCase()
        .replace(/\s+/g, "-");
      const dir = path.join(CUSTOMERS_DIR, cname);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir);
        fs.writeFileSync(path.join(dir, "info.txt"), `Produkte:\nPreise:\nKontakt:\n`, "utf8");
      }
      addCustomerIP(cname, reqObj.ip, reqObj.name || "");
      initCustomerBot(cname);
    }

    admin.pendingRequests.splice(idx, 1);
    saveAdminData(admin);
    res.send(`✅ Genehmigt. <a href='/admin?pin=${admin.pin}'>Zurück</a>`);
  }
);

app.get("/admin/pending/reject/:idx", requireAdmin, (req, res) => {
  const idx = parseInt(req.params.idx);
  const admin = loadAdminData();
  if (!admin.pendingRequests[idx]) return res.send("Nicht gefunden");
  admin.pendingRequests.splice(idx, 1);
  saveAdminData(admin);
  res.send(`❌ Abgelehnt. <a href='/admin?pin=${admin.pin}'>Zurück</a>`);
});

// === Customer edit ===
app.get("/admin/view/:customer", requireAdmin, (req, res) => {
  const customer = req.params.customer;
  const info = loadTextData(customer);
  const ips = getCustomerIPs(customer);
  const admin = loadAdminData();

  res.send(`
    <h1>${customer}</h1>
    <form method="post" action="/admin/save/${customer}?pin=${admin.pin}">
      <textarea name="data" rows="20" cols="80">${info}</textarea><br/>
      <button>💾 Speichern</button>
    </form>

    <h3>Zugelassene IPs</h3>
    <ul>
      ${ips
        .map(
          (i) =>
            `<li>${i.ip} ${i.label ? "(" + i.label + ")" : ""} - 
               <a href="/admin/remove-customer-ip/${customer}/${i.ip}?pin=${admin.pin}">entfernen</a>
            </li>`
        )
        .join("")}
    </ul>

    <form method="post" action="/admin/add-customer-ip/${customer}?pin=${admin.pin}">
      <input name="ip" placeholder="IP" required/>
      <input name="label" placeholder="Label"/>
      <button>Hinzufügen</button>
    </form>

    <a href="/admin?pin=${admin.pin}">⬅️ Zurück</a>
  `);
});

app.post(
  "/admin/save/:customer",
  requireAdmin,
  express.urlencoded({ extended: true }),
  (req, res) => {
    saveTextData(req.params.customer, req.body.data || "");
    res.redirect(`/admin/view/${req.params.customer}?pin=${loadAdminData().pin}`);
  }
);

app.post(
  "/admin/add-customer-ip/:customer",
  requireAdmin,
  express.urlencoded({ extended: true }),
  (req, res) => {
    addCustomerIP(req.params.customer, req.body.ip.trim(), req.body.label || "");
    savePausedBots();
    res.redirect(`/admin/view/${req.params.customer}?pin=${loadAdminData().pin}`);
  }
);

app.get("/admin/remove-customer-ip/:customer/:ip", requireAdmin, (req, res) => {
  const ipsPath = path.join(CUSTOMERS_DIR, req.params.customer, "ips.json");
  if (fs.existsSync(ipsPath)) {
    const data = JSON.parse(fs.readFileSync(ipsPath, "utf8"));
    data.ips = (data.ips || []).filter((x) => x.ip !== req.params.ip);
    fs.writeFileSync(ipsPath, JSON.stringify(data, null, 2), "utf8");
  }
  res.redirect(`/admin/view/${req.params.customer}?pin=${loadAdminData().pin}`);
});

// === Token Update ===
app.get("/admin/token/:customer", requireAdmin, (req, res) => {
  const customer = req.params.customer;
  const tokenPath = path.join(CUSTOMERS_DIR, customer, "token.txt");
  const currentToken = fs.existsSync(tokenPath) ? fs.readFileSync(tokenPath, "utf8") : "(kein Token)";

  res.send(`
    <h2>Token für ${customer}</h2>
    <form method="post" action="/admin/token/${customer}?pin=${loadAdminData().pin}">
      <input name="newToken" placeholder="Neuer Token" required/>
      <button>Speichern & Neustart</button>
    </form>
    <p>Aktuell: ${currentToken}</p>
  `);
});

app.post(
  "/admin/token/:customer",
  requireAdmin,
  express.urlencoded({ extended: true }),
  (req, res) => {
    const { customer } = req.params;
    saveBotToken(customer, req.body.newToken);
    stopCustomerBot(customer);
    initCustomerBot(customer);
    res.redirect(`/admin?pin=${loadAdminData().pin}`);
  }
);

// === Pause / Resume Bot ===
app.get("/admin/bot/pause/:customer", requireAdmin, (req, res) => {
  pausedBots[req.params.customer] = true;
  stopCustomerBot(req.params.customer);
  savePausedBots();
  res.redirect(`/admin?pin=${loadAdminData().pin}`);
});

app.get("/admin/bot/resume/:customer", requireAdmin, (req, res) => {
  delete pausedBots[req.params.customer];
  initCustomerBot(req.params.customer);
  savePausedBots();
  res.redirect(`/admin?pin=${loadAdminData().pin}`);
});

// === Root & Registration ===
app.get("/", (req, res) =>
  res.send(`<h1>🤖 Multi-Kunden-Bot</h1>
    <p><a href="/register">Registrieren</a></p>
    <p><a href="/admin">Admin</a></p>`)
);

app.get("/register", (req, res) => {
  const ip = getClientIp(req);
  res.send(`
    <form method="post" action="/register">
      <input name="name" placeholder="Name" required/>
      <input name="company" placeholder="Firma"/>
      <input name="email" placeholder="E-Mail"/>
      <input name="note" placeholder="Bemerkung"/>
      <input type="hidden" name="ip" value="${ip}"/>
      <button>Anfrage senden</button>
    </form>
  `);
});

app.post("/register", express.urlencoded({ extended: true }), (req, res) => {
  const { name, company, email, note } = req.body;
  const ip = getClientIp(req);
  const admin = loadAdminData();
  admin.pendingRequests.push({ name, company, email, note, ip, ts: Date.now() });
  saveAdminData(admin);
  res.send("✅ Anfrage gesendet. <a href='/'>Zurück</a>");
});

// === Server Start ===
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`✅ Server läuft auf Port ${PORT}`));










