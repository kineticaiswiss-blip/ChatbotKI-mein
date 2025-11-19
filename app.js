// app.js — Komplett überarbeitet
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
// Config / Pfade
// ---------------------------
const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), "data");
const CUSTOMERS_DIR = path.join(DATA_DIR, "customers");
const ADMIN_FILE = path.join(DATA_DIR, "admin.json");
const ACCOUNTS_FILE = path.join(DATA_DIR, "accounts.json");
const PAUSED_FILE = path.join(DATA_DIR, "paused.json");

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(CUSTOMERS_DIR)) fs.mkdirSync(CUSTOMERS_DIR, { recursive: true });

// ---------------------------
// Helpers: JSON read/write
// ---------------------------
function readJSON(filePath, fallback = null) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (e) { console.error("JSON read error:", filePath, e); return fallback; }
}
function writeJSON(filePath, obj) { fs.writeFileSync(filePath, JSON.stringify(obj, null, 2), "utf8"); }

// ---------------------------
// PIN/Password hashing
// ---------------------------
function hashPassword(password, salt = null) {
  salt = salt || crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(String(password), salt, 64).toString("hex");
  return { salt, hash };
}
function verifyPassword(password, salt, hash) {
  try {
    const check = crypto.scryptSync(String(password), salt, 64).toString("hex");
    // timingSafeEqual expects buffers of same length
    return crypto.timingSafeEqual(Buffer.from(check, "hex"), Buffer.from(hash, "hex"));
  } catch (e) {
    return false;
  }
}
function randomToken(len = 40) {
  return crypto.randomBytes(Math.ceil(len/2)).toString("hex").slice(0, len);
}
function randomPassword() {
  return crypto.randomBytes(6).toString("base64").replace(/[+/=]/g, "").slice(0, 10);
}

// ---------------------------
// Admin file ensure/load/save
// ---------------------------
const FIRST_ADMIN_IP = process.env.FIRST_ADMIN_IP || "185.71.18.8";
function ensureAdminFile() {
  if (!fs.existsSync(ADMIN_FILE)) {
    writeJSON(ADMIN_FILE, { pin: null, adminIPs: [FIRST_ADMIN_IP], lockedFirstAdmin: true, pendingRequests: [] });
  }
}
ensureAdminFile();
function loadAdminData() { return readJSON(ADMIN_FILE, { pin: null, adminIPs: [FIRST_ADMIN_IP], lockedFirstAdmin: true, pendingRequests: [] }); }
function saveAdminData(d) { writeJSON(ADMIN_FILE, d); }

// ---------------------------
// Accounts ensure/load/save
// ---------------------------
function ensureAccountsFile() { if (!fs.existsSync(ACCOUNTS_FILE)) writeJSON(ACCOUNTS_FILE, []); }
ensureAccountsFile();
function loadAccounts() { return readJSON(ACCOUNTS_FILE, []); }
function saveAccounts(accounts) { writeJSON(ACCOUNTS_FILE, accounts); }

// ---------------------------
// Paused bots
// ---------------------------
let pausedBots = readJSON(PAUSED_FILE, {}) || {};
function savePausedBots() { writeJSON(PAUSED_FILE, pausedBots); }

// ---------------------------
// OpenAI (optional) — falls vorhanden
// ---------------------------
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ---------------------------
// Client IP helper
// ---------------------------
function getClientIp(req) {
  const xf = req.headers["x-forwarded-for"] || req.headers["X-Forwarded-For"];
  if (xf) return String(xf).split(",")[0].trim();
  return (req.socket && req.socket.remoteAddress) || req.ip || "";
}

