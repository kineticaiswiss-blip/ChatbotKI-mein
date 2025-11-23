// app.js — Merged & hardened (Code1 principles + Code2 security + invites + pw-change)
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
// Paths & persistence
// ---------------------------
const DATA_DIR = "/data"; // keep same as Code1 for compatibility on Render
const CUSTOMERS_DIR = path.join(DATA_DIR, "customers");
const ADMIN_FILE = path.join(DATA_DIR, "admin.json");
const ACCOUNTS_FILE = path.join(DATA_DIR, "accounts.json");
const PAUSED_FILE = path.join(DATA_DIR, "paused.json");
const BOTS_INFO_DIR = path.join(DATA_DIR, "bot_info"); // info files per bot (optional)

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(CUSTOMERS_DIR)) fs.mkdirSync(CUSTOMERS_DIR, { recursive: true });
if (!fs.existsSync(BOTS_INFO_DIR)) fs.mkdirSync(BOTS_INFO_DIR, { recursive: true });

[ACCOUNTS_FILE, ADMIN_FILE, PAUSED_FILE].forEach(f => { if(!fs.existsSync(f)) fs.writeFileSync(f, "[]") });

// ---------------------------
// Safe JSON helpers
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
// Admin file (keeps invites & pin & adminIPs optionally)
// ---------------------------
const FIRST_ADMIN_IP = "185.71.18.8";
function ensureAdminFile() {
  let cur = readJSON(ADMIN_FILE, null);
  if (!cur || !Array.isArray(cur)) {
    // store as object with invites, pendingRequests etc.
    const base = { pin: null, adminIPs: [FIRST_ADMIN_IP], lockedFirstAdmin: true, pendingRequests: [], invites: [] };
    writeJSON(ADMIN_FILE, base);
  } else if (!cur.invites) {
    const base = { pin: null, adminIPs: [FIRST_ADMIN_IP], lockedFirstAdmin: true, pendingRequests: [], invites: [] };
    writeJSON(ADMIN_FILE, base);
  }
}
ensureAdminFile();
function loadAdminData() { return readJSON(ADMIN_FILE, { pin: null, adminIPs: [FIRST_ADMIN_IP], lockedFirstAdmin: true, pendingRequests: [], invites: [] }); }
function saveAdminData(d) { writeJSON(ADMIN_FILE, d); }

// ---------------------------
// Accounts management
// schema: { id, username, salt, hash, firstName, lastName, phone, company, role: 'pending'|'admin'|'customer'|'superadmin', assignedCustomer, deviceTokens:[], telegramId }
// ---------------------------
function ensureAccountsFile(){ if(!fs.existsSync(ACCOUNTS_FILE)) writeJSON(ACCOUNTS_FILE, []); }
ensureAccountsFile();
function loadAccounts(){ return readJSON(ACCOUNTS_FILE, []); }
function saveAccounts(accounts){ writeJSON(ACCOUNTS_FILE, accounts); }

// ---------------------------
// Password hashing helpers (secure)
// ---------------------------
function hashPassword(password, salt = null){
  salt = salt || crypto.randomBytes(16).toString("hex");
  const derived = crypto.scryptSync(password, salt, 64).toString("hex");
  return { salt, hash: derived };
}
function verifyPassword(password, salt, hash){
  try{
    const check = crypto.scryptSync(password, salt, 64).toString("hex");
    // timing safe equal
    return crypto.timingSafeEqual(Buffer.from(check, "hex"), Buffer.from(hash, "hex"));
  } catch(e){ return false; }
}

// ---------------------------
// Paused bots
// ---------------------------
let pausedBots = readJSON(PAUSED_FILE, {}) || {};
function savePausedBots(){ writeJSON(PAUSED_FILE, pausedBots); }

// ---------------------------
// OpenAI (optional)
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
// ---------------------------

