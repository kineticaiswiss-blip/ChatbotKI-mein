// app.js — Vollversion: Accounts, Registrierung, Admins (device tokens), Multi-Kunden, Telegram-Bots
import express from "express";
import { Telegraf } from "telegraf";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import OpenAI from "openai";

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ---------------------------
// Pfade / Persistenz-Dateien
// ---------------------------
const DATA_DIR = "/data";
const CUSTOMERS_DIR = path.join(DATA_DIR, "customers");
const ADMIN_FILE = path.join(DATA_DIR, "admin.json");
const ACCOUNTS_FILE = path.join(DATA_DIR, "accounts.json");
const PAUSED_FILE = path.join(DATA_DIR, "paused.json");

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(CUSTOMERS_DIR)) fs.mkdirSync(CUSTOMERS_DIR, { recursive: true });

// ---------------------------
// Utility: safe read/write JSON
// ---------------------------
function readJSON(filePath, fallback = null) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (e) {
    console.error("JSON Read error", filePath, e);
    return fallback;
  }
}
function writeJSON(filePath, obj) {
  fs.writeFileSync(filePath, JSON.stringify(obj, null, 2), "utf8");
}

// ---------------------------
// Admin initialisieren
// ---------------------------
// Erste (primäre) Admin-IP — bleibt unveränderlich (wie du wolltest)
const FIRST_ADMIN_IP = "185.71.18.8";

function ensureAdminFile() {
  if (!fs.existsSync(ADMIN_FILE)) {
    writeJSON(ADMIN_FILE, {
      pin: null,
      adminIPs: [FIRST_ADMIN_IP], // primär
      lockedFirstAdmin: true,
      pendingRequests: [] // { id, name, company, phone, ip, ts }
    });
  }
}
ensureAdminFile();

function loadAdminData() {
  return readJSON(ADMIN_FILE, { pin: null, adminIPs: [FIRST_ADMIN_IP], lockedFirstAdmin: true, pendingRequests: [] });
}
function saveAdminData(d) {
  writeJSON(ADMIN_FILE, d);
}

// ---------------------------
// Accounts (users) management
// Accounts schema: {username, hash, salt, firstName, lastName, phone, company, role: 'pending'|'admin'|'customer', assignedCustomer:null, deviceTokens:[]}
// ---------------------------
function ensureAccountsFile() {
  if (!fs.existsSync(ACCOUNTS_FILE)) writeJSON(ACCOUNTS_FILE, []);
}
ensureAccountsFile();

function loadAccounts() {
  return readJSON(ACCOUNTS_FILE, []);
}
function saveAccounts(accounts) {
  writeJSON(ACCOUNTS_FILE, accounts);
}

function hashPassword(password, salt = null) {
  salt = salt || crypto.randomBytes(16).toString("hex");
  // scrypt for hashing
  const derived = crypto.scryptSync(password, salt, 64).toString("hex");
  return { salt, hash: derived };
}
function verifyPassword(password, salt, hash) {
  try {
    const check = crypto.scryptSync(password, salt, 64).toString("hex");
    return crypto.timingSafeEqual(Buffer.from(check, "hex"), Buffer.from(hash, "hex"));
  } catch {
    return false;
  }
}

// ---------------------------
// Paused bots persistence
// ---------------------------
let pausedBots = readJSON(PAUSED_FILE, {}) || {};
function savePausedBots() { writeJSON(PAUSED_FILE, pausedBots); }

// ---------------------------
// OpenAI setup
// ---------------------------
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ---------------------------
// Helper: client IP (X-Forwarded-For considered)
// ---------------------------
function getClientIp(req) {
  const xf = req.headers["x-forwarded-for"] || req.headers["x-forwarded-for".toLowerCase()];
  if (xf) return String(xf).split(",")[0].trim();
  // fallback to socket remote
  return (req.socket && req.socket.remoteAddress) || req.ip || "";
}

