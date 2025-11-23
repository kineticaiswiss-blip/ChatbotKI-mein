// app.js — Merged: Code1 principles + Code2 security + Invite links + PW eye + phone normalizer (C)
import express from "express";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { Telegraf } from "telegraf";
import OpenAI from "openai";

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ---------------------------
// Configuration
// ---------------------------
// NOTE: On Render the "/data" path was used in your original app; if you prefer local, change to "./data"
const DATA_DIR = process.env.DATA_DIR || "/data";
const CUSTOMERS_DIR = path.join(DATA_DIR, "customers");
const ADMIN_FILE = path.join(DATA_DIR, "admin.json");
const ACCOUNTS_FILE = path.join(DATA_DIR, "accounts.json");
const PAUSED_FILE = path.join(DATA_DIR, "paused.json");
const BOTS_INFO_DIR = path.join(DATA_DIR, "bot_info"); // optional per-bot info files

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(CUSTOMERS_DIR)) fs.mkdirSync(CUSTOMERS_DIR, { recursive: true });
if (!fs.existsSync(BOTS_INFO_DIR)) fs.mkdirSync(BOTS_INFO_DIR, { recursive: true });

// Ensure files exist and have sensible defaults
function ensureFileJson(file, fallback) {
  if (!fs.existsSync(file)) {
    writeJSON(file, fallback);
  } else {
    try {
      JSON.parse(fs.readFileSync(file, "utf8"));
    } catch (e) {
      // if file corrupted, replace with fallback (safe)
      writeJSON(file, fallback);
    }
  }
}
ensureFileJson(ACCOUNTS_FILE, []);
ensureFileJson(ADMIN_FILE, { pin: null, adminIPs: [], lockedFirstAdmin: true, pendingRequests: [], invites: [] });
ensureFileJson(PAUSED_FILE, {});

// ---------------------------
// Helpers: JSON read/write
// ---------------------------
function readJSON(filePath, fallback = null) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (e) {
    console.error("JSON read error:", filePath, e);
    return fallback;
  }
}
function writeJSON(filePath, obj) {
  fs.writeFileSync(filePath, JSON.stringify(obj, null, 2), "utf8");
}

// ---------------------------
// Admin file helpers
// ---------------------------
const DEFAULT_ADMIN_IP = "185.71.18.8";
function loadAdminData() {
  const d = readJSON(ADMIN_FILE, null);
  if (!d) {
    const base = { pin: null, adminIPs: [DEFAULT_ADMIN_IP], lockedFirstAdmin: true, pendingRequests: [], invites: [] };
    writeJSON(ADMIN_FILE, base);
    return base;
  }
  d.adminIPs = d.adminIPs || [DEFAULT_ADMIN_IP];
  d.pendingRequests = d.pendingRequests || [];
  d.invites = d.invites || [];
  return d;
}
function saveAdminData(obj) { writeJSON(ADMIN_FILE, obj); }

// ---------------------------
// Accounts helpers
// ---------------------------
function loadAccounts() { return readJSON(ACCOUNTS_FILE, []) || []; }
function saveAccounts(accounts) { writeJSON(ACCOUNTS_FILE, accounts); }

// Account schema:
// {
//   id, username, salt, hash,
//   firstName, lastName, phoneNormalized, email,
//   company, role: 'pending'|'customer'|'admin'|'superadmin',
//   assignedCustomer (string or null),
//   deviceTokens: [], telegramId: null
// }

// ---------------------------
// Password hashing (scrypt) & verify
// ---------------------------
function hashPassword(password, salt = null) {
  salt = salt || crypto.randomBytes(16).toString("hex");
  const derived = crypto.scryptSync(password, salt, 64).toString("hex");
  return { salt, hash: derived };
}
function verifyPassword(password, salt, hash) {
  try {
    const check = crypto.scryptSync(password, salt, 64).toString("hex");
    return crypto.timingSafeEqual(Buffer.from(check, "hex"), Buffer.from(hash, "hex"));
  } catch (e) {
    return false;
  }
}

// ---------------------------
// Paused bots persistence
// ---------------------------
let pausedBots = readJSON(PAUSED_FILE, {}) || {};
function savePausedBots() { writeJSON(PAUSED_FILE, pausedBots); }

// ---------------------------
// OpenAI setup (optional)
// ---------------------------
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ---------------------------
// Utility: client IP
// ---------------------------
function getClientIp(req) {
  const xf = req.headers["x-forwarded-for"] || req.headers["x-forwarded-for".toLowerCase()];
  if (xf) return String(xf).split(",")[0].trim();
  return (req.socket && req.socket.remoteAddress) || req.ip || "";
}

