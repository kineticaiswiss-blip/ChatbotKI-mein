import fs from "fs";
import path from "path";
import crypto from "crypto";

/* =========================
   RENDER PERSISTENT DISK
========================= */
const DATA_DIR = "/var/data";   // ✅ exakt wie deine Disk
const ACCOUNTS_FILE = path.join(DATA_DIR, "accounts.json");

// ✅ sicherstellen, dass Disk & Datei existieren
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}
if (!fs.existsSync(ACCOUNTS_FILE)) {
  fs.writeFileSync(ACCOUNTS_FILE, "[]", "utf8");
}

/* =========================
   STORAGE
========================= */
function loadAccounts() {
  return JSON.parse(fs.readFileSync(ACCOUNTS_FILE, "utf8"));
}

function saveAccounts(accounts) {
  fs.writeFileSync(
    ACCOUNTS_FILE,
    JSON.stringify(accounts, null, 2),
    "utf8"
  );
}

/* =========================
   COOKIES
========================= */
function parseCookies(req) {
  const header = req.headers?.cookie || "";
  const cookies = {};
  header.split(";").forEach(part => {
    const i = part.indexOf("=");
    if (i > -1) {
      cookies[part.slice(0, i).trim()] =
        decodeURIComponent(part.slice(i + 1));
    }
  });
  return cookies;
}

function setCookie(res, name, value, opts = {}) {
  let cookie = `${name}=${encodeURIComponent(value)}; Path=/; SameSite=Lax`;
  if (opts.httpOnly) cookie += "; HttpOnly";
  if (opts.maxAge) cookie += `; Max-Age=${opts.maxAge}`;
  res.setHeader("Set-Cookie", cookie);
}

/* =========================
   AUTH MIDDLEWARE
========================= */
function requireAuth(req, res, next) {
  const token = parseCookies(req).deviceToken;
  if (!token) return res.redirect("/login");

  const acc = loadAccounts().find(a =>
    Array.isArray(a.deviceTokens) && a.deviceTokens.includes(token)
  );

  if (!acc) return res.redirect("/login");
  if (!acc.approved) return res.send("⛔ Wartet auf Admin-Freigabe");

  req.user = acc;
  next();
}

function requireAdmin(req, res, next) {
  if (req.user.role === "admin" || req.user.role === "superadmin") {
    return next();
  }
  return res.send("🚫 Nur Admins erlaubt");
}

/* =========================
   PASSWORDS
========================= */
function hashPassword(password, salt = null) {
  salt = salt || crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");
  return { salt, hash };
}

function verifyPassword(password, salt, hash) {
  const check = crypto.scryptSync(password, salt, 64).toString("hex");
  return crypto.timingSafeEqual(
    Buffer.from(check, "hex"),
    Buffer.from(hash, "hex")
  );
}

/* =========================
   EXPORTS (❗WICHTIG)
========================= */
export {
  loadAccounts,
  saveAccounts,
  parseCookies,
  setCookie,        // ✅ FEHLTE EVTL. ODER WAR FALSCH
  requireAuth,
  requireAdmin,
  hashPassword,
  verifyPassword
};
