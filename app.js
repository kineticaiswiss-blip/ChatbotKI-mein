// app.js – Superadmin/Admin/Kunden/Bots/TG mit Dashboard, Dokumenten & Telegram
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
const INFO_DIR = path.join(DATA_DIR, "info");

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
[ACCOUNTS_FILE, PENDING_FILE, BOTS_FILE].forEach(f => { if(!fs.existsSync(f)) fs.writeFileSync(f,"[]") });
if (!fs.existsSync(INFO_DIR)) fs.mkdirSync(INFO_DIR, { recursive: true });

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
// Load / Save Data
// ---------------------------
function loadAccounts(){return readJSON(ACCOUNTS_FILE,[])}
function saveAccounts(a){writeJSON(ACCOUNTS_FILE,a)}
function loadPending(){return readJSON(PENDING_FILE,[])}
function savePending(p){writeJSON(PENDING_FILE,p)}
function loadBots(){return readJSON(BOTS_FILE,[])}
function saveBots(b){writeJSON(BOTS_FILE,b)}
function ensureInfoFile(botId){const f=path.join(INFO_DIR,botId+".txt");if(!fs.existsSync(f))fs.writeFileSync(f,"");return f}

// ---------------------------
// Middleware
// ---------------------------
function requireAuth(req,res,next){
  const cookies=parseCookies(req); const token=cookies.deviceToken; if(!token)return res.redirect("/register");
  const accounts=loadAccounts(); const acc=accounts.find(a=>a.deviceToken===token); if(!acc)return res.redirect("/register"); req.user=acc; next();
}
function requireAdmin(req,res,next){if(!req.user)return res.redirect("/register"); if(req.user.role==="admin"||req.user.role==="superadmin")return next(); res.send("🚫 Zugriff verweigert. Nur Admins.");}

// ---------------------------
// OpenAI
// ---------------------------
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ---------------------------
// Telegram Bots
// ---------------------------
const botsInstances = {};
async function initBot(botToken, botId){
  const bot = new Telegraf(botToken);
  const accounts = loadAccounts();
  const superadmin = accounts.find(a=>a.role==="superadmin");
  const admins = accounts.filter(a=>a.role==="admin");
  const customersWithBot = accounts.filter(a=>a.assignedBots?.includes(botId));
  const infoFile = ensureInfoFile(botId);

  bot.start(ctx=>{
    const uid=ctx.from.id;
    if([superadmin,...admins].some(a=>a.telegramId===uid)) return ctx.reply("Admin-Modus aktiviert.");
    if(customersWithBot.some(c=>c.telegramId===uid)) return ctx.reply("Bot-Modus aktiviert.");
    ctx.reply("🚫 Du bist kein berechtigter Benutzer.");
  });

  bot.on("text", async ctx=>{
    const uid=ctx.from.id;
    const isAdmin=[superadmin,...admins].some(a=>a.telegramId===uid);
    const isCustomer=customersWithBot.some(c=>c.telegramId===uid);
    if(!isAdmin && !isCustomer) return ctx.reply("🚫 Keine Rechte.");
    const msg = ctx.message.text.trim();
    try {
      let infoContent = fs.readFileSync(infoFile,"utf8") || "";
      if(infoContent.includes(msg)) return ctx.reply(infoContent); // einfache Prüfung
      const gpt = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
          {role:"system",content:`Du bist der Assistent von Bot ${botId}. Antworte basierend auf der Info-Datei.`},
          {role:"user",content: msg}
        ],
        max_tokens: 200,
        temperature:0
      });
      ctx.reply(gpt.choices[0].message.content.trim());
    } catch(e){console.error(e); ctx.reply("⚠️ Fehler beim Beantworten.");}
  });

  try{await bot.launch({dropPendingUpdates:true})}catch(console.error);
  botsInstances[botId] = bot;
}

// ---------------------------
// Routes
// ---------------------------