// ---------------------------
// Customer folder helpers (Code1-compatible)
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
function listCustomers() { return fs.existsSync(CUSTOMERS_DIR) ? fs.readdirSync(CUSTOMERS_DIR).filter(d => fs.statSync(path.join(CUSTOMERS_DIR, d)).isDirectory()) : []; }
function loadCustomerInfo(c) { try { return fs.readFileSync(path.join(CUSTOMERS_DIR, c, "info.txt"), "utf8"); } catch { return ""; } }
function saveCustomerInfo(c, txt) { fs.writeFileSync(path.join(CUSTOMERS_DIR, c, "info.txt"), txt, "utf8"); }
function getCustomerIPs(customer) { try { return JSON.parse(fs.readFileSync(path.join(CUSTOMERS_DIR, customer, "ips.json"), "utf8")).ips || []; } catch { return []; } }
function addCustomerIP(customer, ip, label = "") { ensureCustomerDir(customer); const p = path.join(CUSTOMERS_DIR, customer, "ips.json"); const data = readJSON(p, { ips: [] }); data.ips = data.ips || []; if (!data.ips.find(x => x.ip === ip)) data.ips.push({ ip, label, added: Date.now() }); writeJSON(p, data); }
function removeCustomerIP(customer, ip) { const p = path.join(CUSTOMERS_DIR, customer, "ips.json"); if (!fs.existsSync(p)) return; const data = readJSON(p, { ips: [] }); data.ips = (data.ips || []).filter(x => x.ip !== ip); writeJSON(p, data); }
function loadBotToken(customer) { const f = path.join(CUSTOMERS_DIR, customer, "token.txt"); if (!fs.existsSync(f)) return null; return fs.readFileSync(f, "utf8").trim() || null; }
function saveBotToken(customer, token) { ensureCustomerDir(customer); fs.writeFileSync(path.join(CUSTOMERS_DIR, customer, "token.txt"), token, "utf8"); }
function botInfoFile(botId) { const f = path.join(BOTS_INFO_DIR, `${botId}.txt`); if (!fs.existsSync(f)) fs.writeFileSync(f, "", "utf8"); return f; }

// ---------------------------
// Phone normalizer (Option C)
// - uses DEFAULT_COUNTRY_CODE env var (like "+49" or "+41"), fallback to "+49"
// - best-effort: remove non-digit, convert leading 00 -> +, handle leading 0 -> prefix default CC
// ---------------------------
const DEFAULT_CC = process.env.DEFAULT_COUNTRY_CODE || "+49";
function normalizePhone(input) {
  if (!input) return "";
  let s = String(input).trim();
  // remove spaces, parentheses, dashes
  s = s.replace(/[\s()-]/g, "");
  // if already starts with +, assume ok (keep plus)
  if (s.startsWith("+")) return s;
  // if starts with 00 -> replace with +
  if (s.startsWith("00")) return "+" + s.slice(2);
  // if starts with 0 -> strip leading 0 and prefix default cc (without +)
  if (s.startsWith("0")) {
    const rest = s.replace(/^0+/, "");
    // ensure default cc has no plus now
    const cc = DEFAULT_CC.startsWith("+") ? DEFAULT_CC : ("+" + DEFAULT_CC);
    return cc + rest;
  }
  // if all digits and length looks like local -> prefix default cc
  if (/^\d+$/.test(s)) {
    const cc = DEFAULT_CC.startsWith("+") ? DEFAULT_CC : ("+" + DEFAULT_CC);
    return cc + s;
  }
  // fallback -> return original
  return input;
}

// ---------------------------
// TelegramBots: init/stop + start all on boot
// ---------------------------
const bots = {}; // key: customerName -> Telegraf instance

async function stopCustomerBot(customer) {
  if (bots[customer]) {
    try { await bots[customer].stop(); } catch (e) { /* ignore */ }
    delete bots[customer];
    console.log(`Bot ${customer} stopped`);
  }
}

