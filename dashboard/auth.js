import fs from "fs";
import path from "path";
import crypto from "crypto";

const DATA_DIR = path.resolve(process.cwd(), "data");
console.log("🔍 DATA_DIR:", DATA_DIR);
const ACCOUNTS_FILE = path.join(DATA_DIR, "accounts.json");

function loadAccounts() {
  if (!fs.existsSync(ACCOUNTS_FILE)) return [];
  return JSON.parse(fs.readFileSync(ACCOUNTS_FILE, "utf8"));
}
function saveAccounts(a) {
  fs.writeFileSync(ACCOUNTS_FILE, JSON.stringify(a, null, 2), "utf8");
}

export function parseCookies(req) {
  const h = req.headers?.cookie || "";
  const o = {};
  h.split(";").map(s=>s.trim()).filter(Boolean).forEach(p=>{
    const i=p.indexOf("=");
    if(i>-1) o[p.slice(0,i)] = decodeURIComponent(p.slice(i+1));
  });
  return o;
}

export function setCookie(res,name,value,opts={}) {
  let c = `${name}=${encodeURIComponent(value)}`;
  if(opts.maxAge) c+=`; Max-Age=${opts.maxAge}`;
  if(opts.httpOnly) c+=`; HttpOnly`;
  if(opts.path) c+=`; Path=${opts.path}`;
  c+=`; SameSite=${opts.sameSite||"Lax"}`;
  res.setHeader("Set-Cookie", c);
}

export function requireAuth(req,res,next) {
  const token = parseCookies(req).deviceToken;
  if(!token) return res.redirect("/login");

  const acc = loadAccounts().find(a => (a.deviceTokens||[]).includes(token));
  if(!acc) return res.redirect("/login");

  if(!acc.approved) return res.send("⛔ Account wartet auf Freigabe.");
  req.user = acc;
  next();
}

export function requireAdmin(req,res,next) {
  if(!req.user) return res.redirect("/login");
  if(req.user.role==="admin" || req.user.role==="superadmin") return next();
  res.send("🚫 Nur Admins.");
}

export function hashPassword(pw, salt=null){
  salt = salt || crypto.randomBytes(16).toString("hex");
  return { salt, hash: crypto.scryptSync(pw, salt, 64).toString("hex") };
}
export function verifyPassword(pw, salt, hash){
  try {
    return crypto.timingSafeEqual(
      Buffer.from(crypto.scryptSync(pw,salt,64).toString("hex"),"hex"),
      Buffer.from(hash,"hex")
    );
  } catch { return false; }
}

export { loadAccounts, saveAccounts };