// ---------------------------
// Utilities: client ip, customers dir, bot info
// ---------------------------
function getClientIp(req) {
  const xf = req.headers["x-forwarded-for"] || req.headers["x-forwarded-for".toLowerCase()];
  if (xf) return String(xf).split(",")[0].trim();
  return (req.socket && req.socket.remoteAddress) || req.ip || "";
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
function listCustomers(){ return fs.existsSync(CUSTOMERS_DIR) ? fs.readdirSync(CUSTOMERS_DIR).filter(d => fs.statSync(path.join(CUSTOMERS_DIR,d)).isDirectory()) : []; }
function loadCustomerInfo(c){ try { return fs.readFileSync(path.join(CUSTOMERS_DIR, c, "info.txt"), "utf8"); } catch { return ""; } }
function saveCustomerInfo(c, txt){ fs.writeFileSync(path.join(CUSTOMERS_DIR, c, "info.txt"), txt, "utf8"); }
function loadBotToken(customer){ const f = path.join(CUSTOMERS_DIR, customer, "token.txt"); if(!fs.existsSync(f)) return null; return fs.readFileSync(f,"utf8").trim() || null; }
function saveBotToken(customer, token){ ensureCustomerDir(customer); fs.writeFileSync(path.join(CUSTOMERS_DIR, customer, "token.txt"), token, "utf8"); }

function botInfoFile(botId){ const f = path.join(BOTS_INFO_DIR, `${botId}.txt`); if(!fs.existsSync(f)) fs.writeFileSync(f,"","utf8"); return f; }

// ---------------------------
// Telegram bot runtime (based on Code1, improved safe init)
// ---------------------------
const bots = {}; // customerName|botId => Telegraf instance

async function stopCustomerBot(key){
  if (bots[key]) {
    try { await bots[key].stop(); } catch(e) { /* ignore */ }
    delete bots[key];
    console.log(`Bot ${key} stopped`);
  }
}

async function initCustomerBot(customer /* customer name as key */){
  try {
    ensureCustomerDir(customer);
    await stopCustomerBot(customer);

    const token = loadBotToken(customer);
    if (!token) { console.log(`No token for ${customer}`); return; }
    if (pausedBots[customer]) { console.log(`Bot ${customer} paused`); return; }

    const bot = new Telegraf(token);
    const accounts = loadAccounts();
    // find admins + superadmin
    const superadmin = accounts.find(a => a.role === "superadmin");
    const adminUsers = accounts.filter(a => a.role === "admin" || a.role === "superadmin");
    const sessions = {};

    bot.start(ctx => ctx.reply(`👋 Willkommen beim Chatbot von ${customer}!`));

    // Admin trigger (simple username-based admin in original code was hardcoded; we use account telegramId matching)
    bot.command("businessinfo", ctx => {
      const uid = ctx.from.id;
      if (!adminUsers.some(a => String(a.telegramId) === String(uid))) return ctx.reply("🚫 Nur Admin.");
      sessions[uid] = true;
      ctx.reply("Admin-Modus aktiv. /data zeigt Infos. /exit zum Beenden.");
    });

    bot.command("data", ctx => {
      const uid = ctx.from.id;
      if (!adminUsers.some(a => String(a.telegramId) === String(uid))) return ctx.reply("🚫 Nur Admin.");
      ctx.reply(`📋 Infos:\n\n${loadCustomerInfo(customer)}`);
    });

    bot.on("text", async ctx => {
      try {
        const uid = ctx.from.id;
        const msg = ctx.message.text.trim();

        // check admin session (editing info)
        if (sessions[uid] && msg.includes(":")) {
          saveCustomerInfo(customer, msg);
          return ctx.reply("✅ Infos gespeichert.");
        }
        if (sessions[uid] && msg.toLowerCase() === "/exit") {
          delete sessions[uid];
          return ctx.reply("✅ Admin-Modus beendet.");
        }

        // check perms by telegramId
        const isAdmin = adminUsers.some(a => String(a.telegramId) === String(uid));
        const isCustomer = accounts.some(a => a.role === "customer" && a.assignedCustomer === customer && String(a.telegramId) === String(uid));

        if (!isAdmin && !isCustomer) {
          return ctx.reply("🚫 Du bist kein berechtigter Benutzer.");
        }

        // Bot answers: use customer info first
        const info = loadCustomerInfo(customer) || "";
        // If simple direct match in info -> respond; else fallback to OpenAI
        if (info && info.toLowerCase().includes(msg.toLowerCase())) {
          return ctx.reply(info);
        }

        // fallback to OpenAI if configured
        if (process.env.OPENAI_API_KEY) {
          try {
            const prompt = `Du bist der KI-Assistent von ${customer}. Antworte nur basierend auf folgender Info, wenn möglich, ansonsten antworte kurz und höflich:\n\n${info}\n\nFrage: ${msg}`;
            const g = await openai.chat.completions.create({
              model: "gpt-4o-mini",
              messages: [{ role: "user", content: prompt }],
              max_tokens: 250,
              temperature: 0
            });
            const answer = g.choices?.[0]?.message?.content?.trim() || "Das weiß ich nicht.";
            return ctx.reply(answer);
          } catch (e) {
            console.error("OpenAI error:", e);
            return ctx.reply("⚠️ Fehler: konnte nicht antworten.");
          }
        } else {
          return ctx.reply("ℹ️ Keine OpenAI-API konfiguriert und Info nicht gefunden.");
        }
      } catch (err) {
        console.error("Bot text handler error:", err);
        try { ctx.reply("⚠️ Fehler beim Verarbeiten."); } catch(e) {}
      }
    });

    // webhook support (Render) or fallback to polling
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
      console.warn("Webhook failed; trying polling:", e);
      try { await bot.launch({ dropPendingUpdates: true }); } catch (e2) { console.error("Polling start failed:", e2); }
    }

    bots[customer] = bot;
    console.log(`Init bot for ${customer} done`);
  } catch (e) {
    console.error("initCustomerBot error:", e);
  }
}