async function initCustomerBot(customer) {
  try {
    ensureCustomerDir(customer);
    await stopCustomerBot(customer);
    const token = loadBotToken(customer);
    if (!token) { console.log(`No token for ${customer}`); return; }
    if (pausedBots[customer]) { console.log(`Bot ${customer} paused`); return; }

    const bot = new Telegraf(token);
    const accounts = loadAccounts();
    const superadmin = accounts.find(a => a.role === "superadmin");
    const admins = accounts.filter(a => a.role === "admin" || a.role === "superadmin");
    const info = loadCustomerInfo(customer) || "";
    const botInfoF = botInfoFile(customer);

    bot.start(ctx => ctx.reply(`👋 Willkommen beim Chatbot von ${customer}!`));

    bot.command("businessinfo", ctx => {
      const uid = ctx.from.id;
      if (!admins.some(a => String(a.telegramId) === String(uid))) return ctx.reply("🚫 Nur Admin.");
      ctx.reply("Admin-Modus aktiv. /data zum Anzeigen. /exit zum Beenden.");
    });

    bot.command("data", ctx => {
      const uid = ctx.from.id;
      if (!admins.some(a => String(a.telegramId) === String(uid))) return ctx.reply("🚫 Nur Admin.");
      ctx.reply(`📋 Infos:\n\n${loadCustomerInfo(customer)}`);
    });

    bot.on("text", async (ctx) => {
      try {
        const uid = ctx.from.id;
        const msg = String(ctx.message.text || "").trim();
        const isAdmin = admins.some(a => String(a.telegramId) === String(uid));
        const isCustomer = accounts.some(a => a.role === "customer" && a.assignedCustomer === customer && String(a.telegramId) === String(uid));
        if (!isAdmin && !isCustomer) return ctx.reply("🚫 Du bist kein berechtigter Benutzer.");

        // check if message appears in info -> simple contains match
        const infoText = loadCustomerInfo(customer) || "";
        if (infoText && infoText.toLowerCase().includes(msg.toLowerCase())) {
          return ctx.reply(infoText);
        }

        // else fallback to OpenAI if configured
        if (process.env.OPENAI_API_KEY) {
          try {
            const prompt = `Du bist der Assistent von ${customer}. Nutze vorrangig folgende Informationen: ${infoText}\n\nFrage: ${msg}`;
            const resp = await openai.chat.completions.create({
              model: "gpt-4o-mini",
              messages: [{ role: "user", content: prompt }],
              max_tokens: 250,
              temperature: 0
            });
            const answer = resp.choices?.[0]?.message?.content?.trim() || "Das weiß ich nicht.";
            return ctx.reply(answer);
          } catch (e) {
            console.error("OpenAI error:", e);
            return ctx.reply("⚠️ Fehler: konnte nicht antworten.");
          }
        } else {
          return ctx.reply("ℹ️ Keine passende Info und OpenAI nicht konfiguriert.");
        }
      } catch (err) {
        console.error("Bot handler error:", err);
        try { ctx.reply("⚠️ Fehler beim Verarbeiten."); } catch (e) {}
      }
    });

    // webhook vs polling
    const RENDER_URL = process.env.RENDER_URL || process.env.PRIMARY_URL || null;
    try {
      if (RENDER_URL) {
        await bot.telegram.setWebhook(`${RENDER_URL}/bot/${customer}`);
        app.use(`/bot/${customer}`, bot.webhookCallback(`/bot/${customer}`));
        console.log(`Webhook set for ${customer}`);
      } else {
        await bot.launch({ dropPendingUpdates: true });
      }
    } catch (e) {
      console.warn("Webhook failed, fallback to polling:", e);
      try { await bot.launch({ dropPendingUpdates: true }); } catch (e2) { console.error("Polling start failed:", e2); }
    }

    bots[customer] = bot;
    console.log(`Initialized bot for ${customer}`);
  } catch (e) {
    console.error("initCustomerBot error:", e);
  }
}

// initialize existing customers at startup
listCustomers().forEach(c => {
  try { initCustomerBot(c).catch(() => {}); } catch (e) { console.error("init error", c, e); }
});

// ---------------------------
// Cookie helpers
// ---------------------------
function parseCookies(req) {
  const header = req.headers?.cookie || "";
  const obj = {};
  header.split(";").map(s => s.trim()).filter(Boolean).forEach(p => {
    const idx = p.indexOf("=");
    if (idx > -1) obj[p.slice(0, idx)] = decodeURIComponent(p.slice(idx + 1));
  });
  return obj;
}
function setCookie(res, name, value, opts = {}) {
  let cookie = `${name}=${encodeURIComponent(value)}`;
  if (opts.maxAge) cookie += `; Max-Age=${opts.maxAge}`;
  if (opts.httpOnly) cookie += `; HttpOnly`;
  if (opts.path) cookie += `; Path=${opts.path}`;
  if (opts.secure || process.env.NODE_ENV === "production") cookie += `; Secure`;
  cookie += `; SameSite=${opts.sameSite || 'Lax'}`;
  res.setHeader("Set-Cookie", cookie);
}