// ---------------------------
// Customer helpers (directory per customer)
// ---------------------------
function sanitizeCustomerName(name) {
  return String(name || "")
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9\-]/g, "")
    .replace(/^\-+|\-+$/g, "")
    .slice(0, 50);
}
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
function listCustomers() { return fs.existsSync(CUSTOMERS_DIR) ? fs.readdirSync(CUSTOMERS_DIR).filter(d => fs.statSync(path.join(CUSTOMERS_DIR, d)).isDirectory()) : []; }
function loadCustomerInfo(c) { try { return fs.readFileSync(path.join(CUSTOMERS_DIR, c, "info.txt"), "utf8"); } catch { return ""; } }
function saveCustomerInfo(c, txt) { ensureCustomerDir(c); fs.writeFileSync(path.join(CUSTOMERS_DIR, c, "info.txt"), txt, "utf8"); }
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
function saveBotToken(customer, token) { ensureCustomerDir(customer); fs.writeFileSync(path.join(CUSTOMERS_DIR, customer, "token.txt"), token, "utf8"); }

// ---------------------------
// Telegram bots management
// ---------------------------
const bots = {}; // customer -> Telegraf instance

async function stopCustomerBot(customer) {
  if (bots[customer]) {
    try { await bots[customer].stop(); } catch (e) { console.warn("stop bot error", customer, e); }
    delete bots[customer];
  }
}

async function initCustomerBot(customer) {
  ensureCustomerDir(customer);
  await stopCustomerBot(customer);
  const token = loadBotToken(customer);
  console.log(`initCustomerBot(${customer}) — token present: ${!!token}, paused: ${!!pausedBots[customer]}`);
  if (!token || pausedBots[customer]) {
    console.log(`Skipping bot start for ${customer} (token present: ${!!token}, paused: ${!!pausedBots[customer]})`);
    return;
  }

  const bot = new Telegraf(token);

  function refreshAdminSets() {
    const accounts = loadAccounts();
    // Admins who either are global admin (isGlobalAdmin true) OR belong to this customer via customers array
    const adminUsernames = accounts.filter(a => a.role === "admin" && (a.isGlobalAdmin || (a.customers||[]).includes(customer)) && a.username).map(a => (a.username||"").toLowerCase());
    const adminTelegramIds = accounts.filter(a => a.role === "admin" && (a.isGlobalAdmin || (a.customers||[]).includes(customer)) && a.telegramId).map(a => Number(a.telegramId));
    return { adminUsernames, adminTelegramIds };
  }

  let adminSets = refreshAdminSets();

  function isBotAdmin(ctx) {
    const uname = (ctx.from.username||"").toLowerCase();
    const id = Number(ctx.from.id);
    adminSets = refreshAdminSets(); // refresh from disk on each check
    return adminSets.adminUsernames.includes(uname) || adminSets.adminTelegramIds.includes(id);
  }

  bot.start(ctx => ctx.reply(`👋 Willkommen beim Chatbot von ${customer}!`));

  // allow admins to link telegram account with a device token: "/link <deviceToken>"
  bot.command("link", ctx => {
    const parts = (ctx.message.text||"").split(" ").map(p=>p.trim()).filter(Boolean);
    if(parts.length < 2) return ctx.reply("Nutze: /link <deviceToken>");
    const tokenToLink = parts[1];
    const accounts = loadAccounts();
    const acc = accounts.find(a => (a.deviceTokens||[]).includes(tokenToLink));
    if(!acc) return ctx.reply("Kein Account mit diesem Device-Token gefunden.");
    acc.telegramId = ctx.from.id;
    if(!acc.username && ctx.from.username) acc.username = ctx.from.username;
    saveAccounts(accounts);
    ctx.reply("✅ Telegram verknüpft mit Account. Falls dein Account Admin ist, bist du jetzt Bot-Admin.");
  });

  bot.command("businessinfo", ctx => {
    if (!isBotAdmin(ctx)) return ctx.reply("🚫 Nur Admin.");
    ctx.reply("Admin-Modus aktiv. /data zeigt Infos. /exit zum Beenden.");
  });

  bot.command("data", ctx => {
    if (!isBotAdmin(ctx)) return ctx.reply("🚫 Nur Admin.");
    ctx.reply(`📋 Infos:\n\n${loadCustomerInfo(customer)}`);
  });

  bot.on("text", async ctx => {
    try {
      const msg = ctx.message.text.trim();
      const uid = ctx.from.id;

      // simple session: allow admins to write "FIELD: VALUE" to update info while in admin session
      // We'll use telegram account linking as primary; sessions per telegram id here are temporary
      // For simplicity: if admin sends "update: <txt>" we store as info
      if (msg.toLowerCase().startsWith("update:") && isBotAdmin(ctx)) {
        const newInfo = msg.slice("update:".length).trim();
        saveCustomerInfo(customer, newInfo);
        return ctx.reply("✅ Infos gespeichert.");
      }

      // If OpenAI is configured, use it; otherwise fallback to info text
      const info = loadCustomerInfo(customer);
      if (process.env.OPENAI_API_KEY) {
        const messages = [
          { role: "system", content: `Du bist der KI-Assistent von ${customer}. Antworte nur mit Informationen aus diesem Info-Block. Wenn die Antwort nicht vorhanden ist, sage: "Das weiß ich nicht."`},
          { role: "user", content: `INFO:\n${info}\n\nFrage: ${msg}` }
        ];
        try {
          const gpt = await openai.chat.completions.create({
            model: "gpt-4o-mini",
            messages,
            max_tokens: 300,
            temperature: 0
          });
          const answer = gpt.choices[0].message.content.trim();
          return ctx.reply(answer);
        } catch (err) {
          console.error("OpenAI error:", err);
          // fallthrough to simple answer
        }
      }

      // fallback: answer from info block (very simple)
      const lines = info.split("\n").filter(Boolean);
      const match = lines.find(l => l.toLowerCase().includes(msg.toLowerCase().split(" ")[0]));
      if (match) return ctx.reply(match);
      return ctx.reply("Das weiß ich nicht.");
    } catch (err) {
      console.error("Bot text handling error:", err);
      ctx.reply("⚠️ Fehler: konnte nicht antworten.");
    }
  });

  // Webhook or polling fallback
  const RENDER_URL = process.env.RENDER_URL || process.env.PRIMARY_URL || "https://chatbotki-mein.onrender.com";
  try {
    await bot.telegram.setWebhook(`${RENDER_URL}/bot/${customer}`);
    console.log(`Webhook gesetzt für ${customer}`);
  } catch (e) {
    console.log(`Webhook konnte nicht gesetzt werden (${customer}), starte Polling. Fehler:`, e && e.message ? e.message.toString() : e);
    try {
      await bot.launch({ dropPendingUpdates: true });
      console.log(`Bot launched polling für ${customer}`);
    } catch (errLaunch) {
      console.error(`Bot launch Fehler für ${customer}:`, errLaunch);
    }
  }

  bots[customer] = bot;
}

