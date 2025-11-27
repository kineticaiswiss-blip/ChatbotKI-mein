import express from "express";
import crypto from "crypto";
import {
  loadAccounts, saveAccounts,
  requireAuth, requireAdmin,
  setCookie, parseCookies,
  hashPassword, verifyPassword
} from "./auth.js";

const router = express.Router();

// ---------- REGISTER ----------
router.get("/register",(req,res)=>{
  res.send(`
  <h1>Registrierung</h1>
  <form method="POST">
    Vorname <input name="firstName" required/><br/>
    Nachname <input name="lastName" required/><br/>
    Email <input name="email" required/><br/>
    Passwort <input type="password" name="password" required/><br/>
    <button>Registrieren</button>
  </form>
  `);
});

router.post("/register",(req,res)=>{
  const accounts = loadAccounts();
  const isFirst = accounts.length === 0;

  const {salt, hash} = hashPassword(req.body.password);
  const deviceToken = crypto.randomBytes(32).toString("hex");

  accounts.push({
    firstName:req.body.firstName,
    lastName:req.body.lastName,
    email:req.body.email,
    salt, hash,
    role: isFirst ? "superadmin" : "customer",
    approved: isFirst,
    deviceTokens:[deviceToken],
    assignedBots:[],
    telegramId:null
  });

  saveAccounts(accounts);
  setCookie(res,"deviceToken",deviceToken,{httpOnly:true,path:"/"});

  res.send(isFirst
    ? "✅ Superadmin erstellt. <a href='/dashboard'>Dashboard</a>"
    : "✅ Registriert – wartet auf Freigabe.");
});

// ---------- LOGIN ----------
router.get("/login",(req,res)=>{
  res.send(`
  <h1>Login</h1>
  <form method="POST">
    Email <input name="email"/><br/>
    Passwort <input type="password" name="password"/><br/>
    <button>Login</button>
  </form>
  `);
});

router.post("/login",(req,res)=>{
  const acc = loadAccounts().find(a=>a.email===req.body.email);
  if(!acc || !verifyPassword(req.body.password,acc.salt,acc.hash))
    return res.send("❌ Login fehlgeschlagen.");

  const token = crypto.randomBytes(32).toString("hex");
  acc.deviceTokens.push(token);
  saveAccounts(loadAccounts());
  setCookie(res,"deviceToken",token,{httpOnly:true,path:"/"});
  res.redirect("/dashboard");
});

// ---------- DASHBOARD ----------
router.get("/dashboard", requireAuth, (req,res)=>{
  const accounts = loadAccounts();
  let html = `<h1>Dashboard</h1><p>${req.user.firstName} (${req.user.role})</p>`;

  if(req.user.role!=="customer"){
    html+=`<h2>Accounts</h2>`;
    accounts.forEach((a,i)=>{
      html+=`
      <p>${a.firstName} ${a.lastName} – ${a.role} – ${a.approved?"✅":"⛔"}
      ${!a.approved?`
        <a href="/approve/${i}/admin">Als Admin</a> |
        <a href="/approve/${i}/customer">Als Kunde</a>
      `:""}
      </p>`;
    });
  }
  res.send(html);
});

// ---------- APPROVE ----------
router.get("/approve/:idx/:role", requireAuth, requireAdmin, (req,res)=>{
  const accounts = loadAccounts();
  const acc = accounts[req.params.idx];
  if(!acc) return res.send("Nicht gefunden");
  acc.role = req.params.role;
  acc.approved = true;
  saveAccounts(accounts);
  res.redirect("/dashboard");
});

export default router;

// ---------- CHANGE OWN PASSWORD ----------
router.post("/change-password", requireAuth, (req, res) => {
  const { oldPassword, newPassword } = req.body;
  const accounts = loadAccounts();
  const acc = accounts.find(a => a.email === req.user.email);

  if (!verifyPassword(oldPassword, acc.salt, acc.hash)) {
    return res.send("❌ Altes Passwort falsch.");
  }

  const { salt, hash } = hashPassword(newPassword);
  acc.salt = salt;
  acc.hash = hash;
  saveAccounts(accounts);

  res.send("✅ Passwort geändert. <a href='/dashboard'>Zurück</a>");
});

