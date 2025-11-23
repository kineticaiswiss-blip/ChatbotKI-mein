// app.js — Sicherer Multi-Kunden Telegram-Bot mit Dark Mode Dashboard
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
// Verzeichnisse / Dateien
// ---------------------------
const DATA_DIR = "./data";
const ACCOUNTS_FILE = path.join(DATA_DIR, "accounts.json");
const BOTS_FILE = path.join(DATA_DIR, "bots.json");
const INFO_DIR = path.join(DATA_DIR, "bots_info");

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(INFO_DIR)) fs.mkdirSync(INFO_DIR, { recursive: true });
[ACCOUNTS_FILE, BOTS_FILE].forEach(f => { if(!fs.existsSync(f)) fs.writeFileSync(f,"[]") });

// ---------------------------
// Helpers
// ---------------------------
function readJSON(file, fallback=[]) { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; } }
function writeJSON(file, obj) { fs.writeFileSync(file, JSON.stringify(obj, null, 2), "utf8"); }

function hashPassword(pw, salt=null){
    salt = salt || crypto.randomBytes(16).toString("hex");
    return { salt, hash: crypto.scryptSync(pw, salt, 64).toString("hex") };
}
function verifyPassword(pw, salt, hash){
    try { return crypto.timingSafeEqual(Buffer.from(crypto.scryptSync(pw,salt,64).toString("hex"),"hex"), Buffer.from(hash,"hex")); }
    catch { return false; }
}

function parseCookies(req){
    const h=req.headers?.cookie||"";
    const o={};
    h.split(';').map(s=>s.trim()).filter(Boolean).forEach(p=>{
        const i=p.indexOf('=');
        if(i>-1) o[p.slice(0,i)] = decodeURIComponent(p.slice(i+1));
    });
    return o;
}

function setCookie(res,name,value,opts={}) {
    let c = `${name}=${encodeURIComponent(value)}`;
    if(opts.maxAge) c+= `; Max-Age=${opts.maxAge}`;
    if(opts.httpOnly) c+= `; HttpOnly`;
    if(opts.path) c+= `; Path=${opts.path}`;
    c+= `; SameSite=${opts.sameSite||'Lax'}`;
    res.setHeader("Set-Cookie", c);
}

function getClientIp(req){
    const xf=req.headers["x-forwarded-for"]||req.headers["x-forwarded-for".toLowerCase()];
    if(xf) return String(xf).split(",")[0].trim();
    return (req.socket && req.socket.remoteAddress)||req.ip||"";
}

function ensureInfoFile(botId){
    const f = path.join(INFO_DIR, botId + ".txt");
    if(!fs.existsSync(f)) fs.writeFileSync(f, "");
    return f;
}

// ---------------------------
// Load / Save Data
// ---------------------------
function loadAccounts(){ return readJSON(ACCOUNTS_FILE,[]); }
function saveAccounts(a){ writeJSON(ACCOUNTS_FILE,a); }
function loadBots(){ return readJSON(BOTS_FILE,[]); }
function saveBots(b){ writeJSON(BOTS_FILE,b); }

// ---------------------------
// Middleware
// ---------------------------
function requireAuth(req,res,next){
    const cookies=parseCookies(req);
    const token=cookies.deviceToken;
    if(!token) return res.redirect("/login");
    const accounts = loadAccounts();
    const acc = accounts.find(a => (a.deviceTokens||[]).includes(token));
    if(!acc) return res.redirect("/login");
    req.user=acc;
    next();
}
function requireAdmin(req,res,next){
    if(!req.user) return res.redirect("/login");
    if(req.user.role==="admin" || req.user.role==="superadmin") return next();
    res.send("🚫 Zugriff verweigert. Nur Admins.");
}

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
        try{
            const infoContent = fs.readFileSync(infoFile,"utf8") || "";
            const gpt = await openai.chat.completions.create({
                model: "gpt-4o-mini",
                messages: [
                    {role:"system", content:`Du bist der Assistent von Bot ${botId}. Antworte nur basierend auf info.txt.`},
                    {role:"user", content: msg}
                ],
                max_tokens:200,
                temperature:0
            });
            ctx.reply(gpt.choices[0].message.content.trim());
        }catch(e){console.error(e); ctx.reply("⚠️ Fehler beim Beantworten.");}
    });

    try { await bot.launch({ dropPendingUpdates: true }); } 
    catch (err) { console.error(err); }
    botsInstances[botId] = bot;
}