// init existing customers
listCustomers().forEach(c => { initCustomerBot(c).catch(()=>{}); });

// ---------------------------
// Cookie helpers
// ---------------------------
function parseCookies(req) {
  const header = req.headers?.cookie || "";
  const obj = {};
  header.split(";").map(s=>s.trim()).filter(Boolean).forEach(p=>{
    const idx = p.indexOf("="); if(idx>-1) obj[p.slice(0,idx)] = decodeURIComponent(p.slice(idx+1));
  });
  return obj;
}
function setCookie(res,name,value,opts={}) {
  let cookie = `${name}=${encodeURIComponent(value)}`;
  if(opts.maxAge) cookie+=`; Max-Age=${opts.maxAge}`;
  if(opts.httpOnly) cookie+=`; HttpOnly`;
  if(opts.path) cookie+=`; Path=${opts.path}`;
  if(opts.secure || process.env.NODE_ENV==="production") cookie+=`; Secure`;
  cookie+=`; SameSite=${opts.sameSite||'Lax'}`;
  res.setHeader("Set-Cookie", cookie);
}

// ---------------------------
// Auth middleware
// ---------------------------
function requireAuth(req,res,next){
  const cookies = parseCookies(req);
  const token = cookies.deviceToken || req.headers["x-device-token"];
  if(!token) return res.redirect("/login");
  const accounts = loadAccounts();
  const acc = accounts.find(a=> (a.deviceTokens||[]).includes(token));
  if(!acc) return res.redirect("/login");
  req.user = acc;
  next();
}