// initialize existing customers' bots
listCustomers().forEach(c => {
  try { ensureCustomerDir(c); initCustomerBot(c).catch(err => console.error("init error", c, err)); } catch(e) {}
});

// ---------------------------
// Cookie helpers
// ---------------------------
function parseCookies(req){
  const header = req.headers?.cookie || "";
  const obj = {};
  header.split(";").map(s=>s.trim()).filter(Boolean).forEach(p=>{
    const idx = p.indexOf("=");
    if (idx > -1) obj[p.slice(0, idx)] = decodeURIComponent(p.slice(idx+1));
  });
  return obj;
}
function setCookie(res, name, value, opts = {}){
  let cookie = `${name}=${encodeURIComponent(value)}`;
  if (opts.maxAge) cookie += `; Max-Age=${opts.maxAge}`;
  if (opts.httpOnly) cookie += `; HttpOnly`;
  if (opts.path) cookie += `; Path=${opts.path}`;
  if (opts.secure || process.env.NODE_ENV === "production") cookie += `; Secure`;
  cookie += `; SameSite=${opts.sameSite || 'Lax'}`;
  res.setHeader("Set-Cookie", cookie);
}

// ---------------------------
// Auth middleware (deviceToken per device)
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

// Admin-only (requires authenticated admin account OR invite-pin/native admin fallback)
function requireAdmin(req, res, next) {
  if (!req.user) return res.redirect("/register");
  if (req.user.role === "admin" || req.user.role === "superadmin") return next();
  res.send("🚫 Zugriff verweigert. Nur Admins.");
}

// ---------------------------
// Routes: Register / Login / Logout
// - We support invite-links: /register?invite=TOKEN
// ---------------------------
app.get("/register", (req, res) => {
  const invite = req.query.invite || "";
  res.send(`
    <h1>Registrierung</h1>
    <form method="post" action="/register${invite?('?invite='+invite):''}">
      <input name="username" placeholder="Benutzername (einzigartig)" required /><br/>
      <input name="password" type="password" placeholder="Passwort" required />
      <span style="cursor:pointer" onclick="(function(i){const p=document.querySelector('input[name=password]'); p.type = p.type==='password'?'text':'password'} )()">👁️</span>
      <br/>
      <input name="firstName" placeholder="Vorname" required /><br/>
      <input name="lastName" placeholder="Nachname" required /><br/>
      <input name="phone" placeholder="Handynummer" required /><br/>
      <input name="company" placeholder="Firma (optional)" /><br/>
      <button>Registrieren</button>
    </form>
    <p><a href="/login">Login</a></p>
  `);
});