// ---------------------------
// Customer helpers (dirs & ips)
// ---------------------------
function ensureCustomerDir(cname) {
  const dir = path.join(CUSTOMERS_DIR, cname);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const info = path.join(dir, "info.txt");
  if (!fs.existsSync(info)) fs.writeFileSync(info, `Produkte:\nPreise:\nKontakt:\n`, "utf8");
  const ips = path.join(dir, "ips.json");
  if (!fs.existsSync(ips)) fs.writeFileSync(ips, JSON.stringify({ ips: [] }, null, 2), "utf8");
  const token = path.join(dir, "token.txt");
  if (!fs.existsSync(token)) fs.writeFileSync(token, "", "utf8");
}
function listCustomers() {
  if (!fs.existsSync(CUSTOMERS_DIR)) return [];
  return fs.readdirSync(CUSTOMERS_DIR).filter((d) => fs.statSync(path.join(CUSTOMERS_DIR, d)).isDirectory());
}
function loadCustomerInfo(c) {
  try { return fs.readFileSync(path.join(CUSTOMERS_DIR, c, "info.txt"), "utf8"); } catch { return ""; }
}
function saveCustomerInfo(c, txt) { fs.writeFileSync(path.join(CUSTOMERS_DIR, c, "info.txt"), txt, "utf8"); }
function getCustomerIPs(customer) {
  try { return JSON.parse(fs.readFileSync(path.join(CUSTOMERS_DIR, customer, "ips.json"), "utf8")).ips || []; } catch { return []; }
}
function addCustomerIP(customer, ip, label = "") {
  ensureCustomerDir(customer);
  const p = path.join(CUSTOMERS_DIR, customer, "ips.json");
  const data = readJSON(p, { ips: [] });
  data.ips = data.ips || [];
  if (!data.ips.find(x => x.ip === ip)) data.ips.push({ ip, label, added: Date.now() });
  writeJSON(p, data);
}
function removeCustomerIP(customer, ip) {
  const p = path.join(CUSTOMERS_DIR, customer, "ips.json");
  if (!fs.existsSync(p)) return;
  const data = readJSON(p, { ips: [] });
  data.ips = (data.ips || []).filter(x => x.ip !== ip);
  writeJSON(p, data);
}
function loadBotToken(customer) {
  const f = path.join(CUSTOMERS_DIR, customer, "token.txt");
  if (!fs.existsSync(f)) return null;
  return fs.readFileSync(f, "utf8").trim() || null;
}
function saveBotToken(customer, token) {
  ensureCustomerDir(customer);
  fs.writeFileSync(path.join(CUSTOMERS_DIR, customer, "token.txt"), token, "utf8");
}

// ---------------------------
// Telegram bots runtime
// ---------------------------
const bots = {}; // customerName => Telegraf instance

async function stopCustomerBot(customer) {
  if (bots[customer]) {
    try {
      // Telegraf.stop() may be sync or async depending on version
      await bots[customer].stop();
    } catch (e) {
      // ignore
    }
    delete bots[customer];
    console.log(`Bot ${customer} stopped`);
  }
}