// ---------------------------
// Routes: Registrierung/Login/Dashboard
// ---------------------------
app.get("/register",(req,res)=>{
    res.send(`<h1>Registrierung</h1>
    <form method='POST'>
        Vorname: <input name='firstName' required/><br/>
        Nachname: <input name='lastName' required/><br/>
        Firma: <input name='company' required/><br/>
        E-Mail: <input name='email' required/><br/>
        Telefon: <input name='phone' required/><br/>
        Passwort: <input name='password' type='password' id='pw'/>
        <input type='checkbox' onclick='document.getElementById("pw").type=this.checked?"text":"password"'> Auge<br/>
        <button>Registrieren</button>
    </form>`);
});

app.post("/register",(req,res)=>{
    const accounts = loadAccounts();
    const {salt,hash} = hashPassword(req.body.password);

    let role = "pending";
    if(accounts.length===0) role="superadmin";

    const newAcc = {
        ...req.body,
        role,
        deviceTokens: [],
        salt, hash,
        assignedBots: [],
        telegramId:null
    };
    accounts.push(newAcc);
    saveAccounts(accounts);
    if(role==="superadmin"){
        res.send("✅ Du bist der erste Benutzer und wurdest Superadmin. <a href='/login'>Login</a>");
    } else {
        res.send("✅ Registrierung erfolgreich. Ein Admin muss deinen Account freischalten. <a href='/login'>Login</a>");
    }
});

app.get("/login",(req,res)=>{
    res.send(`<h1>Login</h1>
    <form method='POST'>
        E-Mail: <input name='email' required/><br/>
        Passwort: <input type='password' name='password' id='pw'/>
        <input type='checkbox' onclick='document.getElementById("pw").type=this.checked?"text":"password"'> Auge<br/>
        <button>Login</button>
    </form>`);
});

app.post("/login",(req,res)=>{
    const accounts = loadAccounts();
    const acc = accounts.find(a=>a.email===req.body.email);
    if(!acc || !verifyPassword(req.body.password, acc.salt, acc.hash)) 
        return res.send("Ungültige Daten.");
    if(acc.role==="pending") return res.send("🚫 Account noch nicht freigegeben.");

    const deviceToken = crypto.randomBytes(32).toString("hex");
    acc.deviceTokens.push(deviceToken);
    saveAccounts(accounts);
    setCookie(res,"deviceToken",deviceToken,{httpOnly:true,maxAge:60*60*24*30,path:'/'});
    res.redirect("/dashboard");
});