app.post("/register", (req, res) => {
  const { username, password, firstName, lastName, phone, company } = req.body;
  if (!username || !password || !firstName || !lastName || !phone) return res.send("Bitte alle Pflichtfelder ausfüllen.");

  const accounts = loadAccounts();
  if (accounts.find(a => a.username === username)) return res.send("Benutzername bereits vergeben.");

  const inviteToken = (req.query.invite || "").trim();
  const adminData = loadAdminData();

  const { salt, hash } = hashPassword(password);
  const newId = crypto.randomBytes(8).toString("hex");
  const deviceToken = crypto.randomBytes(24).toString("hex");

  // default: pending
  let finalRole = "pending";
  let assignedCustomer = null;

  // if invite token valid -> allow direct creation with role
  if (inviteToken && adminData.invites && Array.isArray(adminData.invites)) {
    const invIdx = adminData.invites.findIndex(i => i.token === inviteToken);
    if (invIdx > -1) {
      const inv = adminData.invites[invIdx];
      finalRole = inv.role || "customer";
      assignedCustomer = inv.customer || null;
      // consume invite (one-time)
      adminData.invites.splice(invIdx, 1);
      saveAdminData(adminData);
    }
  }

  const accObj = {
    id: newId,
    username,
    salt,
    hash,
    firstName,
    lastName,
    phone,
    company: company || "",
    role: finalRole,
    assignedCustomer: assignedCustomer,
    deviceTokens: [deviceToken],
    telegramId: null
  };
  accounts.push(accObj);
  saveAccounts(accounts);

  // if role pending and not invited -> add to admin pendingRequests for review (include ip)
  if (finalRole === "pending") {
    const ip = getClientIp(req);
    adminData.pendingRequests = adminData.pendingRequests || [];
    adminData.pendingRequests.push({
      id: crypto.randomBytes(6).toString("hex"),
      username, firstName, lastName, phone, company, ip, ts: Date.now()
    });
    saveAdminData(adminData);
    return res.send("✅ Registrierungsanfrage gesendet. Admin wird prüfen.");
  }

  // set device cookie & redirect
  setCookie(res, "deviceToken", deviceToken, { httpOnly: true, maxAge: 60 * 60 * 24 * 30, path: "/" });

  // if assignedCustomer exists and a bot token exists -> try start bot
  if (assignedCustomer) {
    try { initCustomerBot(assignedCustomer).catch(()=>{}); } catch(e){ console.error("init after invite:", e); }
  }

  res.send(`Account erstellt mit Rolle ${finalRole}. <a href="/dashboard">Zum Dashboard</a>`);
});