function requireAdminOrDevice(req,res,next){
  const ip = getClientIp(req);
  const adminData = loadAdminData();
  const cookies = parseCookies(req);
  const token = cookies.deviceToken || req.headers["x-device-token"];
  const accounts = loadAccounts();
  const acc = accounts.find(a=> (a.deviceTokens||[]).includes(token));
  if(acc && acc.role==="admin"){ req.user=acc; return next(); }
  if(adminData.adminIPs && adminData.adminIPs.includes(ip)) return next();

  const pinInput = req.query.pin || req.body.pin;
  if(pinInput && adminData.pin){
    // support hashed or plain
    if(typeof adminData.pin === "object" && adminData.pin.salt && adminData.pin.hash){
      if(verifyPassword(String(pinInput), adminData.pin.salt, adminData.pin.hash)) return next();
    } else {
      if(String(pinInput) === String(adminData.pin)) return next();
    }
  }

  res.send(`<h2>🔐 Admin Zugang</h2><p>Ihre IP: ${ip}</p><p><a href="/login">Login</a> oder greife von registriertem Admin-Account zu.</p>`);
}

// ---------------------------
// Public routes: register/login/logout
// ---------------------------
app.get("/", (req,res)=>{
  res.redirect("/dashboard");
});

// simple register form
app.get("/register", (req,res)=>{
  res.send(`
  <!doctype html><html><head>
    <meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
    <script src="https://cdn.tailwindcss.com"></script>
    <title>Register</title></head><body class="bg-gray-50 p-6">
    <div class="max-w-lg mx-auto bg-white p-6 rounded shadow">
      <h1 class="text-2xl font-bold mb-4">Registrieren</h1>
      <form method="POST" action="/register">
        <label class="block mb-2">Benutzername<input name="username" required class="border p-2 w-full"/></label>
        <label class="block mb-2">Passwort<input name="password" type="password" required class="border p-2 w-full"/></label>
        <label class="block mb-2">Kunde (optional)<input name="customer" class="border p-2 w-full" placeholder="kunden-name"/></label>
        <button class="bg-blue-600 text-white px-4 py-2 rounded">Registrieren</button>
      </form>
      <p class="mt-4"><a href="/login" class="text-blue-600">Login</a></p>
    </div>
  </body></html>
  `);
});

app.post("/register", (req,res)=>{
  const { username, password, customer } = req.body;
  if(!username || !password) return res.status(400).send("username & password required");
  const accounts = loadAccounts();
  if(accounts.find(a=>a.username && a.username.toLowerCase()===String(username).toLowerCase())) {
    return res.status(400).send("Benutzer existiert bereits");
  }
  const { salt, hash } = hashPassword(password);
  const deviceToken = randomToken(40);
  const newAcc = {
    id: crypto.randomUUID(),
    username,
    salt,
    hash,
    role: "user", // default
    deviceTokens: [deviceToken],
    customers: customer ? [sanitizeCustomerName(customer)] : [],
    createdAt: Date.now()
  };
  accounts.push(newAcc);
  saveAccounts(accounts);
  // ensure customer dir if provided
  if(customer) ensureCustomerDir(sanitizeCustomerName(customer));
  setCookie(res, "deviceToken", deviceToken, { httpOnly: true, path: "/" , maxAge: 60*60*24*30});
  res.send(`<p>Registrierung erfolgreich. Du bist eingeloggt. <a href="/dashboard">Dashboard</a></p>`);
});

// login
app.get("/login", (req,res)=>{
  res.send(`
  <!doctype html><html><head>
    <meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
    <script src="https://cdn.tailwindcss.com"></script>
    <title>Login</title></head><body class="bg-gray-50 p-6">
    <div class="max-w-md mx-auto bg-white p-6 rounded shadow">
      <h1 class="text-2xl font-bold mb-4">Login</h1>
      <form method="POST" action="/login">
        <label class="block mb-2">Benutzername<input name="username" required class="border p-2 w-full"/></label>
        <label class="block mb-2">Passwort<input name="password" type="password" required class="border p-2 w-full"/></label>
        <button class="bg-green-600 text-white px-4 py-2 rounded">Login</button>
      </form>
      <p class="mt-4"><a href="/register" class="text-blue-600">Registrieren</a></p>
    </div>
  </body></html>
  `);
});

