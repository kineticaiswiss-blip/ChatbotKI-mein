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
    if([superadmin,..]()
