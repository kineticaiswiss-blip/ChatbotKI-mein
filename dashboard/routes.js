import express from "express";
import crypto from "crypto";
import {
  loadAccounts,
  saveAccounts,
  requireAuth,
  requireAdmin,
  setCookie,
  parseCookies,
  hashPassword,
  verifyPassword
} from "./auth.js";

import { loadBots, saveBots, createBot } from "./bots.js";
import { startTelegramBots } from "../channels/telegram/oneBot.js";

const router = express.Router();

/* =========================
   GLOBAL STYLE
========================= */
const baseStyle = (dark=false)=>`
<style>
*{box-sizing:border-box}
body{margin:0;font-family:system-ui,sans-serif;background:${dark?"#111":"#f4f4f4"};color:${dark?"#eee":"#111"}}
.container{max-width:900px;margin:40px auto;background:${dark?"#1a1a1a":"#fff"};padding:32px;border-radius:12px}
nav a{margin-right:16px;font-weight:600}
input,button{width:100%;padding:14px;margin-top:10px;font-size:16px}
button{border:none;border-radius:6px;cursor:pointer}
.primary{background:#4f46e5;color:white}
.danger{background:#b91c1c;color:white}
.card{border:1px solid #9994;padding:16px;border-radius:8px;margin-bottom:12px}
</style>
`;

function layout(req, content){
  return `<!doctype html><html><head><meta charset="utf-8">
  ${baseStyle(req.user?.darkMode)}
  </head><body>
  <nav class="container">
    <a href="/dashboard/account">Account</a>
    <a href="/dashboard/bots">Bots</a>
    ${req.user.role!=="customer"?`<a href="/dashboard/admin">Admin</a>`:""}
    <a href="/logout" style="color:#e11d48">Logout</a>
  </nav>
  <div class="container">${content}</div>
  </body></html>`;
}

/* =========================
   AUTH
========================= */
router.get("/login",(req,res)=>{
  res.send(layout({},`
    <h2>Login</h2>
    <form method="POST">
      <input name="identifier" placeholder="Email oder Telefon" required>
      <input type="password" name="password" placeholder="Passwort" required>
      <button class="primary">Login</button>
    </form>
  `));
});

router.post("/login",(req,res)=>{
  const { identifier, password } = req.body;
  const accounts = loadAccounts();
  const acc = accounts.find(a=>a.email===identifier||a.phone===identifier);

  if(!acc || !verifyPassword(password,acc.salt,acc.hash))
    return res.send("❌ Login fehlgeschlagen");

  if(!acc.approved)
    return res.send("⛔ Noch nicht freigegeben");

  const token = crypto.randomBytes(32).toString("hex");
  acc.deviceTokens.push(token);
  saveAccounts(accounts);

  setCookie(res,"deviceToken",token,{httpOnly:true});
  res.redirect("/dashboard/account");
});

/* =========================
   DASHBOARD
========================= */
router.get("/dashboard",(req,res)=>res.redirect("/dashboard/account"));

router.get("/dashboard/account", requireAuth,(req,res)=>{
  res.send(layout(req,`
    <h2>Account</h2>
    <p>${req.user.firstName} (${req.user.role})</p>
  `));
});