app.post("/login", (req,res)=>{
  const { username, password } = req.body;
  const accounts = loadAccounts();
  const acc = accounts.find(a=> a.username && a.username.toLowerCase() === String(username).toLowerCase());
  if(!acc) return res.status(401).send("Ungültig");
  // support hashed storage
  if(acc.salt && acc.hash){
    if(!verifyPassword(password, acc.salt, acc.hash)) return res.status(401).send("Ungültig");
  } else {
    if(String(password) !== String(acc.password)) return res.status(401).send("Ungültig");
  }
  // create new device token and set cookie
  const token = randomToken(40);
  acc.deviceTokens = acc.deviceTokens || [];
  acc.deviceTokens.push(token);
  saveAccounts(accounts);
  setCookie(res, "deviceToken", token, { httpOnly: true, path: "/", maxAge: 60*60*24*30 });
  res.redirect("/dashboard");
});

app.post("/logout", (req,res)=>{
  const cookies = parseCookies(req);
  const token = cookies.deviceToken || req.headers["x-device-token"];
  if(token) {
    const accounts = loadAccounts();
    const acc = accounts.find(a => (a.deviceTokens||[]).includes(token));
    if(acc){
      acc.deviceTokens = (acc.deviceTokens||[]).filter(t => t !== token);
      saveAccounts(accounts);
    }
  }
  setCookie(res, "deviceToken", "", { path: "/", maxAge: 0 });
  res.redirect("/login");
});