async function initCustomerBot(customer) {
  // ensure directory exists
  ensureCustomerDir(customer);
  // stop existing
  await stopCustomerBot(customer);

  const token = loadBotToken(customer);
  if (!token) {
    console.log(`Kein Token für ${customer} – übersprungen`);
    return;
  }
  if (pausedBots[customer]) {
    console.log(`Bot ${customer} ist pausiert — nicht gestartet.`);
    return;
  }

  const bot = new Telegraf(token);
  const ADMIN_USERNAME = "laderakh".toLowerCase();
  const sessions = {};

  bot.start((ctx) => ctx.reply(`👋 Willkommen beim Chatbot von ${customer}!`));

  bot.command("businessinfo", (ctx) => {
    if ((ctx.from.username || "").toLowerCase() !== ADMIN_USERNAME) return ctx.reply("🚫 Nur Admin.");
    sessions[ctx.from.id] = true;
    ctx.reply("Admin-Modus aktiv. /data zeigt Infos. /exit zum Beenden.");
  });

  bot.command("data", (ctx) => {
    if ((ctx.from.username || "").toLowerCase() !== ADMIN_USERNAME) return ctx.reply("🚫 Nur Admin.");
    ctx.reply(`📋 Infos:\n\n${loadCustomerInfo(customer)}`);
  });

  bot.on("text", async (ctx) => {
    const msg = ctx.message.text.trim();
    const uid = ctx.from.id;
    if (sessions[uid] && msg.includes(":")) {
      saveCustomerInfo(customer, msg);
      return ctx.reply("✅ Infos gespeichert.");
    }
    if (sessions[uid] && msg.toLowerCase() === "/exit") {
      delete sessions[uid];
      return ctx.reply("✅ Admin-Modus beendet.");
    }

    // Use OpenAI to answer using only customer info
    const info = loadCustomerInfo(customer);
    const prompt = `Du bist der KI-Assistent von ${customer}. Verwende nur folgende Informationen:\n\n${info}\n\nNutzerfrage: "${msg}"`;

    try {
      const gpt = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: prompt }],
        max_tokens: 300,
      });
      const answer = gpt.choices[0].message.content.trim();
      ctx.reply(answer);
    } catch (err) {
      console.error("OpenAI error:", err);
      ctx.reply("⚠️ Fehler: konnte nicht antworten.");
    }
  });

  // set webhook or fallback to polling if webhook fails
  const RENDER_URL = process.env.RENDER_URL || process.env.PRIMARY_URL || "https://chatbotki-mein.onrender.com";
  try {
    await bot.telegram.setWebhook(`${RENDER_URL}/bot/${customer}`);
    app.use(`/bot/${customer}`, bot.webhookCallback(`/bot/${customer}`));
    console.log(`Webhook gesetzt für ${customer}`);
  } catch (e) {
    console.warn("Webhook konnte nicht gesetzt werden, starte Polling für", customer, e?.message || e);
    try {
      await bot.launch({ dropPendingUpdates: true });
    } catch (e2) {
      console.error("Polling start failed:", e2);
    }
  }

  bots[customer] = bot;
  console.log(`Bot init für ${customer} fertig.`);
}

// init bots for existing customers
listCustomers().forEach((c) => {
  ensureCustomerDir(c);
  initCustomerBot(c).catch((e) => console.error("init error", c, e));
});

// ---------------------------
// Simple cookie helpers (no extra dependency)
// ---------------------------
function parseCookies(req) {
  const header = req.headers?.cookie || "";
  const pairs = header.split(";").map(s => s.trim()).filter(Boolean);
  const obj = {};
  for (const p of pairs) {
    const idx = p.indexOf("=");
    if (idx > -1) obj[p.slice(0, idx)] = decodeURIComponent(p.slice(idx + 1));
  }
  return obj;
}
function setCookie(res, name, value, opts = {}) {
  let cookie = `${name}=${encodeURIComponent(value)}`;
  if (opts.maxAge) cookie += `; Max-Age=${opts.maxAge}`;
  if (opts.httpOnly) cookie += `; HttpOnly`;
  if (opts.path) cookie += `; Path=${opts.path}`;
  if (opts.sameSite) cookie += `; SameSite=${opts.sameSite}`;
  res.setHeader("Set-Cookie", cookie);
}

// ---------------------------
// Middleware: require authenticated user (account) or admin
// ---------------------------
function requireAuth(req, res, next) {
  const cookies = parseCookies(req);
  const token = cookies.deviceToken;
  if (!token) return res.redirect("/login");
  const accounts = loadAccounts();
  const acc = accounts.find(a => (a.deviceTokens || []).includes(token));
  if (!acc) return res.redirect("/login");
  req.user = acc;
  next();
}

function requireAdminOrDevice(req, res, next) {
  // Admins recognized by account role OR by primary admin IP
  const ip = getClientIp(req);
  const adminData = loadAdminData();
  const cookies = parseCookies(req);
  const token = cookies.deviceToken;
  const accounts = loadAccounts();
  const acc = accounts.find(a => (a.deviceTokens || []).includes(token));
  if (acc && acc.role === "admin") { req.user = acc; return next(); }
  if (adminData.adminIPs && adminData.adminIPs.includes(ip)) return next();
  // allow PIN as fallback
  const pin = req.query.pin || req.body.pin;
  if (pin && adminData.pin && pin === adminData.pin) return next();
  // else show login
  res.send(`<h2>🔐 Admin Zugang</h2>
    <p>Ihre IP: ${ip}</p>
    <p><a href="/login">Login</a> oder greife von registriertem Admin-Account zu.</p>`);
}