// ---------------------------
// Auth middleware (deviceToken stored per device)
// ---------------------------
function requireAuth(req, res, next) {
  const cookies = parseCookies(req);
  const token = cookies.deviceToken;
  if (!token) return res.redirect("/register");
  const accounts = loadAccounts();
  const acc = accounts.find(a => (a.deviceTokens || []).includes(token));
  if (!acc) return res.redirect("/register");
  req.user = acc;
  next();
}

// requireAdmin: account must be admin or superadmin
function requireAdmin(req, res, next) {
  if (!req.user) return res.redirect("/register");
  if (req.user.role === "admin" || req.user.role === "superadmin") return next();
  res.send("🚫 Zugriff verweigert. Nur Admins.");
}

// ---------------------------
// Routes: Register / Login / Logout
// - /register supports invite tokens as ?invite=TOKEN
// - first registered user becomes superadmin
// ---------------------------

app.get("/register", (req, res) => {
  const invite = (req.query.invite || "").trim();
  // simple Tailwind UI + eye toggle JS
  res.send(`
  <!doctype html>
  <html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <script src="https://cdn.tailwindcss.com"></script>
    <title>Registrierung</title>
  </head>
  <body class="p-6 bg-gray-50">
    <div class="max-w-xl mx-auto bg-white p-6 rounded shadow">
      <h1 class="text-xl font-bold mb-4">Registrierung</h1>
      <form method="POST" action="/register${invite?('?invite='+invite):''}" class="space-y-3">
        <div><input name="username" placeholder="Benutzername" required class="w-full border p-2 rounded" /></div>
        <div class="relative">
          <input id="pw" name="password" type="password" placeholder="Passwort" required class="w-full border p-2 rounded pr-10" />
          <button type="button" onclick="(function(){const i=document.getElementById('pw'); i.type = i.type==='password'?'text':'password'})()" class="absolute right-2 top-2 text-gray-600">👁️</button>
        </div>
        <div><input name="firstName" placeholder="Vorname" required class="w-full border p-2 rounded" /></div>
        <div><input name="lastName" placeholder="Nachname" required class="w-full border p-2 rounded" /></div>
        <div><input name="email" placeholder="E-Mail (oder leer)" class="w-full border p-2 rounded" /></div>
        <div><input name="phone" placeholder="Telefon (optional, wird normalisiert)" class="w-full border p-2 rounded" /></div>
        <div><input name="company" placeholder="Firma (optional)" class="w-full border p-2 rounded" /></div>
        <div><button class="bg-blue-600 text-white px-4 py-2 rounded">Registrieren</button></div>
      </form>
      <p class="mt-4 text-sm">Hast du bereits ein Konto? <a href="/login" class="text-blue-600">Login</a></p>
    </div>
  </body>
  </html>
  `);
});

app.post("/register", (req, res) => {
  const { username, password, firstName, lastName, email, phone, company } = req.body;
  if (!username || !password || !firstName || !lastName) return res.send("Bitte Pflichtfelder ausfüllen.");
  const accounts = loadAccounts();
  if (accounts.find(a => a.username === username)) return res.send("Benutzername bereits vergeben.");

  const inviteToken = (req.query.invite || "").trim();
  const adminData = loadAdminData();
  const { salt, hash } = hashPassword(password);
  const deviceToken = crypto.randomBytes(32).toString("hex");
  const newId = crypto.randomBytes(8).toString("hex");

  let role = "pending";
  let assignedCustomer = null;
  if (inviteToken && adminData.invites && Array.isArray(adminData.invites)) {
    const idx = adminData.invites.findIndex(i => i.token === inviteToken);
    if (idx > -1) {
      const inv = adminData.invites[idx];
      role = inv.role || "customer";
      assignedCustomer = inv.customer || null;
      // consume invite
      adminData.invites.splice(idx, 1);
      saveAdminData(adminData);
    }
  } else {
    // if this is the first ever account, make superadmin
    if (accounts.length === 0) {
      role = "superadmin";
    }
  }

  const acc = {
    id: newId,
    username,
    salt, hash,
    firstName, lastName,
    email: (email || "").trim() || null,
    phoneNormalized: normalizePhone(phone || ""),
    company: (company || "").trim() || "",
    role,
    assignedCustomer,
    deviceTokens: [deviceToken],
    telegramId: null
  };
  accounts.push(acc);
  saveAccounts(accounts);

  if (role === "pending") {
    // add to admin pending
    adminData.pendingRequests = adminData.pendingRequests || [];
    adminData.pendingRequests.push({
      id: crypto.randomBytes(6).toString("hex"),
      username, firstName, lastName, email: acc.email, phone: acc.phoneNormalized, company: acc.company,
      ip: getClientIp(req), ts: Date.now()
    });
    saveAdminData(adminData);
    return res.send("Registrierungsanfrage gesendet. Admin wird prüfen.");
  }

  // set cookie
  setCookie(res, "deviceToken", deviceToken, { httpOnly: true, maxAge: 60 * 60 * 24 * 30, path: "/" });

  // If assignedCustomer exists, ensure folder and try to init bot
  if (assignedCustomer) {
    ensureCustomerDir(assignedCustomer);
    initCustomerBot(assignedCustomer).catch(() => {});
  }

  res.send(`Account erstellt als ${role}. <a href="/dashboard">Zum Dashboard</a>`);
});

