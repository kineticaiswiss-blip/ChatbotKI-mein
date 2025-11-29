import fs from "fs";
import path from "path";
import crypto from "crypto";

/* =========================
   PERSISTENTE DISK (RENDER)
========================= */
const DATA_DIR = "/data";
const ACCOUNTS_FILE = path.join(DATA_DIR, "accounts.json");

// ✅ Disk & Datei erzwingen
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
   AUTH
========================= */
export function parseCookies(req) {
  const h = req.headers?.cookie || "";
  const o = {};
  h.split(";").forEach(p => {
    const i = p.indexOf("=");
    if (i > -1) o[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1));
  });
  return o;
}

export function setCookie(res, name, value, opts = {}) {
  let c = `${name}=${encodeURIComponent(value)}; Path=/; SameSite=Lax`;
  if (opts.httpOnly) c += "; HttpOnly";
  if (opts.maxAge) c += `; Max-Age=${opts.maxAge}`;
  res.setHeader("Set-Cookie", c);
}

export function requireAuth(req, res, next) {
  const token = parseCookies(req).deviceToken;
  if (!token) return res.redirect("/login");

  const acc = loadAccounts().find(a =>
    (a.deviceTokens || []).includes(token)
  );

  if (!acc) return res.redirect("/login");
  if (!acc.approved) return res.send("⛔ Wartet auf Admin-Freigabe");

  req.user = acc;
  next();
}

export function requireAdmin(req, res, next) {
  if (req.user.role === "admin" || req.user.role === "superadmin") return next();
  res.send("🚫 Nur Admins");
}

/* =========================
   PASSWORDS
========================= */
export function hashPassword(pw, salt = null) {
  salt = salt || crypto.randomBytes(16).toString("hex");
  return {
    salt,
    hash: crypto.scryptSync(pw, salt, 64).toString("hex")
  };
}

export function verifyPassword(pw, salt, hash) {
  const check = crypto.scryptSync(pw, salt, 64).toString("hex");
  return crypto.timingSafeEqual(
    Buffer.from(check, "hex"),
    Buffer.from(hash, "hex")
  );
}

export { loadAccounts, saveAccounts };