// ---------------------------
// Public: register / login / logout
// ---------------------------
app.get("/register", (req, res) => {
  res.send(`
    <h1>Registrierung</h1>
    <form method="post" action="/register">
      <input name="username" placeholder="Benutzername (einzigartig)" required /><br/>
      <input name="password" type="password" placeholder="Passwort" required /><br/>
      <input name="firstName" placeholder="Vorname" required /><br/>
      <input name="lastName" placeholder="Nachname" required /><br/>
      <input name="phone" placeholder="Private Handynummer" required /><br/>
      <input name="company" placeholder="Firma" /><br/>
      <button>Anfrage senden</button>
    </form>
  `);
});

app.post("/register", (req, res) => {
  const { username, password, firstName, lastName, phone, company } = req.body;
  if (!username || !password || !firstName || !lastName || !phone) return res.send("Bitte alle Pflichtfelder ausfüllen.");

  const accounts = loadAccounts();
  if (accounts.find(a => a.username === username)) return res.send("Benutzername bereits vergeben.");

  const { salt, hash } = hashPassword(password);
  const newAcc = {
    username,
    salt,
    hash,
    firstName,
    lastName,
    phone,
    company: company || "",
    role: "pending", // needs approval
    assignedCustomer: null,
    deviceTokens: []
  };
  accounts.push(newAcc);
  saveAccounts(accounts);

  // Add to admin pendingRequests for review (include ip)
  const ip = getClientIp(req);
  const admin = loadAdminData();
  admin.pendingRequests = admin.pendingRequests || [];
  admin.pendingRequests.push({
    id: crypto.randomBytes(6).toString("hex"),
    username,
    firstName,
    lastName,
    phone,
    company,
    ip,
    ts: Date.now()
  });
  saveAdminData(admin);

  res.send("✅ Registrierungsanfrage gesendet. Admin wird prüfen.");
});

app.get("/login", (req, res) => {
  res.send(`
    <h1>Login</h1>
    <form method="post" action="/login">
      <input name="username" placeholder="Benutzername" required /><br/>
      <input name="password" type="password" placeholder="Passwort" required /><br/>
      <button>Login</button>
    </form>
  `);
});

app.post("/login", (req, res) => {
  const { username, password } = req.body;
  const accounts = loadAccounts();
  const acc = accounts.find(a => a.username === username);
  if (!acc) return res.send("Benutzer nicht gefunden.");
  if (!verifyPassword(password, acc.salt, acc.hash)) return res.send("Ungültiges Passwort.");

  // create device token and set cookie
  const deviceToken = crypto.randomBytes(32).toString("hex");
  acc.deviceTokens = acc.deviceTokens || [];
  acc.deviceTokens.push(deviceToken);
  saveAccounts(accounts);

  setCookie(res, "deviceToken", deviceToken, { httpOnly: true, maxAge: 60 * 60 * 24 * 30, path: "/" });
  // redirect depending on role
  if (acc.role === "pending") return res.send("Account noch nicht freigeschaltet. Warte auf Admin.");
  if (acc.role === "admin") return res.redirect("/admin");
  if (acc.role === "customer" && acc.assignedCustomer) return res.redirect(`/customer/${acc.assignedCustomer}`);
  return res.redirect("/"); // fallback
});

app.get("/logout", (req, res) => {
  // clear cookie client-side
  setCookie(res, "deviceToken", "", { maxAge: 0, path: "/" });
  res.send("Abgemeldet. <a href='/'>Start</a>");
});