// --- Registrierung / Erstes Gerät ---
app.get("/register",(req,res)=>{
  const accounts = loadAccounts();
  const cookies = parseCookies(req);
  const token = cookies.deviceToken;
  if(accounts.length===0){
    const deviceToken = crypto.randomBytes(12).toString("hex");
    setCookie(res,"deviceToken",deviceToken,{httpOnly:true});
    res.send(`<h2>Erstes Gerät → Superadmin</h2>
      <form method="POST">
        Passwort: <input name="password" type="password" required/>
        <button>Erstellen</button>
      </form>`);
  } else if(token && accounts.find(a=>a.deviceToken===token)){
    res.redirect("/dashboard");
  } else {
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
  const accounts = loadAccounts();
  const pending = loadPending();
  const cookies = parseCookies(req);
  if(accounts.length===0){
    const deviceToken = crypto.randomBytes(12).toString("hex");
    const {salt,hash} = hashPassword(req.body.password);
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

// --- Dashboard ---
app.get("/dashboard",requireAuth,(req,res)=>{
  const accounts = loadAccounts();
  const pending = loadPending();
  const bots = loadBots();
  let html = `<h1>Dashboard</h1><p>Hallo ${req.user.firstName} ${req.user.lastName} [${req.user.role}]</p>`;
  
  // Kundenansicht
  if(req.user.role==="customer"){
    html += "<h2>Deine Bots</h2>";
    if(req.user.assignedBots?.length>0){
      req.user.assignedBots.forEach(bid=>{
        const b=bots.find(bb=>bb.id===bid);
        if(b) html+=`<p>${b.name}</p>`;
      });
    } else html+="<p>Kein Bot zugewiesen</p>";
    res.send(html); return;
  }

  // Admin/Superadmin
  html += "<h2>Pending Registrierungen</h2>";
  pending.forEach(p=>{
    html += `<p>${p.firstName} ${p.lastName} (${p.role}) - <a href="/approve/${p.id}?as=customer">Als Kunde</a> | <a href="/approve/${p.id}?as=admin">Als Admin</a> | <a href="/reject/${p.id}">Ablehnen</a></p>`;
  });

  html += "<h2>Kunden</h2>";
  accounts.filter(a=>a.role==="customer").forEach(c=>{
    html+=`<p>${c.firstName} ${c.lastName} - Bots: ${(c.assignedBots||[]).map(id=>bots.find(b=>b.id===id)?.name).join(", ")}</p>`;
  });

  html += "<h2>Bots</h2>";
  bots.forEach(b=>{
    html+=`<p>${b.name} - ID: ${b.id} - Token: ${b.token || ""} - Zugewiesen an: ${(accounts.filter(a=>a.assignedBots?.includes(b.id)).map(a=>a.firstName)).join(", ")}
      <form style="display:inline" method="POST" action="/updatebot">
        <input type="hidden" name="id" value="${b.id}"/>
        Name: <input name="name" value="${b.name}"/>
        Token: <input name="token" value="${b.token}"/>
        <button>Speichern</button>
      </form>
    </p>`;
  });

  html += `<h2>Dokumente</h2>`;
  bots.forEach(b=>{
    const f=ensureInfoFile(b.id);
    html+=`<p>${b.name}: <a href="/document/${b.id}">Ansehen/Bearbeiten</a></p>`;
  });

  html += `<h2>Neuen Bot erstellen</h2>
    <form method="POST" action="/addbot">
      Name: <input name="name" required/>
      Token: <input name="token" required/>
      <button>Erstellen</button>
    </form>`;

  res.send(html);
});

// --- Approve / Reject ---
app.get("/approve/:id",(req,res)=>{
  const accounts = loadAccounts();
  const pending = loadPending();
  const {id} = req.params;
  const as = req.query.as; // customer/admin
  const p = pending.find(r=>r.id===id);
  if(!p){res.send("Nicht gefunden"); return;}
  const deviceToken = crypto.randomBytes(12).toString("hex");
  const {salt,hash} = hashPassword("changeme");
  accounts.push({...p,deviceToken,passwordHash:hash,salt,role:as,assignedBots:[],telegramId:null});
  saveAccounts(accounts);
  savePending(pending.filter(r=>r.id!==id));
  res.redirect("/dashboard");
});

app.get("/reject/:id",(req,res)=>{
  const pending = loadPending();
  savePending(pending.filter(r=>r.id!==req.params.id));
  res.redirect("/dashboard");
});

// --- Add / Update Bots ---
app.post("/addbot",requireAuth,requireAdmin,(req,res)=>{
  const {name,token} = req.body;
  const bots = loadBots();
  const botId = crypto.randomBytes(6).toString("hex");
  bots.push({id:botId,name,token});
  saveBots(bots);
  // Alle Admins automatisch Bot-Admins
  const accounts = loadAccounts();
  accounts.filter(a=>a.role==="admin"||a.role==="superadmin").forEach(a=>{
    if(!a.assignedBots) a.assignedBots=[];
    a.assignedBots.push(botId);
  });
  saveAccounts(accounts);
  initBot(token,botId);
  res.redirect("/dashboard");
});

app.post("/updatebot",requireAuth,requireAdmin,(req,res)=>{
  const {id,name,token} = req.body;
  const bots = loadBots();
  const b = bots.find(bb=>bb.id===id);
  if(!b){res.send("Bot nicht gefunden"); return;}
  b.name=name; b.token=token;
  saveBots(bots);
  initBot(token,id); // Bot neu starten
  res.redirect("/dashboard");
});

// --- Dokumente bearbeiten ---
app.get("/document/:botId",requireAuth,requireAdmin,(req,res)=>{
  const botId=req.params.botId;
  const f=ensureInfoFile(botId);
  const content = fs.readFileSync(f,"utf8");
  res.send(`<h2>Info-Dokument für Bot ${botId}</h2>
    <form method="POST" action="/document/${botId}">
      <textarea name="content" rows="20" cols="80">${content}</textarea><br/>
      <button>Speichern</button>
    </form>`);
});
app.post("/document/:botId",requireAuth,requireAdmin,(req,res)=>{
  const botId=req.params.botId;
  const f=ensureInfoFile(botId);
  fs.writeFileSync(f,req.body.content,"utf8");
  res.redirect("/dashboard");
});

// ---------------------------
// Start server
// ---------------------------
const PORT = process.env.PORT || 10000;
app.listen(PORT,()=>console.log(`Server läuft auf Port ${PORT}`));
