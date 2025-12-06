import express from "express";
import crypto from "crypto";
import {
  loadAccounts,
  saveAccounts,
  requireAuth,
  requireAdmin,
  setCookie,
  hashPassword,
  verifyPassword
} from "./auth.js";

import { loadBots, saveBots, createBot } from "./bots.js";
import { startTelegramBots } from "../channels/telegram/oneBot.js";

const router = express.Router();

/* =========================
   STYLE + LAYOUT
========================= */
const baseStyle = (dark=false)=>`
<style>
*{box-sizing:border-box}
body{margin:0;font-family:system-ui,sans-serif;background:${dark?"#111":"#f4f4f4"};color:${dark?"#eee":"#111"}}
.container{max-width:900px;margin:40px auto;background:${dark?"#1a1a1a":"#fff"};padding:32px;border-radius:12px}
nav a{margin-right:16px;font-weight:600}
input,button,select{width:100%;padding:14px;margin-top:10px;font-size:16px}
button{border:none;border-radius:6px;cursor:pointer}
.primary{background:#4f46e5;color:white}
.danger{background:#b91c1c;color:white}
.card{border:1px solid #9994;padding:16px;border-radius:8px;margin-bottom:12px}
</style>
`;

function layout(req={}, content){
  const role = req.user?.role || "guest";
  return `<!doctype html>
<html>
<head><meta charset="utf-8">${baseStyle(req.user?.darkMode)}</head>
<body>
<nav class="container">
  <a href="/dashboard/account">Account</a>
  <a href="/dashboard/bots">Bots</a>
  ${role!=="customer"&&role!=="guest"
    ? `<a href="/dashboard/customers">Kunden</a>
       <a href="/dashboard/admin">Admin</a>`:""}
  ${role!=="guest"?`<a href="/logout" style="color:#e11d48">Logout</a>`:""}
</nav>
<div class="container">${content}</div>
</body></html>`;
}

/* =========================
   REGISTER
========================= */
router.get("/register",(req,res)=>{
  res.send(layout({},`
<h2>Registrierung</h2>
<form method="POST">
<input name="firstName" placeholder="Vorname" required>
<input name="lastName" placeholder="Nachname" required>
<input name="email" placeholder="Email">
<input name="phone" placeholder="Telefon">
<input type="password" name="password" placeholder="Passwort" required>
<input type="password" name="password2" placeholder="Bestätigen" required>
<button class="primary">Registrieren</button>
</form>
<p>Email ODER Telefon erforderlich</p>
`));
});

router.post("/register",(req,res)=>{
  const {firstName,lastName,email,phone,password,password2}=req.body;

  if(!email && !phone) return res.send("❌ Email oder Telefon nötig");
  if(password!==password2) return res.send("❌ Passwörter stimmen nicht");

  const accounts = loadAccounts();
  if(email && accounts.some(a=>a.email===email)) return res.send("❌ Email existiert");
  if(phone && accounts.some(a=>a.phone===phone)) return res.send("❌ Telefon existiert");

  const {salt,hash} = hashPassword(password);
  const isFirst = !accounts.some(a=>a.role==="superadmin");

  accounts.push({
    firstName,lastName,
    email:email||null,
    phone:phone||null,
    salt,hash,
    role:isFirst?"superadmin":"customer",
    approved:isFirst,
    deviceTokens:[],
    darkMode:false
  });

  saveAccounts(accounts);

  res.send(isFirst
    ? "✅ Superadmin erstellt. <a href='/login'>Login</a>"
    : "✅ Registrierung erfolgreich – wartet auf Freigabe");
});

/* =========================
   LOGIN
========================= */
router.get("/login",(req,res)=>{
  res.send(layout({},`
<h2>Login</h2>
<form method="POST">
<input name="identifier" placeholder="Email oder Telefon" required>
<input type="password" name="password" required>
<button class="primary">Login</button>
</form>`));
});

router.post("/login",(req,res)=>{
  const {identifier,password}=req.body;
  const accounts=loadAccounts();
  const acc=accounts.find(a=>a.email===identifier||a.phone===identifier);

  if(!acc||!verifyPassword(password,acc.salt,acc.hash))
    return res.send("❌ Login fehlgeschlagen");
  if(!acc.approved) return res.send("⛔ Wartet auf Freigabe");

  const token=crypto.randomBytes(32).toString("hex");
  acc.deviceTokens.push(token);
  saveAccounts(accounts);

  setCookie(res,"deviceToken",token,{httpOnly:true});
  res.redirect("/dashboard/account");
});

/* =========================
   DASHBOARD
========================= */
router.get("/dashboard",(req,res)=>res.redirect("/dashboard/account"));