// ---------------------------
// Admin dashboard & approve/reject
// ---------------------------
app.get("/admin", requireAdminOrDevice, (req, res) => {
  const admin = loadAdminData();
  const accounts = loadAccounts();
  const customers = listCustomers();
  const ip = getClientIp(req);

  res.send(`
    <h1>Admin Dashboard</h1>
    <p>Angemeldet als IP: ${ip}</p>

    <h2>Pending Registrations</h2>
    <ul>
      ${ (admin.pendingRequests||[]).map((p,i) => `
        <li>${p.firstName} ${p.lastName} — ${p.company || "-"} — ${p.phone} — IP: ${p.ip}
           <br/>
           <a href="/admin/approve/${i}?pin=${admin.pin}">✅ Approve</a>
           <a href="/admin/reject/${i}?pin=${admin.pin}">❌ Reject</a>
        </li>`).join("") }
    </ul>

    <h2>Customers</h2>
    <ul>
      ${ customers.map(c => `<li>${c} - <a href="/admin/view/${c}">Bearbeiten</a> - <a href="/admin/token/${c}">Token</a> - Status: ${bots[c] ? "running" : (pausedBots[c] ? "paused" : "stopped")}</li>`).join("") }
    </ul>

    <h2>Accounts</h2>
    <ul>
      ${ accounts.map(a => `<li>${a.username} — ${a.role} ${a.assignedCustomer ? ` (customer: ${a.assignedCustomer})` : ""}</li>`).join("") }
    </ul>

    <h2>Admin IPs</h2>
    <ul>
      ${ (admin.adminIPs || []).map(i => `<li>${i}${i===FIRST_ADMIN_IP ? " (primär)" : ` - <a href="/admin/remove-admin-ip/${i}?pin=${admin.pin}">entfernen</a>`}</li>`).join("") }
    </ul>

    <hr/>
    <form method="post" action="/admin/new?pin=${admin.pin}">
      <h3>Neuen Kunden anlegen</h3>
      <input name="name" placeholder="kundenname" required />
      <input name="token" placeholder="Bot Token (optional)" />
      <button>Erstellen</button>
    </form>

    <p><a href='/logout'>Logout</a></p>
  `);
});

// approve flow
app.get("/admin/approve/:idx", requireAdminOrDevice, (req, res) => {
  const admin = loadAdminData();
  const idx = parseInt(req.params.idx);
  const reqObj = admin.pendingRequests?.[idx];
  if (!reqObj) return res.send("Nicht gefunden.");
  // show form to pick admin or customer and optionally choose customer name
  res.send(`
    <h2>Approve ${reqObj.firstName} ${reqObj.lastName}</h2>
    <form method="post" action="/admin/approve/${idx}?pin=${admin.pin}">
      <label><input type="radio" name="role" value="customer" checked /> Kunde</label>
      <label><input type="radio" name="role" value="admin" /> Admin</label><br/>
      <input name="customerName" placeholder="Kundenname (falls Kunde)" />
      <button>Bestätigen</button>
    </form>
  `);
});
app.post("/admin/approve/:idx", requireAdminOrDevice, (req, res) => {
  const admin = loadAdminData();
  const idx = parseInt(req.params.idx);
  const reqObj = admin.pendingRequests?.[idx];
  if (!reqObj) return res.send("Nicht gefunden.");
  const role = req.body.role || "customer";
  const accounts = loadAccounts();
  const acc = accounts.find(a => a.username === reqObj.username);
  if (!acc) return res.send("Account nicht gefunden.");

  if (role === "admin") {
    // mark account as admin
    acc.role = "admin";
    // create device token for this device (optional): if they are logging in later, they will get token
    // Add admin IP to admin.json? keep both: also add to adminIPs to allow IP-admin if desired
    const adminData = loadAdminData();
    if (!adminData.adminIPs.includes(reqObj.ip)) adminData.adminIPs.push(reqObj.ip);
    saveAdminData(adminData);
  } else {
    // create or assign customer
    const cname = (req.body.customerName || reqObj.company || reqObj.username || "kunde").toLowerCase().replace(/\s+/g, "-");
    ensureCustomerDir(cname);
    acc.role = "customer";
    acc.assignedCustomer = cname;
    // add requestor IP to customer's allowed ips
    addCustomerIP(cname, reqObj.ip, `${reqObj.firstName} ${reqObj.lastName}`);
    // try to init bot if token exists
    initCustomerBot(cname).catch(e => console.error("init bot after approve failed", e));
  }

  saveAccounts(accounts);
  // remove pending
  admin.pendingRequests.splice(idx, 1);
  saveAdminData(admin);
  res.send("✅ Genehmigt. <a href='/admin'>Zurück</a>");
});