// Login
app.get("/login", (req, res) => {
  res.send(`
  <!doctype html><html><head><script src="https://cdn.tailwindcss.com"></script></head><body class="p-6">
  <div class="max-w-md mx-auto bg-white p-6 rounded shadow">
    <h1 class="text-xl font-bold mb-4">Login</h1>
    <form method="POST" action="/login" class="space-y-3">
      <input name="username" placeholder="Benutzername" required class="w-full border p-2 rounded" />
      <div class="relative">
        <input id="pw2" name="password" type="password" placeholder="Passwort" required class="w-full border p-2 rounded pr-10" />
        <button type="button" onclick="(function(){const i=document.getElementById('pw2'); i.type = i.type==='password'?'text':'password'})()" class="absolute right-2 top-2 text-gray-600">👁️</button>
      </div>
      <button class="bg-blue-600 text-white px-4 py-2 rounded">Login</button>
    </form>
  </div></body></html>
  `);
});
app.post("/login", (req, res) => {
  const { username, password } = req.body;
  const accounts = loadAccounts();
  const acc = accounts.find(a => a.username === username);
  if (!acc) return res.send("Benutzer nicht gefunden.");
  if (!verifyPassword(password, acc.salt, acc.hash)) return res.send("Ungültiges Passwort.");
  const deviceToken = crypto.randomBytes(32).toString("hex");
  acc.deviceTokens = acc.deviceTokens || [];
  acc.deviceTokens.push(deviceToken);
  saveAccounts(accounts);
  setCookie(res, "deviceToken", deviceToken, { httpOnly: true, maxAge: 60 * 60 * 24 * 30, path: "/" });
  if (acc.role === "pending") return res.send("Account noch nicht freigeschaltet.");
  return res.redirect("/dashboard");
});

// Logout
app.get("/logout", (req, res) => {
  setCookie(res, "deviceToken", "", { maxAge: 0, path: "/" });
  res.send("Abgemeldet. <a href='/'>Start</a>");
});

