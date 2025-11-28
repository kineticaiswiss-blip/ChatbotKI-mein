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

const router = express.Router();

/* =========================
   REGISTER
========================= */
router.get("/register",(req,res)=>{
  res.send(`
  <h1>Registrierung</h1>
  <form method="POST">
    Vorname <input name="firstName" required><br>
    Nachname <input name="lastName" required><br>
    Email <input name="email" required><br>
    Passwort 
    <input type="password" id="pwReg" name="password" required>
    <button type="button" onclick="togglePw('pwReg')">👁</button>
    <br>
    <button>Registrieren</button>
  </form>

  <script>
    function togglePw(id){
      const el=document.getElementById(id);
      el.type = el.type==="password" ? "text" : "password";
    }
  </script>
  `);
});

router.post("/register",(req,res)=>{
  const accounts = loadAccounts();
  if(accounts.find(a=>a.email===req.body.email))
    return res.send("❌ Email existiert bereits.");

  const isFirst = accounts.length === 0;
  const { salt, hash } = hashPassword(req.body.password);
  const token = crypto.randomBytes(32).toString("hex");

  accounts.push({
    firstName:req.body.firstName,
    lastName:req.body.lastName,
    email:req.body.email,
    salt,hash,
    role: isFirst ? "superadmin" : "customer",
    approved: isFirst,
    deviceTokens:[token],
    assignedBots:[],
    telegramId:null
  });

  saveAccounts(accounts);
  setCookie(res,"deviceToken",token,{httpOnly:true,path:"/"});

  res.send(isFirst
    ? "✅ Superadmin erstellt. <a href='/dashboard'>Dashboard</a>"
    : "✅ Registriert – wartet auf Freigabe.");
});

/* =========================
   LOGIN
========================= */
router.get("/login",(req,res)=>{
  res.send(`
  <h1>Login</h1>
  <form method="POST">
    Email <input name="email" required><br>
    Passwort 
    <input type="password" id="pwLogin" name="password" required>
    <button type="button" onclick="togglePw('pwLogin')">👁</button>
    <br>
    <button>Login</button>
  </form>

  <script>
    function togglePw(id){
      const el=document.getElementById(id);
      el.type = el.type==="password" ? "text" : "password";
    }
  </script>
  `);
});

router.post("/login",(req,res)=>{
  const accounts = loadAccounts();
  const acc = accounts.find(a=>a.email===req.body.email);
  if(!acc || !verifyPassword(req.body.password,acc.salt,acc.hash))
    return res.send("❌ Login fehlgeschlagen.");

  if(!acc.approved)
    return res.send("⛔ Account noch nicht freigegeben.");

  const token = crypto.randomBytes(32).toString("hex");
  acc.deviceTokens.push(token);
  saveAccounts(accounts);

  setCookie(res,"deviceToken",token,{httpOnly:true,path:"/"});
  res.redirect("/dashboard");
});

/* =========================
   DASHBOARD
========================= */
router.get("/dashboard", requireAuth, (req,res)=>{
  const accounts = loadAccounts();

  let html = `
  <html><body>
  <h1>Dashboard</h1>
  <p>${req.user.firstName} (${req.user.role})</p>

  <script>
    setInterval(() => window.location.reload(), 5*60*1000);
  </script>

  <h2>Passwort ändern</h2>
  <form method="POST" action="/change-password">
    Alt <input type="password" id="oldPw" name="oldPassword" required>
    <button type="button" onclick="togglePw('oldPw')">👁</button><br>
    Neu <input type="password" id="newPw" name="newPassword" required>
    <button type="button" onclick="togglePw('newPw')">👁</button><br>
    <button>Ändern</button>
  </form>
  `;

  if(req.user.role!=="customer"){
    html+=`<h2>Accounts</h2>`;
    accounts.forEach((a,i)=>{
      html+=`
      <p>${a.firstName} ${a.lastName} – ${a.email} – ${a.role} – ${a.approved?"✅":"⛔"}
      ${!a.approved ? `
        <a href="/approve/${i}/admin">Admin</a> |
        <a href="/approve/${i}/customer">Kunde</a>
      ` : ""}
      `;

      if(req.user.role==="superadmin"){
        html+=`
        <form method="POST" action="/delete-account" style="display:inline">
          <input type="hidden" name="email" value="${a.email}">
          <button>🗑 Löschen</button>
        </form>`;
      }

      html+=`</p>`;
    });
  }

  html+=`</body></html>`;
  res.send(html);
});

/* =========================
   APPROVE / DELETE
========================= */
router.get("/approve/:idx/:role", requireAuth, requireAdmin, (req,res)=>{
  const accounts = loadAccounts();
  const acc = accounts[req.params.idx];
  if(!acc) return res.send("Nicht gefunden.");

  acc.role = req.params.role;
  acc.approved = true;
  saveAccounts(accounts);
  res.redirect("/dashboard");
});

router.post("/delete-account", requireAuth, (req,res)=>{
  if(req.user.role!=="superadmin")
    return res.send("🚫 Nur Superadmin.");

  let accounts = loadAccounts();
  accounts = accounts.filter(a=>a.email!==req.body.email);
  saveAccounts(accounts);
  res.redirect("/dashboard");
});

router.post("/change-password", requireAuth, (req, res) => {
  const { oldPassword, newPassword } = req.body;

  if (!oldPassword || !newPassword) {
    return res.send("❌ Bitte beide Felder ausfüllen.");
  }

  const accounts = loadAccounts();

  // ✅ WICHTIG: User per EMAIL aus Cookie-User finden
  const accIndex = accounts.findIndex(
    a => a.email === req.user.email
  );

  if (accIndex === -1) {
    return res.send("❌ Account nicht gefunden.");
  }

  const acc = accounts[accIndex];

  // ✅ Altes Passwort prüfen
  if (!verifyPassword(oldPassword, acc.salt, acc.hash)) {
    return res.send("❌ Altes Passwort ist falsch.");
  }

  // ✅ Neues Passwort hashen
  const { salt, hash } = hashPassword(newPassword);

  acc.salt = salt;
  acc.hash = hash;

  // ✅ GANZ WICHTIG
  saveAccounts(accounts);

  res.send(`
    ✅ Passwort wurde geändert.<br><br>
    <a href="/dashboard">Zurück zum Dashboard</a>
  `);
});

