// app.js – Vollversion: Superadmin/Admin/Kunden/Bots/TG/Intelligente Bots
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
// Directories / Files
// ---------------------------
const DATA_DIR = "./data";
const ACCOUNTS_FILE = path.join(DATA_DIR, "accounts.json");
const PENDING_FILE = path.join(DATA_DIR, "pending.json");
const BOTS_FILE = path.join(DATA_DIR, "bots.json");
const CUSTOMERS_FILE = path.join(DATA_DIR, "customers.json");

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
[ACCOUNTS_FILE, PENDING_FILE, BOTS_FILE, CUSTOMERS_FILE].forEach(f => { if(!fs.existsSync(f)) fs.writeFileSync(f,"[]") });

// ---------------------------
// Helpers
// ---------------------------
function readJSON(file,fallback=[]){try{return JSON.parse(fs.readFileSync(file,"utf8"))}catch{return fallback}}
function writeJSON(file,obj){fs.writeFileSync(file,JSON.stringify(obj,null,2),"utf8")}

function hashPassword(pw,salt=null){salt=salt||crypto.randomBytes(16).toString("hex");return{salt,hash:crypto.scryptSync(pw,salt,64).toString("hex")}}
function verifyPassword(pw,salt,hash){try{return crypto.timingSafeEqual(Buffer.from(crypto.scryptSync(pw,salt,64).toString("hex"),"hex"),Buffer.from(hash,"hex"))}catch{return false}}

function getClientIp(req){const xf=req.headers["x-forwarded-for"]||req.headers["x-forwarded-for".toLowerCase()];if(xf)return String(xf).split(",")[0].trim();return (req.socket && req.socket.remoteAddress)||req.ip||""}

function parseCookies(req){const h=req.headers?.cookie||"";const o={};h.split(";").map(s=>s.trim()).filter(Boolean).forEach(p=>{const i=p.indexOf("=");if(i>-1)o[p.slice(0,i)]=decodeURIComponent(p.slice(i+1))});return o}
function setCookie(res,name,value,opts={}){let c=`${name}=${encodeURIComponent(value)}`;if(opts.maxAge)c+=`; Max-Age=${opts.maxAge}`;if(opts.httpOnly)c+=`; HttpOnly`;if(opts.path)c+=`; Path=${opts.path}`;if(opts.secure||process.env.NODE_ENV==="production")c+=`; Secure`;c+=`; SameSite=${opts.sameSite||'Lax'}`;res.setHeader("Set-Cookie",c)}

// ---------------------------
// Load / Save Functions
// ---------------------------
function loadAccounts(){return readJSON(ACCOUNTS_FILE,[])}
function saveAccounts(a){writeJSON(ACCOUNTS_FILE,a)}
function loadPending(){return readJSON(PENDING_FILE,[])}
function savePending(p){writeJSON(PENDING_FILE,p)}
function loadBots(){return readJSON(BOTS_FILE,[])}
function saveBots(b){writeJSON(BOTS_FILE,b)}
function loadCustomers(){return readJSON(CUSTOMERS_FILE,[])}
function saveCustomers(c){writeJSON(CUSTOMERS_FILE,c)}

// ---------------------------
// Middleware
// ---------------------------
function requireAuth(req,res,next){
  const cookies=parseCookies(req); const token=cookies.deviceToken; 
  if(!token)return res.redirect("/register");
  const accounts=loadAccounts(); const acc=accounts.find(a=>a.deviceToken===token); 
  if(!acc)return res.redirect("/register"); 
  req.user=acc; next();
}
function requireAdmin(req,res,next){
  if(!req.user)return res.redirect("/register");
  if(req.user.role==="admin"||req.user.role==="superadmin")return next();
  res.send("🚫 Zugriff verweigert. Nur Admins.");
}

// ---------------------------
// OpenAI Setup für Bots (Mitarbeiter-Modus)
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ---------------------------
// Telegram Bots
// ---------------------------
const botsInstances = {}; 
const RENDER_URL = process.env.RENDER_URL || process.env.PRIMARY_URL;

