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
  ${role!=="customer" && role!=="guest"
    ? `<a href="/dashboard/customers">Kunden</a>
       <a href="/dashboard/admin">Admin</a>`:""}
  ${role!=="guest"?`<a href="/logout" style="color:#e11d48">Logout</a>`:""}
</nav>

<div class="container">${content}</div>
</body>
</html>`;
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
  const {firstName,lastName,email,phone,password,password2} = req.body;
  if(!email && !phone) return res.send("❌ Email oder Telefon nötig");
  if(password!==password2) return res.send("❌ Passwörter stimmen nicht");

  const accs = loadAccounts();
  if(email && accs.some(a=>a.email===email)) return res.send("❌ Email existiert");
  if(phone && accs.some(a=>a.phone===phone)) return res.send("❌ Telefon existiert");

  const {salt,hash} = hashPassword(password);
  const isFirst = !accs.some(a=>a.role==="superadmin");

  accs.push({
    firstName,lastName,
    email:email||null,
    phone:phone||null,
    salt,hash,
    role:isFirst?"superadmin":"customer",
    approved:isFirst,
    deviceTokens:[],
    darkMode:false
  });

  saveAccounts(accs);
  res.send(isFirst
    ? "✅ Superadmin erstellt. <a href='/login'>Login</a>"
    : "✅ Registrierung – wartet auf Freigabe");
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
  const {identifier,password} = req.body;
  const accs = loadAccounts();
  const acc = accs.find(a=>a.email===identifier||a.phone===identifier);

  if(!acc||!verifyPassword(password,acc.salt,acc.hash))
    return res.send("❌ Login fehlgeschlagen");
  if(!acc.approved) return res.send("⛔ Wartet auf Freigabe");

  const token=crypto.randomBytes(32).toString("hex");
  acc.deviceTokens.push(token);
  saveAccounts(accs);
  setCookie(res,"deviceToken",token,{httpOnly:true});
  res.redirect("/dashboard/account");
});

/* =========================
   ACCOUNT
========================= */
router.get("/dashboard",(req,res)=>res.redirect("/dashboard/account"));

router.get("/dashboard/account",requireAuth,(req,res)=>{
  res.send(layout(req,`
<h2>Account</h2>
<p>${req.user.firstName} (${req.user.role})</p>

<form method="POST" action="/dashboard/toggle-theme">
<button>🌙 / ☀️ Dark / Light wechseln</button>
</form>

<h3>Passwort ändern</h3>
<form method="POST" action="/dashboard/change-password">
<input type="password" name="oldPw" placeholder="Altes Passwort" required>
<input type="password" name="newPw1" placeholder="Neues Passwort" required>
<input type="password" name="newPw2" placeholder="Neues Passwort bestätigen" required>
<button class="primary">Passwort ändern</button>
</form>
`));
});

router.post("/dashboard/toggle-theme",requireAuth,(req,res)=>{
  const accs=loadAccounts();
  const acc=accs.find(a=>a.email===req.user.email);
  acc.darkMode=!acc.darkMode;
  saveAccounts(accs);
  res.redirect("/dashboard/account");
});

router.post("/dashboard/change-password",requireAuth,(req,res)=>{
  const {oldPw,newPw1,newPw2}=req.body;
  if(newPw1!==newPw2) return res.send("❌ Passwörter stimmen nicht");

  const accs=loadAccounts();
  const acc=accs.find(a=>a.email===req.user.email);
  if(!verifyPassword(oldPw,acc.salt,acc.hash))
    return res.send("❌ Altes Passwort falsch");

  Object.assign(acc,hashPassword(newPw1));
  saveAccounts(accs);
  res.redirect("/dashboard/account");
});

/* =========================
   BOTS – ERSTELLEN & BEARBEITEN
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
<form method="POST" action="/dashboard/bots/update">
<input type="hidden" name="id" value="${b.id}">

<input name="name" value="${b.name}">
<input name="ownerEmail" value="${b.ownerEmail}">
<input name="token" value="${b.token||""}">
<input name="telegramIds" value="${b.allowedTelegramIds?.join(",")||""}">
<label><input type="checkbox" name="active" ${b.active?"checked":""}> aktiv</label>

<button class="primary">💾 Speichern</button>
</form>

${req.user.role==="superadmin"?`
<form method="POST" action="/dashboard/bots/delete">
<input type="hidden" name="id" value="${b.id}">
<button class="danger">🗑 Löschen</button>
</form>`:""}
</div>`;
  });

  if(req.user.role!=="customer"){
    html+=`
<h3>➕ Bot erstellen</h3>
<form method="POST" action="/dashboard/bots/create">
<input name="name" required>
<input name="ownerEmail" required>
<input name="token" required>
<input name="telegramIds">
<label><input type="checkbox" name="active" checked> aktiv</label>
<button class="primary">Erstellen</button>
</form>`;
  }

  res.send(layout(req,html));
});