// ---------------------------
// Dashboard (user & admin)
// ---------------------------
app.get("/dashboard", requireAuth, (req, res) => {
  const accounts = loadAccounts();
  const adminData = loadAdminData();
  const customers = listCustomers();
  let html = `
  <!doctype html><html><head><script src="https://cdn.tailwindcss.com"></script></head><body class="p-6 bg-gray-50">
  <div class="max-w-5xl mx-auto">
    <h1 class="text-2xl font-bold mb-4">Dashboard</h1>
    <p>Hallo ${req.user.firstName} ${req.user.lastName} — <strong>${req.user.role}</strong></p>
    <hr class="my-4" />
  `;

  // Own password change form
  html += `
    <div class="mb-6">
      <h2 class="text-lg font-semibold">Eigenes Passwort ändern</h2>
      <form method="POST" action="/changepw" class="space-y-2">
        <div class="relative"><input name="current" placeholder="Aktuelles Passwort" type="password" required class="border p-2 rounded w-full"/><button type="button" onclick="(function(){const i=document.querySelector('input[name=current]'); i.type=i.type==='password'?'text':'password'})()" class="ml-2">👁️</button></div>
        <div class="relative"><input name="newpw" placeholder="Neues Passwort" type="password" required class="border p-2 rounded w-full"/><button type="button" onclick="(function(){const i=document.querySelector('input[name=newpw]'); i.type=i.type==='password'?'text':'password'})()" class="ml-2">👁️</button></div>
        <button class="bg-green-600 text-white px-3 py-1 rounded">Ändern</button>
      </form>
    </div>
  `;

  // Customer view
  if (req.user.role === "customer") {
    html += `<h2 class="text-lg font-semibold">Dein Kundenbereich: ${req.user.assignedCustomer || "keine Zuweisung"}</h2>`;
    if (req.user.assignedCustomer) {
      const info = loadCustomerInfo(req.user.assignedCustomer) || "";
      html += `<form method="POST" action="/customer/${req.user.assignedCustomer}/save"><textarea name="data" rows="10" cols="80" class="w-full border p-2 rounded">${info}</textarea><br/><button class="mt-2 bg-blue-600 text-white px-3 py-1 rounded">Speichern</button></form>`;
    } else {
      html += `<p>Dir ist kein Kunde zugewiesen.</p>`;
    }
    html += `<p class="mt-4"><a href="/logout" class="text-blue-600">Logout</a></p></div></body></html>`;
    return res.send(html);
  }

  // Admin / Superadmin: pending requests
  if (req.user.role === "admin" || req.user.role === "superadmin") {
    html += `<div class="mb-6"><h2 class="text-lg font-semibold">Pending Registrations</h2>`;
    (adminData.pendingRequests || []).forEach((p, idx) => {
      html += `<div class="border p-2 my-2"><strong>${p.firstName} ${p.lastName}</strong> — ${p.company || "-"} — ${p.email || "-"} — ${p.phone || "-"} — IP: ${p.ip}
        <br/><a href="/admin/approve/${idx}" class="text-green-600 mr-2">✅ Approve</a><a href="/admin/reject/${idx}" class="text-red-600">❌ Reject</a></div>`;
    });
    html += `</div>`;
  }

  // Accounts list + superadmin reset button
  html += `<div class="mb-6"><h2 class="text-lg font-semibold">Accounts</h2><ul class="list-disc ml-6">`;
  loadAccounts().forEach(a => {
    html += `<li>${a.username} — ${a.role} ${a.assignedCustomer?`(customer:${a.assignedCustomer})`:''} `;
    if (req.user.role === "superadmin") {
      html += `<form style="display:inline" method="POST" action="/admin/resetpw"><input type="hidden" name="username" value="${a.username}"/><button class="ml-2 bg-yellow-500 px-2 py-1 rounded">Reset PW</button></form>`;
    }
    html += `</li>`;
  });
  html += `</ul></div>`;

  // Customers/Bots list
  html += `<div class="mb-6"><h2 class="text-lg font-semibold">Kunden / Bots</h2>`;
  customers.forEach(c => {
    html += `<div class="border p-3 mb-2"><strong>${c}</strong> — Status: ${bots[c] ? "running" : (pausedBots[c] ? "paused" : "stopped")} 
      <br/><a href="/admin/view/${c}" class="text-blue-600">Bearbeiten</a></div>`;
  });
  html += `</div>`;

  // Invite generator & list
  html += `<div class="mb-6"><h2 class="text-lg font-semibold">Invite-Link erzeugen</h2>
    <form method="POST" action="/admin/invite" class="flex gap-2 items-center">
      <select name="role" class="border p-2 rounded"><option value="customer">Kunde</option><option value="admin">Admin</option></select>
      <input name="customer" placeholder="customer-name (optional)" class="border p-2 rounded" />
      <button class="bg-indigo-600 text-white px-3 py-1 rounded">Erstellen</button>
    </form>
    <div class="mt-3"><h4 class="font-medium">Erstellte Invites</h4><ul>`;
  (adminData.invites || []).forEach(inv => {
    const base = process.env.RENDER_URL || `http://localhost:${process.env.PORT || 10000}`;
    const link = `${base}/register?invite=${inv.token}`;
    html += `<li class="my-2">Role:${inv.role} ${inv.customer?` customer:${inv.customer}`:''}
      <input class="border p-1 rounded w-96" value="${link}" readonly />
      <button onclick="navigator.clipboard.writeText('${link}')" class="ml-2 bg-gray-200 px-2 rounded">Kopieren</button>
      </li>`;
  });
  html += `</ul></div></div>`;

  html += `<p class="mt-4"><a href="/logout" class="text-blue-600">Logout</a></p></div></body></html>`;
  res.send(html);
});

// ---------------------------
// Change own password
app.post("/changepw", requireAuth, (req, res) => {
  const { current, newpw } = req.body;
  if (!current || !newpw) return res.send("Angaben fehlen.");
  const accounts = loadAccounts();
  const acc = accounts.find(a => a.id === req.user.id);
  if (!acc) return res.send("Account nicht gefunden.");
  if (!verifyPassword(current, acc.salt, acc.hash)) return res.send("Aktuelles Passwort falsch.");
  const { salt, hash } = hashPassword(newpw);
  acc.salt = salt; acc.hash = hash;
  saveAccounts(accounts);
  res.send("Passwort geändert. <a href='/dashboard'>Zurück</a>");
});