/* =========================
   BOTS
========================= */
router.get("/dashboard/bots", requireAuth,(req,res)=>{
  const bots = loadBots();
  const visible =
    req.user.role==="customer"
      ? bots.filter(b=>b.ownerEmail===req.user.email)
      : bots;

  let html="<h2>Bots</h2>";

  visible.forEach(b=>{
    html+=`
      <div class="card">
        <b>${b.name}</b><br>
        ID: ${b.id}<br>
        Besitzer: ${b.ownerEmail}<br>
        Status: ${b.active?"✅":"⛔"}<br>
        Telegram IDs: ${b.allowedTelegramIds?.join(", ") || "-"}

        ${
          req.user.role!=="customer"
          ? `
          <form method="POST" action="/dashboard/bots/update">
            <input type="hidden" name="id" value="${b.id}">
            <input name="token" placeholder="Bot Token" value="${b.token||""}">
            <label>
              <input type="checkbox" name="active" ${b.active?"checked":""}>
              aktiv
            </label>
            <button class="primary">Speichern</button>
          </form>

          <form method="POST" action="/dashboard/bots/add-telegram">
            <input type="hidden" name="id" value="${b.id}">
            <input name="telegramId" placeholder="Telegram User ID">
            <button>Telegram ID hinzufügen</button>
          </form>
          `:""
        }

        ${
          req.user.role==="superadmin"
          ? `
          <form method="POST" action="/dashboard/bots/delete" 
                onsubmit="return confirm('Bot wirklich löschen?')">
            <input type="hidden" name="id" value="${b.id}">
            <button class="danger">🗑 Bot löschen</button>
          </form>
          `:""
        }
      </div>
    `;
  });

  if(req.user.role!=="customer"){
    html+=`
      <h3>➕ Bot erstellen</h3>
      <form method="POST" action="/dashboard/bots/create">
        <input name="name" placeholder="Bot Name" required>
        <input name="ownerEmail" placeholder="Owner Email" required>
        <button class="primary">Erstellen</button>
      </form>
    `;
  }

  res.send(layout(req,html));
});

/* ===== BOT ACTIONS ===== */
router.post("/dashboard/bots/create", requireAuth, requireAdmin, async (req,res)=>{
  const bots=loadBots();
  bots.push(createBot(req.body.name, req.body.ownerEmail));
  saveBots(bots);
  await startTelegramBots();
  res.redirect("/dashboard/bots");
});

router.post("/dashboard/bots/update", requireAuth, requireAdmin, async (req,res)=>{
  const bots=loadBots();
  const b=bots.find(x=>x.id===req.body.id);
  if(!b) return res.send("❌ Bot nicht gefunden");

  b.token=req.body.token||"";
  b.active=!!req.body.active;

  saveBots(bots);
  await startTelegramBots();
  res.redirect("/dashboard/bots");
});

router.post("/dashboard/bots/add-telegram", requireAuth, requireAdmin, async (req,res)=>{
  const bots=loadBots();
  const b=bots.find(x=>x.id===req.body.id);
  if(!b) return res.send("❌");

  b.allowedTelegramIds ||= [];
  if(!b.allowedTelegramIds.includes(req.body.telegramId))
    b.allowedTelegramIds.push(req.body.telegramId);

  saveBots(bots);
  await startTelegramBots();
  res.redirect("/dashboard/bots");
});

router.post("/dashboard/bots/delete", requireAuth, requireAdmin, async (req,res)=>{
  if(req.user.role!=="superadmin") return res.send("🚫");

  const bots=loadBots().filter(b=>b.id!==req.body.id);
  saveBots(bots);

  await startTelegramBots();
  res.redirect("/dashboard/bots");
});

/* =========================
   ADMIN
========================= */
router.get("/dashboard/admin", requireAuth, requireAdmin,(req,res)=>{
  const accs=loadAccounts();
  let html="<h2>Admin Übersicht</h2>";

  accs.forEach((a,i)=>{
    if(a.email===req.user.email) return;

    html+=`
      <div class="card">
        <b>${a.firstName} ${a.lastName}</b><br>
        Rolle: ${a.role}<br>
        Status: ${a.approved?"✅":"⛔"}
        ${
          req.user.role==="superadmin"
          ? `
          <form method="POST" action="/dashboard/admin/delete"
                onsubmit="return confirm('Account löschen?')">
            <input type="hidden" name="idx" value="${i}">
            <button class="danger">🗑 Account löschen</button>
          </form>
          `:""
        }
      </div>
    `;
  });

  res.send(layout(req,html));
});

router.post("/dashboard/admin/delete", requireAuth, requireAdmin,(req,res)=>{
  if(req.user.role!=="superadmin") return res.send("🚫");

  const accs=loadAccounts();
  accs.splice(Number(req.body.idx),1);
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