app.get("/admin/reject/:idx", requireAdminOrDevice, (req, res) => {
  const admin = loadAdminData();
  const idx = parseInt(req.params.idx);
  if (!admin.pendingRequests?.[idx]) return res.send("Nicht gefunden.");
  admin.pendingRequests.splice(idx, 1);
  saveAdminData(admin);
  res.send("❌ Abgelehnt. <a href='/admin'>Zurück</a>");
});

// remove admin-ip (except primary)
app.get("/admin/remove-admin-ip/:ip", requireAdminOrDevice, (req, res) => {
  const ip = req.params.ip;
  if (ip === FIRST_ADMIN_IP) return res.send("Primäre IP kann nicht entfernt werden.");
  const admin = loadAdminData();
  admin.adminIPs = (admin.adminIPs || []).filter(x => x !== ip);
  saveAdminData(admin);
  res.redirect("/admin");
});

// create customer manually
app.post("/admin/new", requireAdminOrDevice, (req, res) => {
  const { name, token } = req.body;
  const cname = name.toLowerCase().replace(/\s+/g, "-");
  const dir = path.join(CUSTOMERS_DIR, cname);
  if (fs.existsSync(dir)) return res.send("Kunde existiert bereits.");
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, "info.txt"), `Produkte:\nPreise:\nKontakt:\n`, "utf8");
  writeJSON(path.join(dir, "ips.json"), { ips: [] });
  if (token) saveBotToken(cname, token);
  initCustomerBot(cname).catch(e => console.error("init failed", e));
  res.redirect("/admin");
});

// ---------------------------
// Customer admin view (edit info, manage ips, token, pause)
// only accessible to admins (or device-based admin accounts)
// ---------------------------
app.get("/admin/view/:customer", requireAdminOrDevice, (req, res) => {
  const customer = req.params.customer;
  if (!fs.existsSync(path.join(CUSTOMERS_DIR, customer))) return res.send("Kunde nicht vorhanden.");
  const info = loadCustomerInfo(customer) || "";
  const ips = getCustomerIPs(customer);
  const admin = loadAdminData();
  res.send(`
    <h1>Bearbeite ${customer}</h1>
    <form method="post" action="/admin/save/${customer}?pin=${admin.pin}">
      <textarea name="data" rows="20" cols="80">${info}</textarea><br/>
      <button>Speichern</button>
    </form>

    <h3>Zugelassene IPs</h3>
    <ul>
      ${ ips.map(i => `<li>${i.ip} ${i.label?`(${i.label})`: ''} - <a href="/admin/remove-customer-ip/${customer}/${i.ip}?pin=${admin.pin}">entfernen</a></li>`).join("") }
    </ul>

    <form method="post" action="/admin/add-customer-ip/${customer}?pin=${admin.pin}">
      <input name="ip" placeholder="IP-Adresse" required />
      <input name="label" placeholder="Label (z.B. Handy)" />
      <button>Hinzufügen</button>
    </form>

    <h3>Bot Steuerung</h3>
    <p>Status: ${bots[customer] ? "läuft" : (pausedBots[customer] ? "pausiert" : "gestoppt")}</p>
    <a href="/admin/bot/pause/${customer}?pin=${admin.pin}">Pause</a> | <a href="/admin/bot/resume/${customer}?pin=${admin.pin}">Resume</a>
    <h4>Token</h4>
    <form method="post" action="/admin/token/${customer}?pin=${admin.pin}">
      <input name="newToken" placeholder="Neuer Bot Token (wenn ändern)" />
      <button>Speichern & Neustart</button>
    </form>

    <p><a href="/admin">Zurück</a></p>
  `);
});
app.post("/admin/save/:customer", requireAdminOrDevice, (req, res) => {
  const customer = req.params.customer;
  const data = req.body.data || "";
  saveCustomerInfo(customer, data);
  res.redirect(`/admin/view/${customer}`);
});
app.post("/admin/add-customer-ip/:customer", requireAdminOrDevice, (req, res) => {
  const { ip, label } = req.body;
  addCustomerIP(req.params.customer, ip.trim(), label || "");
  res.redirect(`/admin/view/${req.params.customer}`);
});
app.get("/admin/remove-customer-ip/:customer/:ip", requireAdminOrDevice, (req, res) => {
  removeCustomerIP(req.params.customer, req.params.ip);
  res.redirect(`/admin/view/${req.params.customer}`);
});