async function initBot(botToken, botId, customerName){
  if(!botToken) return;
  const bot = new Telegraf(botToken);
  const accounts = loadAccounts();
  const superadmin = accounts.find(a=>a.role==="superadmin");
  const admins = accounts.filter(a=>a.role==="admin");
  const customersWithBot = accounts.filter(a=>a.assignedBots?.includes(botId));

  bot.start(ctx=>{
    const uid=ctx.from.id;
    if([superadmin, ...admins].some(a=>a.telegramId===uid)) return ctx.reply("Admin-Modus aktiviert.");
    if(customersWithBot.some(c=>c.telegramId===uid)) return ctx.reply("Bot-Modus aktiviert.");
    ctx.reply("🚫 Du bist kein berechtigter Benutzer.");
  });

  bot.on("text",async ctx=>{
    try{
      const uid=ctx.from.id;
      const isAdmin=[superadmin,...admins].some(a=>a.telegramId===uid);
      const isCustomer=customersWithBot.some(c=>c.telegramId===uid);
      if(!isAdmin && !isCustomer)return ctx.reply("🚫 Keine Rechte.");
      const msg=ctx.message.text.trim();

      // Admin/Bot-Kommandos
      if(msg.startsWith("/data")||msg.startsWith("/setinfo")){
        ctx.reply(isAdmin ? "✅ Admin-Befehl ausgeführt." : "✅ Kunde-Befehl ausgeführt."); 
        return;
      }

      // OpenAI "Mitarbeiter-Modus"
      const customerInfo = loadCustomers().find(c=>c.name===customerName)?.info || "";
      const messages = [
        {role:"system", content:`Du bist der virtuelle Mitarbeiter für ${customerName}. Antworte nur basierend auf den Kundendaten. Wenn du keine Infos hast, sage: "Das weiß ich nicht."`},
        {role:"user", content:`INFO:\n${customerInfo}\n\nFrage: ${msg}`}
      ];
      const gpt = await openai.chat.completions.create({
        model:"gpt-4o-mini",
        messages,
        max_tokens:300,
        temperature:0
      });
      const answer = gpt.choices[0].message.content.trim();
      ctx.reply(answer);
    }catch(err){
      console.error("OpenAI Fehler:",err);
      ctx.reply("⚠️ Fehler beim Beantworten.");
    }
  });

  // Webhook für Render
  if(RENDER_URL){
    try{
      await bot.telegram.setWebhook(`${RENDER_URL}/bot/${botId}`);
      console.log(`Webhook für Bot ${botId} gesetzt`);
    } catch(err){
      console.error("Webhook-Fehler, starte Polling:",err);
      await bot.launch({dropPendingUpdates:true});
    }
  } else {
    await bot.launch({dropPendingUpdates:true});
  }

  botsInstances[botId]=bot;
}

// --- Webhook Route für Render ---
app.use(express.json());
app.post("/bot/:botId", async (req,res)=>{
  const botId = req.params.botId;
  const bot = botsInstances[botId];
  if(bot){
    try{await bot.handleUpdate(req.body);}catch(err){console.error(err);}
  }
  res.sendStatus(200);
});

// --- Init bestehender Bots ---
loadBots().forEach(b=>initBot(b.token,b.id,b.name).catch(console.error));

// ---------------------------
// Routes (Register/Dashboard/Approve/Reject)
// ---------------------------

// Registrierung / Erstes Gerät
app.get("/register",(req,res)=>{
  const accounts=loadAccounts();
  const cookies=parseCookies(req);
  const token=cookies.deviceToken;
  if(accounts.length===0){
    const deviceToken=crypto.randomBytes(12).toString("hex");
    setCookie(res,"deviceToken",deviceToken,{httpOnly:true});
    res.send(`<h2>Erstes Gerät → Superadmin</h2>
      <form method="POST">
        Passwort: <input name="password" type="password" required/>
        <button>Erstellen</button>
      </form>`);
  }else if(token && accounts.find(a=>a.deviceToken===token)){
    res.redirect("/dashboard");
  }else{
    res.send(`<h2>Neues Gerät – Registrierung</h2>
      <form method="POST">
        Vorname: <input name="firstName" required/><br/>
        Nachname: <input name="lastName" required/><br/>
        Firma: <input name="company" required/><br/>
        E-Mail: <input name="email" required/><br/>
        Handynummer: <input name="phone" required/><br/>
        Gewünschte Rolle: 
        <select name="role"><option value="customer">Kunde</option><option value="admin">Admin</option></select><br/>
        <button>Registrieren</button>
      </form>`);
  }
});