// ---------------------------
// Superadmin: reset pw for any user
app.post("/admin/resetpw", requireAuth, (req, res) => {
  if (req.user.role !== "superadmin") return res.send("Nur Superadmin.");
  const { username } = req.body;
  const accounts = loadAccounts();
  const acc = accounts.find(a => a.username === username);
  if (!acc) return res.send("Benutzer nicht gefunden.");
  const newpw = crypto.randomBytes(6).toString("hex");
  const { salt, hash } = hashPassword(newpw);
  acc.salt = salt; acc.hash = hash;
  saveAccounts(accounts);
  res.send(`Passwort zurückgesetzt. Neues Passwort: <b>${newpw}</b>. (Sichere es sofort). <a href="/dashboard">Zurück</a>`);
});

// ---------------------------
// Invite creation
app.post("/admin/invite", requireAuth, (req, res) => {
  if (!(req.user.role === "admin" || req.user.role === "superadmin")) return res.send("Nur Admins.");
  const { role, customer } = req.body;
  const adminData = loadAdminData();
  adminData.invites = adminData.invites || [];
  const token = crypto.randomBytes(12).toString("hex");
  adminData.invites.push({ token, role: role || "customer", customer: (customer || null), created: Date.now() });
  saveAdminData(adminData);
  res.redirect("/dashboard");
});

// ---------------------------
// Admin Approve / Reject pending
app.get("/admin/approve/:idx", requireAuth, (req, res) => {
  if (!(req.user.role === "admin" || req.user.role === "superadmin")) return res.send("Nur Admins.");
  const idx = parseInt(req.params.idx);
  const adminData = loadAdminData();
  const reqObj = adminData.pendingRequests?.[idx];
  if (!reqObj) return res.send("Nicht gefunden.");
  res.send(`<form method="post" action="/admin/approve/${idx}">Rolle: <select name="role"><option value="customer">customer</option><option value="admin">admin</option></select> Kunde-Name: <input name="customerName" value="${reqObj.company || ''}" /> <button>Bestätigen</button></form>`);
});
app.post("/admin/approve/:idx", requireAuth, (req, res) => {
  if (!(req.user.role === "admin" || req.user.role === "superadmin")) return res.send("Nur Admins.");
  const idx = parseInt(req.params.idx);
  const adminData = loadAdminData();
  const reqObj = adminData.pendingRequests?.[idx];
  if (!reqObj) return res.send("Nicht gefunden.");
  const accounts = loadAccounts();
  const acc = accounts.find(a => a.username === reqObj.username);
  if (!acc) return res.send("Account nicht gefunden.");
  const role = req.body.role || "customer";
  if (role === "admin") {
    acc.role = "admin";
  } else {
    const cname = (req.body.customerName || reqObj.company || reqObj.username || "kunde").toLowerCase().replace(/\s+/g, "-");
    ensureCustomerDir(cname);
    acc.role = "customer";
    acc.assignedCustomer = cname;
    addCustomerIP(cname, reqObj.ip, `${reqObj.firstName} ${reqObj.lastName}`);
    initCustomerBot(cname).catch(() => {});
  }
  saveAccounts(accounts);
  adminData.pendingRequests.splice(idx, 1);
  saveAdminData(adminData);
  res.send("✅ Genehmigt. <a href='/dashboard'>Zurück</a>");
});
app.get("/admin/reject/:idx", requireAuth, (req, res) => {
  if (!(req.user.role === "admin" || req.user.role === "superadmin")) return res.send("Nur Admins.");
  const idx = parseInt(req.params.idx);
  const adminData = loadAdminData();
  if (!adminData.pendingRequests?.[idx]) return res.send("Nicht gefunden.");
  adminData.pendingRequests.splice(idx, 1);
  saveAdminData(adminData);
  res.send("❌ Abgelehnt. <a href='/dashboard'>Zurück</a>");
});