router.get("/dashboard/account",requireAuth,(req,res)=>{
  res.send(layout(req,`
<h2>Account</h2>
<p>${req.user.firstName} (${req.user.role})</p>
`));
});

/* =========================
   KUNDENÜBERSICHT
========================= */
router.get("/dashboard/customers",requireAuth,requireAdmin,(req,res)=>{
  const accounts=loadAccounts();
  const bots=loadBots();

  let html="<h2>Kundenübersicht</h2>";

  accounts.filter(a=>a.role==="customer").forEach((a,i)=>{
    const owned = bots.filter(b=>b.ownerEmail===a.email).length;

    html+=`
<div class="card">
<b>${a.firstName} ${a.lastName}</b><br>
Email: ${a.email||"-"}<br>
Status: ${a.approved?"✅ aktiv":"⛔ gesperrt"}<br>
Bots: ${owned}

${req.user.role==="superadmin"?`
<form method="POST" action="/dashboard/customers/delete"
onsubmit="return confirm('Kunde löschen?')">
<input type="hidden" name="idx" value="${i}">
<button class="danger">🗑 Kunde löschen</button>
</form>`:""}
</div>`;
  });

  res.send(layout(req,html));
});

router.post("/dashboard/customers/delete",requireAuth,requireAdmin,(req,res)=>{
  if(req.user.role!=="superadmin") return res.send("🚫");
  const accs=loadAccounts();
  accs.splice(Number(req.body.idx),1);
  saveAccounts(accs);
  res.redirect("/dashboard/customers");
});

/* =========================
   BOTS
========================= */
router.get("/dashboard/bots",requireAuth,(req,res)=>{
  const bots=loadBots();
  const visible=req.user.role==="customer"
    ? bots.filter(b=>b.ownerEmail===req.user.email)
    : bots;

  let html="<h2>Bots</h2>";

  visible.forEach(b=>{
    html+=`
<div class="card">
<b>${b.name}</b><br>
Owner: ${b.ownerEmail}<br>
Status: ${b.active?"✅":"⛔"}<br>
Telegram IDs: ${b.allowedTelegramIds?.join(", ")||"-"}
</div>`;
  });

  if(req.user.role!=="customer"){
    html+=`
<h3>➕ Bot erstellen (vollständig)</h3>
<form method="POST" action="/dashboard/bots/create">
<input name="name" placeholder="Bot Name" required>
<input name="ownerEmail" placeholder="Owner Email" required>
<input name="token" placeholder="Telegram Bot Token" required>
<input name="telegramIds" placeholder="Telegram IDs (kommagetrennt)">
<label><input type="checkbox" name="active" checked> aktiv</label>
<button class="primary">Bot erstellen</button>
</form>`;
  }

  res.send(layout(req,html));
});

router.post("/dashboard/bots/create",requireAuth,requireAdmin,(req,res)=>{
  const bots=loadBots();

  const telegramIds =
    req.body.telegramIds?.split(",").map(x=>x.trim()).filter(Boolean) || [];

  bots.push({
    ...createBot(req.body.name, req.body.ownerEmail),
    token:req.body.token,
    active:!!req.body.active,
    allowedTelegramIds:telegramIds
  });

  saveBots(bots);
  startTelegramBots();
  res.redirect("/dashboard/bots");
});

/* =========================
   ADMIN – FREIGABE
========================= */
router.get("/dashboard/admin",requireAuth,requireAdmin,(req,res)=>{
  const accs=loadAccounts();
  let html="<h2>Admin – Freigaben</h2>";

  accs.forEach((a,i)=>{
    if(a.approved) return;
    html+=`
<div class="card">
<b>${a.firstName} ${a.lastName}</b>
<form method="POST" action="/dashboard/admin/approve">
<input type="hidden" name="idx" value="${i}">
<select name="role">
<option value="customer">Customer</option>
${req.user.role==="superadmin"?`<option value="admin">Admin</option>`:""}
</select>
<button class="primary">✅ Freigeben</button>
</form>
</div>`;
  });

  res.send(layout(req,html));
});

router.post("/dashboard/admin/approve",requireAuth,requireAdmin,(req,res)=>{
  const accs=loadAccounts();
  const acc=accs[req.body.idx];
  if(!acc) return res.send("❌");

  acc.approved=true;
  acc.role=req.body.role;
  saveAccounts(accs);

  res.redirect("/dashboard/admin");
});

/* =========================
   LOGOUT
========================= */
router.get("/logout",(req,res)=>{
  res.setHeader("Set-Cookie","deviceToken=; Path=/; Max-Age=0");
  res.redirect("/login");
});

export default router;