app.post("/register",(req,res)=>{
  const accounts=loadAccounts();
  const pending=loadPending();
  const cookies=parseCookies(req);
  const token=cookies.deviceToken;
  if(accounts.length===0){
    const deviceToken=crypto.randomBytes(12).toString("hex");
    const {salt,hash}=hashPassword(req.body.password);
    accounts.push({deviceToken,role:"superadmin",passwordHash:hash,salt,firstName:"Super",lastName:"Admin",assignedBots:[],telegramId:null});
    saveAccounts(accounts);
    setCookie(res,"deviceToken",deviceToken,{httpOnly:true});
    res.send("Superadmin erstellt. <a href='/dashboard'>Dashboard</a>");
    return;
  }
  pending.push({...req.body,id:crypto.randomBytes(8).toString("hex"),status:"pending",created:Date.now()});
  savePending(pending);
  res.send("Registrierung abgeschickt. Superadmin/Admin wird prüfen.");
});

// Dashboard
app.get("/dashboard",requireAuth,(req,res)=>{
  const accounts=loadAccounts();
  const pending=loadPending();
  const bots=loadBots();
  const customers=loadCustomers();
  let html=`<h1>Dashboard</h1><p>Hallo ${req.user.firstName} ${req.user.lastName} [${req.user.role}]</p>`;
  if(req.user.role==="customer"){
    html+="<h2>Deine Bots</h2>";
    if(req.user.assignedBots?.length>0){
      req.user.assignedBots.forEach(bid=>{
        const b=bots.find(bb=>bb.id===bid);
        if(b) html+=`<p>${b.name}</p>`;
      });
    } else html+="<p>Kein Bot zugewiesen</p>";
    res.send(html);
    return;
  }
  // Admin/Superadmin
  html+="<h2>Pending Registrierungen</h2>";
  pending.forEach(p=>{
    html+=`<p>${p.firstName} ${p.lastName} (${p.role}) - <a href="/approve/${p.id}?as=customer">Als Kunde</a> | <a href="/approve/${p.id}?as=admin">Als Admin</a> | <a href="/reject/${p.id}">Ablehnen</a></p>`;
  });
  html+="<h2>Kunden</h2>";
  accounts.filter(a=>a.role==="customer").forEach(c=>{
    html+=`<p>${c.firstName} ${c.lastName} - Bots: ${(c.assignedBots||[]).map(id=>bots.find(b=>b.id===id)?.name).join(", ")}</p>`;
  });
  html+="<h2>Bots</h2>";
  bots.forEach(b=>{
    html+=`<p>${b.name} - ID: ${b.id} - Zugewiesen an: ${(accounts.filter(a=>a.assignedBots?.includes(b.id)).map(a=>a.firstName)).join(", ")}</p>`;
  });
  res.send(html);
});

// Approve / Reject
app.get("/approve/:id",(req,res)=>{
  const accounts=loadAccounts();
  const pending=loadPending();
  const {id}=req.params;
  const as=req.query.as; 
  const p=pending.find(r=>r.id===id);
  if(!p){res.send("Nicht gefunden"); return;}
  const deviceToken=crypto.randomBytes(12).toString("hex");
  const {salt,hash}=hashPassword("changeme");
  accounts.push({...p,deviceToken,passwordHash:hash,salt,role:as,assignedBots:[],telegramId:null});
  saveAccounts(accounts);
  savePending(pending.filter(r=>r.id!==id));
  res.redirect("/dashboard");
});

app.get("/reject/:id",(req,res)=>{
  const pending=loadPending();
  savePending(pending.filter(r=>r.id!==req.params.id));
  res.redirect("/dashboard");
});

// Bot hinzufügen
app.post("/addbot",requireAuth,requireAdmin,(req,res)=>{
  const {name,token,customerName}=req.body;
  const bots=loadBots();
  const botId=crypto.randomBytes(6).toString("hex");
  bots.push({id:botId,name,token,customerName});
  saveBots(bots);
  initBot(token,botId,customerName);
  res.send("Bot hinzugefügt");
});

// ---------------------------
// Start server
const PORT = process.env.PORT || 10000;
app.listen(PORT,()=>console.log(`Server läuft auf Port ${PORT}`));