// Login (device-token created per login)
app.get("/login", (req,res) => {
  res.send(`
    <h1>Login</h1>
    <form method="post" action="/login">
      <input name="username" placeholder="Benutzername" required /><br/>
      <input name="password" type="password" placeholder="Passwort" required /><br/>
      <button>Login</button>
    </form>
  `);
});
app.post("/login", (req,res) => {
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

app.get("/logout", (req,res) => {
  setCookie(res, "deviceToken", "", { maxAge: 0, path: "/" });
  res.send("Abgemeldet. <a href='/'>Start</a>");
});

// ---------------------------
// Dashboard & Admin UI
// ---------------------------
app.get("/dashboard", requireAuth, (req,res) => {
  const accounts = loadAccounts();
  const pending = loadAdminData().pendingRequests || [];
  const botsList = listCustomers(); // customer names correspond to bots/customers
  let html = `<h1>Dashboard</h1><p>Hallo ${req.user.firstName} ${req.user.lastName} [${req.user.role}]</p>`;

  // password change form (show/hide eye)
  html += `<h3>Eigenes Passwort ändern</h3>
    <form method="POST" action="/changepw">
      <input name="current" placeholder="Aktuelles Passwort" type="password" required/> <span style="cursor:pointer" onclick="(function(){const i=document.querySelector('input[name=current]'); i.type=i.type==='password'?'text':'password'})()">👁️</span><br/>
      <input name="newpw" placeholder="Neues Passwort" type="password" required/> <span style="cursor:pointer" onclick="(function(){const i=document.querySelector('input[name=newpw]'); i.type=i.type==='password'?'text':'password'})()">👁️</span><br/>
      <button>Ändern</button>
    </form>`;

  if (req.user.role === "customer") {
    html += `<h2>Dein Kundenbereich: ${req.user.assignedCustomer || "n/a"}</h2>`;
    html += `<p>Du kannst die Info deines Kunden bearbeiten (falls zugewiesen).</p>`;
    if (req.user.assignedCustomer) {
      const info = loadCustomerInfo(req.user.assignedCustomer) || "";
      html += `<form method="POST" action="/customer/${req.user.assignedCustomer}/save">
        <textarea name="data" rows="12" cols="60">${info}</textarea><br/>
        <button>Speichern</button>
      </form>`;
    }
    res.send(html); return;
  }

  // Admin / Superadmin UI
  const adminData = loadAdminData();
  html += `<h2>Pending Registrations</h2>`;
  (adminData.pendingRequests || []).forEach((p, idx) => {
    html += `<p>${p.firstName} ${p.lastName} — ${p.company || "-"} — ${p.phone} — IP: ${p.ip} 
      <a href="/admin/approve/${idx}">✅ Approve</a> 
      <a href="/admin/reject/${idx}">❌ Reject</a></p>`;
  });

  html += `<h2>Accounts</h2><ul>`;
  accounts.forEach(a => {
    html += `<li>${a.username} — ${a.role} ${a.assignedCustomer?`(customer:${a.assignedCustomer})`:''} 
      ${req.user.role === "superadmin" ? `<form style="display:inline" method="POST" action="/admin/resetpw"><input type="hidden" name="username" value="${a.username}"/><button>Reset PW (Superadmin)</button></form>` : '' }
    </li>`;
  });
  html += `</ul>`;

  // Bot / Customer list + edit links + invite link generation
  html += `<h2>Kunden / Bots</h2>`;
  botsList.forEach(b => {
    const info = loadCustomerInfo(b) || "";
    html += `<div style="border:1px solid #ccc;padding:8px;margin:6px;">
      <strong>${b}</strong> — Status: ${bots[b] ? "running" : (pausedBots[b] ? "paused" : "stopped")} 
      <br/> <a href="/admin/view/${b}">Bearbeiten</a>
    </div>`;
  });

  // invite generator (admins can create invite links to send to new customers)
  html += `<h2>Invite-Link erzeugen</h2>
    <form method="POST" action="/admin/invite">
      Rolle: <select name="role"><option value="customer">Kunde</option><option value="admin">Admin</option></select>
      Optional Kunde (wenn Rolle Kunde): <input name="customer" placeholder="customer-name (z.B. kunde-xyz)"/>
      <button>Invite erstellen</button>
    </form>
    <p>Erstellte Invites:</p>
    <ul>`;
  (adminData.invites || []).forEach(inv => {
    const base = process.env.RENDER_URL || `http://localhost:${process.env.PORT || 10000}`;
    html += `<li>Role:${inv.role} ${inv.customer?` customer:${inv.customer}`:''} — <input style="width:400px" value="${base}/register?invite=${inv.token}" readonly /> <button onclick="navigator.clipboard.writeText('${base}/register?invite=${inv.token}')">Kopieren</button></li>`;
  });
  html += `</ul>`;

  html += `<p><a href="/logout">Logout</a></p>`;
  res.send(html);
});

// change own password
app.post("/changepw", requireAuth, (req,res) => {
  const { current, newpw } = req.body;
  const accounts = loadAccounts();
  const acc = accounts.find(a => a.id === req.user.id);
  if (!acc) return res.send("Account nicht gefunden.");
  if (!verifyPassword(current, acc.salt, acc.hash)) return res.send("Aktuelles Passwort falsch.");
  const { salt, hash } = hashPassword(newpw);
  acc.salt = salt; acc.hash = hash;
  saveAccounts(accounts);
  res.send("Passwort geändert. <a href='/dashboard'>Zurück</a>");
});

// Superadmin reset password (resets target to random and returns it)
app.post("/admin/resetpw", requireAuth, (req,res) => {
  if (req.user.role !== "superadmin") return res.send("Nur Superadmin.");
  const { username } = req.body;
  const accounts = loadAccounts();
  const acc = accounts.find(a => a.username === username);
  if (!acc) return res.send("Benutzer nicht gefunden.");
  const newpw = crypto.randomBytes(6).toString("hex");
  const { salt, hash } = hashPassword(newpw);
  acc.salt = salt; acc.hash = hash;
  saveAccounts(accounts);
  res.send(`Passwort zurückgesetzt. Neues Passwort: <b>${newpw}</b> (sichere es sofort). <a href="/dashboard">Zurück</a>`);
});

// admin invite creation
app.post("/admin/invite", requireAuth, (req,res) => {
  if (!(req.user.role === "admin" || req.user.role === "superadmin")) return res.send("Nur Admins.");
  const { role, customer } = req.body;
  const adminData = loadAdminData();
  adminData.invites = adminData.invites || [];
  const token = crypto.randomBytes(10).toString("hex");
  adminData.invites.push({ token, role: role || "customer", customer: (customer || null), created: Date.now() });
  saveAdminData(adminData);
  res.redirect("/dashboard");
});

// ---------------------------
// Admin approve/reject flows (basic indices used like Code1)
app.get("/admin/approve/:idx", requireAuth, (req,res) => {
  if (!(req.user.role === "admin" || req.user.role === "superadmin")) return res.send("Nur Admins.");
  const idx = parseInt(req.params.idx);
  const adminData = loadAdminData();
  const reqObj = adminData.pendingRequests?.[idx];
  if (!reqObj) return res.send("Nicht gefunden.");
  // show simple approve form
  res.send(`<h2>Approve ${reqObj.username}</h2>
    <form method="post" action="/admin/approve/${idx}">
      Rolle: <select name="role"><option value="customer">customer</option><option value="admin">admin</option></select>
      Kunde-Name (falls customer): <input name="customerName" value="${reqObj.company || ''}" />
      <button>Approve</button>
    </form>`);
});
app.post("/admin/approve/:idx", requireAuth, (req,res) => {
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
    initCustomerBot(cname).catch(()=>{});
  }
  saveAccounts(accounts);
  // remove pending
  adminData.pendingRequests.splice(idx,1);
  saveAdminData(adminData);
  res.send("✅ Genehmigt. <a href='/dashboard'>Zurück</a>");
});
app.get("/admin/reject/:idx", requireAuth, (req,res) => {
  if (!(req.user.role === "admin" || req.user.role === "superadmin")) return res.send("Nur Admins.");
  const idx = parseInt(req.params.idx);
  const adminData = loadAdminData();
  if (!adminData.pendingRequests?.[idx]) return res.send("Nicht gefunden.");
  adminData.pendingRequests.splice(idx,1);
  saveAdminData(adminData);
  res.send("❌ Abgelehnt. <a href='/dashboard'>Zurück</a>");
});

// ---------------------------
// Admin: view/edit customer, token, pause/resume like Code1
app.get("/admin/view/:customer", requireAuth, (req,res) => {
  if (!(req.user.role === "admin" || req.user.role === "superadmin")) return res.send("Nur Admins.");
  const customer = req.params.customer;
  if (!fs.existsSync(path.join(CUSTOMERS_DIR, customer))) return res.send("Kunde nicht vorhanden.");
  const info = loadCustomerInfo(customer) || "";
  const ips = JSON.parse(fs.readFileSync(path.join(CUSTOMERS_DIR, customer, "ips.json"), "utf8")).ips || [];
  const paused = !!pausedBots[customer];
  res.send(`
    <h1>Bearbeite ${customer}</h1>
    <form method="post" action="/admin/save/${customer}">
      <textarea name="data" rows="20" cols="80">${info}</textarea><br/>
      <button>Speichern</button>
    </form>
    <h3>Zugelassene IPs</h3>
    <ul>${ips.map(i=>`<li>${i.ip} ${i.label?`(${i.label})`:''} - <a href="/admin/remove-customer-ip/${customer}/${i.ip}">entfernen</a></li>`).join("")}</ul>
    <form method="post" action="/admin/add-customer-ip/${customer}">
      <input name="ip" placeholder="IP-Adresse" required /> <input name="label" placeholder="Label" />
      <button>Hinzufügen</button>
    </form>
    <h3>Bot Steuerung</h3>
    <p>Status: ${paused? "paused":"running/stopped"}</p>
    <form method="post" action="/admin/token/${customer}">
      Neues Token: <input name="newToken" placeholder="Neues Bot Token" />
      <button>Setzen & Neustart</button>
    </form>
    <a href="/admin">Zurück</a>
  `);
});
app.post("/admin/save/:customer", requireAuth, (req,res) => {
  if (!(req.user.role === "admin" || req.user.role === "superadmin")) return res.send("Nur Admins.");
  saveCustomerInfo(req.params.customer, req.body.data || "");
  res.redirect(`/admin/view/${req.params.customer}`);
});
app.post("/admin/add-customer-ip/:customer", requireAuth, (req,res) => {
  if (!(req.user.role === "admin" || req.user.role === "superadmin")) return res.send("Nur Admins.");
  addCustomerIP(req.params.customer, req.body.ip.trim(), req.body.label || "");
  res.redirect(`/admin/view/${req.params.customer}`);
});
app.get("/admin/remove-customer-ip/:customer/:ip", requireAuth, (req,res) => {
  if (!(req.user.role === "admin" || req.user.role === "superadmin")) return res.send("Nur Admins.");
  removeCustomerIP(req.params.customer, req.params.ip);
  res.redirect(`/admin/view/${req.params.customer}`);
});
app.post("/admin/token/:customer", requireAuth, (req,res) => {
  if (!(req.user.role === "admin" || req.user.role === "superadmin")) return res.send("Nur Admins.");
  const t = req.body.newToken || "";
  if (t) saveBotToken(req.params.customer, t);
  stopCustomerBot(req.params.customer).catch(()=>{});
  initCustomerBot(req.params.customer).catch(()=>{});
  res.redirect(`/admin/view/${req.params.customer}`);
});
app.get("/admin/bot/pause/:customer", requireAuth, (req,res) => {
  if (!(req.user.role === "admin" || req.user.role === "superadmin")) return res.send("Nur Admins.");
  pausedBots[req.params.customer] = true;
  savePausedBots();
  stopCustomerBot(req.params.customer).catch(()=>{});
  res.redirect("/admin");
});
app.get("/admin/bot/resume/:customer", requireAuth, (req,res) => {
  if (!(req.user.role === "admin" || req.user.role === "superadmin")) return res.send("Nur Admins.");
  delete pausedBots[req.params.customer];
  savePausedBots();
  initCustomerBot(req.params.customer).catch(()=>{});
  res.redirect("/admin");
});

// ---------------------------
// Customer-facing (account) view similar to Code1
app.get("/customer/:customer", requireAuth, (req,res) => {
  const acc = req.user;
  if (acc.role === "customer" && acc.assignedCustomer === req.params.customer) {
    const info = loadCustomerInfo(req.params.customer) || "";
    res.send(`
      <h1>Customer Dashboard ${req.params.customer}</h1>
      <form method="post" action="/customer/${req.params.customer}/save">
        <textarea name="data" rows="12" cols="80">${info}</textarea><br/>
        <button>Speichern</button>
      </form>
      <p><a href="/dashboard">Zurück</a></p>
    `);
  } else {
    res.status(403).send("Zugriff verweigert.");
  }
});
app.post("/customer/:customer/save", requireAuth, (req,res) => {
  const acc = req.user;
  if (acc.role === "customer" && acc.assignedCustomer === req.params.customer) {
    saveCustomerInfo(req.params.customer, req.body.data || "");
    res.redirect(`/customer/${req.params.customer}`);
  } else res.status(403).send("Zugriff verweigert.");
});

// ---------------------------
// Webhook endpoint for telegram (used when webhook set)
app.post("/bot/:customerId", express.json(), async (req, res) => {
  const { customerId } = req.params;
  const bot = bots[customerId];
  if (!bot) { console.error("No bot for", customerId); return res.sendStatus(404); }
  try { await bot.handleUpdate(req.body, res); } catch (err) { console.error(err); res.sendStatus(500); }
});
app.get("/bot/:customerId", (req,res) => res.send(`Webhook test for ${req.params.customerId}`));

// ---------------------------
// Root & start
app.get("/", (req,res) => {
  res.send(`<h1>Multi-Kunden-Bot Platform</h1>
    <p><a href="/register">Registrieren</a> | <a href="/login">Login</a> | <a href="/dashboard">Dashboard</a></p>`);
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Server läuft auf Port ${PORT}`));