router.post("/dashboard/bots/create",requireAuth,requireAdmin,(req,res)=>{
  const bots=loadBots();
  bots.push({
    ...createBot(req.body.name,req.body.ownerEmail),
    token:req.body.token,
    active:!!req.body.active,
    allowedTelegramIds:req.body.telegramIds?.split(",").map(x=>x.trim()).filter(Boolean)||[]
  });
  saveBots(bots);
  startTelegramBots();
  res.redirect("/dashboard/bots");
});

router.post("/dashboard/bots/update",requireAuth,requireAdmin,(req,res)=>{
  const bots=loadBots();
  const b=bots.find(x=>x.id===req.body.id);
  if(!b) return res.send("❌ Bot nicht gefunden");

  b.name=req.body.name;
  b.ownerEmail=req.body.ownerEmail;
  b.token=req.body.token;
  b.active=!!req.body.active;
  b.allowedTelegramIds=req.body.telegramIds?.split(",").map(x=>x.trim()).filter(Boolean)||[];

  saveBots(bots);
  startTelegramBots();
  res.redirect("/dashboard/bots");
});

router.post("/dashboard/bots/delete",requireAuth,requireAdmin,(req,res)=>{
  if(req.user.role!=="superadmin") return res.send("🚫");
  saveBots(loadBots().filter(b=>b.id!==req.body.id));
  startTelegramBots();
  res.redirect("/dashboard/bots");
});

/* =========================
   ADMIN – FREIGABE + LÖSCHEN
========================= */
router.get("/dashboard/admin",requireAuth,requireAdmin,(req,res)=>{
  const accs=loadAccounts();
  let html="<h2>Admin Übersicht</h2>";

  accs.forEach((a,i)=>{
    html+=`
<div class="card">
<b>${a.firstName} ${a.lastName}</b> – ${a.role}
${!a.approved?`
<form method="POST" action="/dashboard/admin/approve">
<input type="hidden" name="idx" value="${i}">
<select name="role">
<option value="customer">Customer</option>
${req.user.role==="superadmin"?`<option value="admin">Admin</option>`:""}
</select>
<button class="primary">Freigeben</button>
</form>`:""}

${req.user.role==="superadmin"?`
<form method="POST" action="/dashboard/admin/delete">
<input type="hidden" name="idx" value="${i}">
<button class="danger">🗑 Löschen</button>
</form>`:""}
</div>`;
  });

  res.send(layout(req,html));
});

router.post("/dashboard/admin/approve",requireAuth,requireAdmin,(req,res)=>{
  const accs=loadAccounts();
  const acc=accs[req.body.idx];
  acc.approved=true;
  acc.role=req.body.role;
  saveAccounts(accs);
  res.redirect("/dashboard/admin");
});

router.post("/dashboard/admin/delete",requireAuth,requireAdmin,(req,res)=>{
  if(req.user.role!=="superadmin") return res.send("🚫");
  const accs=loadAccounts();
  accs.splice(req.body.idx,1);
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