// ---------------------------
// Dashboard (single page with tabs) — requires auth
// ---------------------------
app.get("/dashboard", requireAuth, (req,res)=>{
  const user = req.user;
  const customers = listCustomers();
  const accounts = loadAccounts();
  const adminData = loadAdminData();
  const paused = pausedBots;

  // Build simple HTML dashboard with Tailwind
  res.send(`
  <!doctype html><html><head>
    <meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
    <script src="https://cdn.tailwindcss.com"></script>
    <title>Dashboard</title></head><body class="bg-gray-50 p-6 text-sm">
    <div class="max-w-6xl mx-auto">
      <div class="flex justify-between items-center mb-6">
        <h1 class="text-2xl font-bold">Dashboard — ${user.username}</h1>
        <form method="POST" action="/logout"><button class="bg-red-600 text-white px-3 py-1 rounded">Logout</button></form>
      </div>

      <div class="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div class="col-span-2 bg-white p-4 rounded shadow">
          <div class="mb-4">
            <nav class="flex gap-2">
              <a href="#accounts" class="px-3 py-1 bg-gray-100 rounded">Accounts</a>
              <a href="#customers" class="px-3 py-1 bg-gray-100 rounded">Customers</a>
              <a href="#bots" class="px-3 py-1 bg-gray-100 rounded">Bots</a>
              <a href="#requests" class="px-3 py-1 bg-gray-100 rounded">Requests</a>
            </nav>
          </div>

          <!-- Accounts -->
          <section id="accounts" class="mb-6">
            <h2 class="font-semibold text-lg mb-2">Accounts</h2>
            <table class="w-full text-left border-collapse">
              <thead><tr class="text-xs text-gray-600"><th>User</th><th>Role</th><th>Customers</th><th>Actions</th></tr></thead>
              <tbody>
                ${accounts.map(a=>`
                  <tr class="border-t">
                    <td class="py-2">${a.username || "(no name)"}</td>
                    <td class="py-2">${a.role}</td>
                    <td class="py-2">${(a.customers||[]).join(", ")}</td>
                    <td class="py-2">
                      ${user.role === "admin" ? `<form method="POST" action="/admin/reset-password" style="display:inline">
                        <input type="hidden" name="target" value="${a.id}"/>
                        <button class="bg-yellow-500 text-white px-2 py-1 rounded">Reset PW</button>
                      </form>` : ""}
                      ${user.id === a.id ? `<a class="ml-2 text-blue-600" href="#changePW" onclick="document.getElementById('pwUser').value='${a.username}';">Change PW</a>` : ""}
                    </td>
                  </tr>`).join("")}
              </tbody>
            </table>
          </section>

          <!-- Customers -->
          <section id="customers" class="mb-6">
            <h2 class="font-semibold text-lg mb-2">Customers</h2>
            <div class="grid md:grid-cols-2 gap-4">
              ${customers.map(c=>`
                <div class="p-3 border rounded">
                  <div class="flex justify-between">
                    <div>
                      <div class="font-semibold">${c}</div>
                      <div class="text-xs text-gray-600 mt-1">${loadCustomerInfo(c).split("\n")[0] || ""}</div>
                    </div>
                    <div class="text-xs">
                      <form method="POST" action="/customer/save-info" class="mb-1">
                        <input type="hidden" name="customer" value="${c}"/>
                        <button class="bg-blue-600 text-white px-2 py-1 rounded">Edit Info</button>
                      </form>
                      <form method="POST" action="/admin/delete-customer" onsubmit="return confirm('Delete ${c}?')">
                        <input type="hidden" name="customer" value="${c}"/>
                        <button class="bg-red-600 text-white px-2 py-1 rounded">Delete</button>
                      </form>
                    </div>
                  </div>
                </div>
              `).join("")}
            </div>

            <div class="mt-4">
              <form method="POST" action="/customer/create" class="flex gap-2">
                <input name="customer" placeholder="neuer-kunde" class="border p-2 rounded flex-1" />
                <button class="bg-green-600 text-white px-3 py-1 rounded">Create</button>
              </form>
            </div>
          </section>

          <!-- Bots -->
          <section id="bots" class="mb-6">
            <h2 class="font-semibold text-lg mb-2">Bots</h2>
            <div>
              ${listCustomers().map(c=>{
                const token = loadBotToken(c);
                return `<div class="p-3 border rounded mb-2">
                  <div class="flex justify-between items-center">
                    <div>
                      <div class="font-semibold">${c}</div>
                      <div class="text-xs text-gray-600">Token: ${token ? "[present]" : "[missing]"}</div>
                    </div>
                    <div>
                      <form method="POST" action="/admin/save-bot-token" style="display:inline">
                        <input type="hidden" name="customer" value="${c}"/>
                        <input name="token" placeholder="bot token" class="border px-2 py-1 rounded" />
                        <button class="bg-blue-600 text-white px-2 py-1 rounded">Save Token</button>
                      </form>
                      <form method="POST" action="/admin/toggle-bot" style="display:inline">
                        <input type="hidden" name="customer" value="${c}"/>
                        <button class="ml-2 bg-gray-600 text-white px-2 py-1 rounded">${paused[c] ? "Start" : "Pause"}</button>
                      </form>
                    </div>
                  </div>
                </div>`;
              }).join("")}
            </div>
          </section>

          <!-- Requests -->
          <section id="requests" class="mb-6">
            <h2 class="font-semibold text-lg mb-2">Pending Requests / Admin</h2>
            <div class="p-3 bg-gray-50 rounded">
              <div class="text-xs text-gray-700">Admin IPs: ${(loadAdminData().adminIPs||[]).join(", ")}</div>
              <div class="text-xs text-gray-700 mt-2">PIN set: ${loadAdminData().pin ? "[yes]" : "[no]"}</div>
            </div>
          </section>

        </div>

        <!-- Right column: quick actions & change pw -->
        <div class="bg-white p-4 rounded shadow">
          <h3 class="font-semibold mb-2">Schnell: Passwort ändern</h3>
          <form id="changePW" method="POST" action="/change-password">
            <input type="hidden" name="username" id="pwUser" value="${user.username}" />
            <label class="block mb-2">Altes PW<input name="oldPassword" type="password" class="border p-2 w-full" /></label>
            <label class="block mb-2">Neues PW<input name="newPassword" type="password" class="border p-2 w-full" /></label>
            <button class="bg-blue-600 text-white px-3 py-1 rounded">Ändern</button>
          </form>

          ${user.role === "admin" ? `
            <hr class="my-4"/>
            <h3 class="font-semibold mb-2">Admin Aktionen</h3>
            <form method="POST" action="/admin/add-ip" class="mb-2">
              <input name="ip" placeholder="1.2.3.4" class="border p-2 w-full" />
              <button class="mt-2 bg-green-600 text-white px-3 py-1 rounded">IP hinzufügen</button>
            </form>
            <form method="POST" action="/admin/set-pin">
              <input name="pin" placeholder="neuer pin (leer zum entfernen)" class="border p-2 w-full" />
              <button class="mt-2 bg-yellow-500 text-white px-3 py-1 rounded">Set PIN (Admin)</button>
            </form>
          ` : ""}

        </div>
      </div>

      <div class="mt-6 text-xs text-gray-500">Server Zeit: ${new Date().toLocaleString()}</div>
    </div>
  </body></html>
  `);
});