// token update
app.post("/admin/token/:customer", requireAdminOrDevice, (req, res) => {
  const customer = req.params.customer;
  const newToken = req.body.newToken || "";
  if (newToken) saveBotToken(customer, newToken);
  // restart bot
  stopCustomerBot(customer).catch(()=>{});
  initCustomerBot(customer).catch(e => console.error("init after token", e));
  res.redirect(`/admin/view/${customer}`);
});

// pause/resume
app.get("/admin/bot/pause/:customer", requireAdminOrDevice, (req, res) => {
  pausedBots[req.params.customer] = true;
  savePausedBots();
  stopCustomerBot(req.params.customer).catch(()=>{});
  res.redirect("/admin");
});
app.get("/admin/bot/resume/:customer", requireAdminOrDevice, (req, res) => {
  delete pausedBots[req.params.customer];
  savePausedBots();
  initCustomerBot(req.params.customer).catch(e => console.error("resume failed", e));
  res.redirect("/admin");
});

// ---------------------------
// Customer-facing dashboard (only their assigned bot)
// - must log in with account
// - only can edit their own info (limited)
// ---------------------------
app.get("/customer/:customer", requireAuth, (req, res) => {
  const customer = req.params.customer;
  // check assigned
  const acc = req.user;
  if (acc.role === "customer" && acc.assignedCustomer === customer) {
    const info = loadCustomerInfo(customer);
    res.send(`
      <h1>Dashboard ${customer}</h1>
      <p>Willkommen ${acc.firstName} ${acc.lastName}</p>
      <h3>Infos (du kannst diese ändern)</h3>
      <form method="post" action="/customer/${customer}/save">
        <textarea name="data" rows="15" cols="80">${info}</textarea><br/>
        <button>Speichern</button>
      </form>
      <p><a href="/logout">Logout</a></p>
    `);
  } else {
    res.status(403).send("Zugriff verweigert.");
  }
});
app.post("/customer/:customer/save", requireAuth, (req, res) => {
  const customer = req.params.customer;
  const acc = req.user;
  if (acc.role === "customer" && acc.assignedCustomer === customer) {
    saveCustomerInfo(customer, req.body.data || "");
    res.redirect(`/customer/${customer}`);
  } else {
    res.status(403).send("Zugriff verweigert.");
  }
});

// ---------------------------
// Webhook endpoint for Telegram (POST from Telegram)
// ---------------------------
app.post("/bot/:customerId", express.json(), async (req, res) => {
  const { customerId } = req.params;
  const bot = bots[customerId];
  if (!bot) {
    console.error("Kein Bot für", customerId);
    return res.sendStatus(404);
  }
  try {
    await bot.handleUpdate(req.body, res);
  } catch (err) {
    console.error("Fehler beim Verarbeiten des Telegram-Updates:", err);
    res.sendStatus(500);
  }
});

// simple test GET for webhook (browser)
app.get("/bot/:customerId", (req, res) => {
  res.send(`Webhook test for ${req.params.customerId}`);
});

// ---------------------------
// Root page
// ---------------------------
app.get("/", (req, res) => {
  res.send(`<h1>🤖 Multi-Kunden-Bot Platform</h1>
    <p><a href="/register">Registrieren</a> | <a href="/login">Login</a> | <a href="/admin">Admin</a></p>`);
});

// ---------------------------
// Start Server
// ---------------------------
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Server läuft auf Port ${PORT}`));






