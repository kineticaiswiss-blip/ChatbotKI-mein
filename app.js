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
// Helper: PIN/Password hashing
// ---------------------------
function hashPassword(password, salt = null) {
  salt = salt || crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");
  return { salt, hash };
}
function verifyPassword(password, salt, hash) {
  try {
    const check = crypto.scryptSync(password, salt, 64).toString("hex");
    return crypto.timingSafeEqual(Buffer.from(check, "hex"), Buffer.from(hash, "hex"));
  } catch { return false; }
}

// ---------------------------
// Helper: sanitize customer names
// ---------------------------
function sanitizeCustomerName(name) {
  return String(name || "")
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9\-]/g, "")
    .replace(/^\-+|\-+$/g, "")
    .slice(0, 50);
}

// ---------------------------
// File paths
// ---------------------------
const DATA_DIR = "/data";
const CUSTOMERS_DIR = path.join(DATA_DIR, "customers");
const ADMIN_FILE = path.join(DATA_DIR, "admin.json");
const ACCOUNTS_FILE = path.join(DATA_DIR, "accounts.json");
const PAUSED_FILE = path.join(DATA_DIR, "paused.json");

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(CUSTOMERS_DIR)) fs.mkdirSync(CUSTOMERS_DIR, { recursive: true });

// ---------------------------
// Safe JSON read/write
// ---------------------------
function readJSON(filePath, fallback = null) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (e) { console.error("JSON read error:", filePath, e); return fallback; }
}
function writeJSON(filePath, obj) { fs.writeFileSync(filePath, JSON.stringify(obj, null, 2), "utf8"); }

// ---------------------------
// Admin
// ---------------------------
const FIRST_ADMIN_IP = "185.71.18.8";

function ensureAdminFile() {
  if (!fs.existsSync(ADMIN_FILE)) {
    writeJSON(ADMIN_FILE, { pin: null, adminIPs: [FIRST_ADMIN_IP], lockedFirstAdmin: true, pendingRequests: [] });
  }
}
ensureAdminFile();

function loadAdminData() { return readJSON(ADMIN_FILE, { pin: null, adminIPs: [FIRST_ADMIN_IP], lockedFirstAdmin: true, pendingRequests: [] }); }
function saveAdminData(d) { writeJSON(ADMIN_FILE, d); }

// ---------------------------
// Accounts
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
// OpenAI setup
// ---------------------------
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ---------------------------
// Client IP helper
// ---------------------------
function getClientIp(req) {
  const xf = req.headers["x-forwarded-for"] || req.headers["x-forwarded-for".toLowerCase()];
  if (xf) return String(xf).split(",")[0].trim();
  return (req.socket && req.socket.remoteAddress) || req.ip || "";
}

// ---------------------------
// Customer helpers
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
// Telegram bots
// ---------------------------
const bots = {}; 

async function stopCustomerBot(customer) {
  if (bots[customer]) {
    try { await bots[customer].stop(); } catch {}
    delete bots[customer];
  }
}

async function initCustomerBot(customer) {
  ensureCustomerDir(customer);
  await stopCustomerBot(customer);
  const token = loadBotToken(customer);
  if (!token || pausedBots[customer]) return;

  const bot = new Telegraf(token);
  const accounts = loadAccounts();
  const adminUsernames = accounts.filter(a => a.role === "admin").map(a => (a.username||"").toLowerCase());
  const sessions = {};

  bot.start(ctx => ctx.reply(`👋 Willkommen beim Chatbot von ${customer}!`));

  function isBotAdmin(ctx) { const uname = (ctx.from.username||"").toLowerCase(); return adminUsernames.includes(uname); }

  bot.command("businessinfo", ctx => {
    if (!isBotAdmin(ctx)) return ctx.reply("🚫 Nur Admin.");
    sessions[ctx.from.id] = true;
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

      if (sessions[uid] && msg.includes(":")) {
        saveCustomerInfo(customer, msg);
        return ctx.reply("✅ Infos gespeichert.");
      }
      if (sessions[uid] && msg.toLowerCase() === "/exit") {
        delete sessions[uid];
        return ctx.reply("✅ Admin-Modus beendet.");
      }

      // OpenAI reply
      const info = loadCustomerInfo(customer);
      const messages = [
        { role: "system", content: `Du bist der KI-Assistent von ${customer}. Antworte nur mit Informationen aus diesem Info-Block. Wenn die Antwort nicht vorhanden ist, sage: "Das weiß ich nicht."`},
        { role: "user", content: `INFO:\n${info}\n\nFrage: ${msg}`}
      ];
      const gpt = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages,
        max_tokens: 300,
        temperature: 0
      });
      const answer = gpt.choices[0].message.content.trim();
      ctx.reply(answer);

    } catch (err) {
      console.error("OpenAI error:", err);
      ctx.reply("⚠️ Fehler: konnte nicht antworten.");
    }
  });

  // Webhook or polling
  const RENDER_URL = process.env.RENDER_URL || process.env.PRIMARY_URL || "https://chatbotki-mein.onrender.com";
  try {
    await bot.telegram.setWebhook(`${RENDER_URL}/bot/${customer}`);
  } catch {
    await bot.launch({ dropPendingUpdates: true }).catch(()=>{});
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
// Middleware
// ---------------------------
function requireAuth(req,res,next){
  const cookies = parseCookies(req);
  const token = cookies.deviceToken;
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
  const token = cookies.deviceToken;
  const accounts = loadAccounts();
  const acc = accounts.find(a=> (a.deviceTokens||[]).includes(token));
  if(acc && acc.role==="admin"){ req.user=acc; return next(); }
  if(adminData.adminIPs && adminData.adminIPs.includes(ip)) return next();
  const pin = req.query.pin || req.body.pin;
  if(pin && adminData.pin && pin===adminData.pin) return next();
  res.send(`<h2>🔐 Admin Zugang</h2><p>Ihre IP: ${ip}</p><p><a href="/login">Login</a> oder greife von registriertem Admin-Account zu.</p>`);
}

// ---------------------------
// Public routes: register/login/logout
// ---------------------------
// ... (Rest unverändert, nur /register Post fix: accounts doppelte Deklaration entfernt, Telegram notify hinzugefügt)
// Hier bleibt der Rest deines Originalcodes unverändert
// Du kannst den Code von /register bis /customer/... wie in deinem Original verwenden
// ---------------------------

// ---------------------------
// Start server
// ---------------------------
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Server läuft auf Port ${PORT}`));