// ---------------------------
// Account routes: change password (own account)
// ---------------------------
app.post("/change-password", requireAuth, (req,res)=>{
  const { oldPassword, newPassword, username } = req.body;
  const accounts = loadAccounts();
  const acc = accounts.find(a => a.username === username);
  if(!acc) return res.status(400).send("Account nicht gefunden");
  // verify old password
  if(acc.salt && acc.hash){
    if(!verifyPassword(oldPassword, acc.salt, acc.hash)) return res.status(401).send("Altes Passwort falsch");
  } else {
    if(String(oldPassword) !== String(acc.password)) return res.status(401).send("Altes Passwort falsch");
  }
  // set new
  const { salt, hash } = hashPassword(newPassword);
  acc.salt = salt; acc.hash = hash;
  saveAccounts(accounts);
  res.send(`<p>Passwort geändert. <a href="/dashboard">Zurück</a></p>`);
});

// ---------------------------
// Admin routes (requireAdminOrDevice)
// ---------------------------
app.post("/admin/reset-password", requireAdminOrDevice, (req,res)=>{
  const targetId = req.body.target;
  const accounts = loadAccounts();
  const acc = accounts.find(a => a.id === targetId);
  if(!acc) return res.status(404).send("Account nicht gefunden");
  const newPw = randomPassword();
  const { salt, hash } = hashPassword(newPw);
  acc.salt = salt; acc.hash = hash;
  saveAccounts(accounts);
  // show generated password to admin (in real system: email instead)
  res.send(`<p>Passwort für ${acc.username} zurückgesetzt: <strong>${newPw}</strong>. <a href="/dashboard">Zurück</a></p>`);
});

app.post("/admin/add-ip", requireAdminOrDevice, (req,res)=>{
  const { ip } = req.body;
  if(!ip) return res.status(400).send("ip required");
  const data = loadAdminData();
  data.adminIPs = data.adminIPs || [];
  if(!data.adminIPs.includes(ip)) data.adminIPs.push(ip);
  saveAdminData(data);
  res.redirect("/dashboard");
});

app.post("/admin/set-pin", requireAdminOrDevice, (req,res)=>{
  const { pin } = req.body;
  const data = loadAdminData();
  if(!pin){
    data.pin = null;
    saveAdminData(data);
    return res.redirect("/dashboard");
  }
  // store as hashed for safety
  data.pin = hashPassword(pin);
  saveAdminData(data);
  res.redirect("/dashboard");
});

// Create customer
app.post("/customer/create", requireAuth, (req,res)=>{
  // only admin or normal user can create, keep simple: any logged in user can create
  const c = sanitizeCustomerName(req.body.customer || "");
  if(!c) return res.redirect("/dashboard");
  ensureCustomerDir(c);
  initCustomerBot(c).catch(e=>console.error("init bot error:", e));
  res.redirect("/dashboard");
});