// ---------------------------
// Admin: view / edit customer, token, pause/resume
app.get("/admin/view/:customer", requireAuth, (req, res) => {
  if (!(req.user.role === "admin" || req.user.role === "superadmin")) return res.send("Nur Admins.");
  const customer = req.params.customer;
  if (!fs.existsSync(path.join(CUSTOMERS_DIR, customer))) return res.send("Kunde nicht vorhanden.");
  const info = loadCustomerInfo(customer) || "";
  const ips = getCustomerIPs(customer) || [];
  const paused = !!pausedBots[customer];
  res.send(`
    <h1>Bearbeite ${customer}</h1>
    <form method="POST" action="/admin/save/${customer}">
      <textarea name="data" rows="20" cols="80">${info}</textarea><br/>
      <button>Speichern</button>
    </form>
    <h3>Zugelassene IPs</h3>
    <ul>${ips.map(i=>`<li>${i.ip} ${i.label?`(${i.label})`:''} - <a href="/admin/remove-customer-ip/${customer}/${i.ip}">entfernen</a></li>`).join("")}</ul>
    <form method="POST" action="/admin/add-customer-ip/${customer}"><input name="ip" placeholder="IP" required /> <input name="label" placeholder="Label" /><button>Hinzufügen</button></form>
    <h3>Bot</h3>
    <p>Status: ${paused? "paused":"running/stopped"}</p>
    <form method="POST" action="/admin/token/${customer}">Neues Token: <input name="newToken" placeholder="Neues Bot Token" /> <button>Setzen & Neustart</button></form>
    <p><a href="/admin">Zurück</a></p>
  `);
});
app.post("/admin/save/:customer", requireAuth, (req, res) => {
  if (!(req.user.role === "admin" || req.user.role === "superadmin")) return res.send("Nur Admins.");
  saveCustomerInfo(req.params.customer, req.body.data || "");
  res.redirect(`/admin/view/${req.params.customer}`);
});
app.post("/admin/add-customer-ip/:customer", requireAuth, (req, res) => {
  if (!(req.user.role === "admin" || req.user.role === "superadmin")) return res.send("Nur Admins.");
  addCustomerIP(req.params.customer, req.body.ip.trim(), req.body.label || "");
  res.redirect(`/admin/view/${req.params.customer}`);
});
app.get("/admin/remove-customer-ip/:customer/:ip", requireAuth, (req, res) => {
  if (!(req.user.role === "admin" || req.user.role === "superadmin")) return res.send("Nur Admins.");
  removeCustomerIP(req.params.customer, req.params.ip);
  res.redirect(`/admin/view/${req.params.customer}`);
});
app.post("/admin/token/:customer", requireAuth, (req, res) => {
  if (!(req.user.role === "admin" || req.user.role === "superadmin")) return res.send("Nur Admins.");
  const t = req.body.newToken || "";
  if (t) saveBotToken(req.params.customer, t);
  stopCustomerBot(req.params.customer).catch(()=>{});
  initCustomerBot(req.params.customer).catch(()=>{});
  res.redirect(`/admin/view/${req.params.customer}`);
});
app.get("/admin/bot/pause/:customer", requireAuth, (req, res) => {
  if (!(req.user.role === "admin" || req.user.role === "superadmin")) return res.send("Nur Admins.");
  pausedBots[req.params.customer] = true;
  savePausedBots();
  stopCustomerBot(req.params.customer).catch(()=>{});
  res.redirect("/admin");
});
app.get("/admin/bot/resume/:customer", requireAuth, (req, res) => {
  if (!(req.user.role === "admin" || req.user.role === "superadmin")) return res.send("Nur Admins.");
  delete pausedBots[req.params.customer];
  savePausedBots();
  initCustomerBot(req.params.customer).catch(()=>{});
  res.redirect("/admin");
});

// ---------------------------
// Customer-facing view (account)
app.get("/customer/:customer", requireAuth, (req,res) => {
  const acc = req.user;
  if (acc.role === "customer" && acc.assignedCustomer === req.params.customer) {
    const info = loadCustomerInfo(req.params.customer) || "";
    res.send(`<h1>Customer Dashboard ${req.params.customer}</h1>
      <form method="post" action="/customer/${req.params.customer}/save"><textarea name="data" rows="12" cols="80">${info}</textarea><br/><button>Speichern</button></form>
      <p><a href="/dashboard">Zurück</a></p>`);
  } else res.status(403).send("Zugriff verweigert.");
});
app.post("/customer/:customer/save", requireAuth, (req,res) => {
  const acc = req.user;
  if (acc.role === "customer" && acc.assignedCustomer === req.params.customer) {
    saveCustomerInfo(req.params.customer, req.body.data || "");
    res.redirect(`/customer/${req.params.customer}`);
  } else res.status(403).send("Zugriff verweigert.");
});

// ---------------------------
// Webhook endpoint for Telegram
app.post("/bot/:customerId", express.json(), async (req, res) => {
  const { customerId } = req.params;
  const bot = bots[customerId];
  if (!bot) { console.error("No bot for", customerId); return res.sendStatus(404); }
  try { await bot.handleUpdate(req.body, res); } catch (err) { console.error(err); res.sendStatus(500); }
});
app.get("/bot/:customerId", (req,res) => res.send(`Webhook test for ${req.params.customerId}`));

// ---------------------------
// Root / start
app.get("/", (req,res) => {
  res.send(`<h1>Multi-Kunden-Bot Platform</h1><p><a href="/register">Registrieren</a> | <a href="/login">Login</a> | <a href="/dashboard">Dashboard</a></p>`);
});

// Start server
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Server läuft auf Port ${PORT}`));