// ---------------------------
// Dashboard mit Dark Mode
// ---------------------------
app.get("/dashboard",requireAuth,(req,res)=>{
    const accounts = loadAccounts();
    const bots = loadBots();
    let html = `
    <html>
    <head>
        <title>Dashboard</title>
        <style>
            body { background-color: #121212; color: #f0f0f0; font-family: Arial, sans-serif; padding:20px; }
            h1,h2 { color:#fff; }
            input, select, button, textarea { background:#1f1f1f; color:#fff; border:1px solid #333; padding:5px; margin:3px; }
            button { cursor:pointer; background:#6200ee; color:#fff; border:none; border-radius:4px; }
            button:hover { background:#3700b3; }
            a { color:#bb86fc; text-decoration:none; }
            a:hover { text-decoration:underline; }
            form { display:inline; }
        </style>
    </head>
    <body>
    <h1>Dashboard</h1>
    <p>${req.user.firstName} ${req.user.lastName} [${req.user.role}]</p>`;

    if(req.user.role==="admin" || req.user.role==="superadmin"){
        html += `<h2>Bots</h2>`;
        bots.forEach(b=>{
            html += `<p>${b.name} - 
                <form method='POST' style='display:inline' action='/updatebot'>
                    <input type='hidden' name='id' value='${b.id}' />
                    Name: <input name='name' value='${b.name}' />
                    Token: <input name='token' value='${b.token}'/>
                    <button>Speichern</button>
                </form> 
                <button onclick='navigator.clipboard.writeText("${b.id}")'>Bot-Link kopieren</button>
                <a href='/document/${b.id}'>Dokument</a>
            </p>`;
        });
        html += `<h2>Neuen Bot erstellen</h2>
            <form method='POST' action='/addbot'>
                Name: <input name='name' required />
                Token: <input name='token' required />
                <button>Erstellen</button>
            </form>`;

        // Pending Accounts
        const pendingAccounts = accounts.filter(a=>a.role==="pending");
        if(pendingAccounts.length){
            html += `<h2>Ausstehende Registrierungen</h2>`;
            pendingAccounts.forEach(a=>{
                html += `<p>${a.firstName} ${a.lastName} - ${a.email}
                    <form method='POST' style='display:inline' action='/approve'>
                        <select name='role'>
                            <option value='customer'>Kunde</option>
                            <option value='admin'>Admin</option>
                        </select>
                        <input type='hidden' name='email' value='${a.email}' />
                        <button>Genehmigen</button>
                    </form>
                </p>`;
            });
        }
    }

    if(req.user.role==="customer"){
        const assignedBots = req.user.assignedBots || [];
        if(assignedBots.length){
            html += `<h2>Deine Bots</h2>`;
            assignedBots.forEach(botId=>{
                const b = bots.find(bb=>bb.id===botId);
                if(b) html += `<p>${b.name} - <a href='/document/${b.id}'>Dokument</a></p>`;
            });
        } else html += `<p>Dir sind noch keine Bots zugewiesen.</p>`;
    }

    html += `</body></html>`;
    res.send(html);
});

// ---------------------------
// Add / Update Bots
// ---------------------------
app.post("/addbot",requireAuth,requireAdmin,(req,res)=>{
    const bots = loadBots();
    const botId = crypto.randomBytes(6).toString("hex");
    bots.push({id:botId,name:req.body.name,token:req.body.token});
    saveBots(bots);

    const accounts = loadAccounts();
    accounts.filter(a=>a.role==='admin'||a.role==='superadmin').forEach(a=>{
        a.assignedBots=a.assignedBots||[];
        a.assignedBots.push(botId);
    });
    saveAccounts(accounts);

    initBot(req.body.token,botId);
    res.redirect("/dashboard");
});

app.post("/updatebot",requireAuth,requireAdmin,(req,res)=>{
    const bots = loadBots();
    const b = bots.find(bb=>bb.id===req.body.id);
    if(!b){ res.send('Bot nicht gefunden'); return; }
    b.name=req.body.name; b.token=req.body.token; saveBots(bots);
    initBot(req.body.token,req.body.id);
    res.redirect("/dashboard");
});

// ---------------------------
// Dokument bearbeiten
// ---------------------------
app.get('/document/:botId',requireAuth,(req,res)=>{
    const f = ensureInfoFile(req.params.botId);
    const content = fs.readFileSync(f,'utf8');
    res.send(`<form method='POST'><textarea name='content' rows='20' cols='80'>${content}</textarea><br/><button>Speichern</button></form>`);
});

app.post('/document/:botId',requireAuth,requireAdmin,(req,res)=>{
    const f = ensureInfoFile(req.params.botId);
    fs.writeFileSync(f,req.body.content,'utf8');
    res.redirect('/dashboard');
});

// ---------------------------
// Pending Account Genehmigung
// ---------------------------
app.post("/approve", requireAuth, requireAdmin, (req,res)=>{
    const {email, role} = req.body;
    const accounts = loadAccounts();
    const acc = accounts.find(a=>a.email===email && a.role==="pending");
    if(acc){
        acc.role = role;
        const deviceToken = crypto.randomBytes(32).toString("hex");
        acc.deviceTokens = [deviceToken];
        saveAccounts(accounts);
    }
    res.redirect("/dashboard");
});

// ---------------------------
// Server starten
// ---------------------------
const PORT = process.env.PORT || 10000;
app.listen(PORT,()=>console.log(`Server läuft auf Port ${PORT}`));