// Save customer info (basic UI)
app.post("/customer/save-info", requireAuth, (req,res)=>{
  // opens an editor - for simplicity, allow quick replace via POST param "info"
  const customer = req.body.customer;
  // if no info provided, just show a simple form
  if(!req.body.info){
    const info = loadCustomerInfo(customer);
    return res.send(`
      <!doctype html><html><head><script src="https://cdn.tailwindcss.com"></script></head><body class="p-6">
        <form method="POST" action="/customer/save-info">
          <input type="hidden" name="customer" value="${customer}" />
          <textarea name="info" rows="10" class="w-full border p-2">${info}</textarea>
          <button class="mt-2 bg-blue-600 text-white px-3 py-1 rounded">Speichern</button>
        </form>
      </body></html>
    `);
  }
  saveCustomerInfo(customer, req.body.info);
  res.redirect("/dashboard");
});

// delete customer (admin)
app.post("/admin/delete-customer", requireAdminOrDevice, (req,res)=>{
  const customer = req.body.customer;
  try {
    const dir = path.join(CUSTOMERS_DIR, customer);
    if(fs.existsSync(dir)) {
      // careful deletion: remove directory
      fs.rmSync(dir, { recursive: true, force: true });
    }
    // stop bot if running
    stopCustomerBot(customer).catch(()=>{});
    res.redirect("/dashboard");
  } catch (e) {
    console.error("delete customer error", e);
    res.status(500).send("Fehler");
  }
});

// ---------------------------
// Bot token save + toggle (admin)
app.post("/admin/save-bot-token", requireAdminOrDevice, (req,res)=>{
  const customer = sanitizeCustomerName(req.body.customer || "");
  const token = String(req.body.token || "").trim();
  if(!customer) return res.redirect("/dashboard");
  saveBotToken(customer, token);
  // restart bot
  initCustomerBot(customer).catch(e=>console.error("init bot error", e));
  res.redirect("/dashboard");
});

app.post("/admin/toggle-bot", requireAdminOrDevice, (req,res)=>{
  const customer = sanitizeCustomerName(req.body.customer || "");
  pausedBots = pausedBots || {};
  pausedBots[customer] = !pausedBots[customer];
  savePausedBots();
  if(pausedBots[customer]) {
    stopCustomerBot(customer).catch(()=>{});
  } else {
    initCustomerBot(customer).catch(()=>{});
  }
  res.redirect("/dashboard");
});

// ---------------------------
// Webhook endpoint for bots (if webhook set)
app.post("/bot/:customer", async (req,res)=>{
  const c = req.params.customer;
  const bot = bots[c];
  if(!bot) return res.sendStatus(200); // ignore
  try {
    await bot.handleUpdate(req.body, res);
    res.sendStatus(200);
  } catch (e) {
    console.error("bot webhook handling error", e);
    res.sendStatus(500);
  }
});

// ---------------------------
// Simple admin listing endpoint (JSON) for integrations
app.get("/admin/list", requireAdminOrDevice, (req,res)=>{
  const accounts = loadAccounts();
  const customers = listCustomers();
  const botsInfo = customers.map(c => ({ customer: c, tokenPresent: !!loadBotToken(c), paused: !!pausedBots[c] }));
  res.json({
    accounts,
    customers,
    bots: botsInfo,
    adminData: loadAdminData()
  });
});

// ---------------------------
// Utility: reset password for current user (admin override handled earlier)
// ---------------------------
app.post("/reset-own-device", requireAuth, (req,res)=>{
  // generate new device token (logout others)
  const accounts = loadAccounts();
  const acc = accounts.find(a=>a.id === req.user.id);
  if(!acc) return res.status(404).send("not found");
  const newToken = randomToken(40);
  acc.deviceTokens = [newToken];
  saveAccounts(accounts);
  setCookie(res, "deviceToken", newToken, { httpOnly: true, path: "/", maxAge: 60*60*24*30 });
  res.redirect("/dashboard");
});

// ---------------------------
// Start server
// ---------------------------
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Server läuft auf Port ${PORT}`));

