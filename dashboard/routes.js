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
    Passwort <input type="password" name="password" required><br>
    <button>Registrieren</button>
  </form>
  `);
});

router.post("/register",(req,res)=>{
  const accounts = loadAccounts();
  const isFirst = accounts.length === 0;

  if(accounts.find(a => a.email === req.body.email)){
    return res.send("❌ Email existiert bereits.");
  }

  const { salt, hash } = hashPassword(req.body.password);
  const deviceToken = crypto.randomBytes(32).toString("hex");

  accounts.push({
    firstName: req.body.firstName,
    lastName: req.body.lastName,
    email: req.body.email,
    salt,
    hash,
    role: isFirst ? "superadmin" : "customer",
    approved: isFirst,
    deviceTokens: [deviceToken],
    assignedBots: [],
    telegramId: null
  });

  saveAccounts(accounts);
  setCookie(res,"deviceToken",deviceToken,{httpOnly:true,path:"/"});

  res.send(
    isFirst
      ? "✅ Superadmin erstellt. <a href='/dashboard'>Dashboard</a>"
      : "✅ Registriert. Warten auf Freigabe durch Admin."
  );
});

/* =========================
   LOGIN
========================= */
router.get("/login",(req,res)=>{
  res.send(`
  <h1>Login</h1>
  <form method="POST">
    Email <input name="email" required><br>
    Passwort <input type="password" name="password" required><br>
    <button>Login</button>
  </form>
  `);
});

router.post("/login",(req,res)=>{
  const accounts = loadAccounts();
  const acc = accounts.find(a=>a.email===req.body.email);

  if(!acc || !verifyPassword(req.body.password, acc.salt, acc.hash)){
    return res.send("❌ Login fehlgeschlagen.");
  }

  if(!acc.approved){
    return res.send("⛔ Account noch nicht freigegeben.");
  }

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

  let html = `<h1>Dashboard</h1>
  <p>${req.user.firstName} ${req.user.lastName} (${req.user.role})</p>`;

  /* Passwort ändern (ALLE) */
  html += `
  <h2>Passwort ändern</h2>
  <form method="POST" action="/change-password">
    Altes Passwort <input type="password" name="oldPassword" required><br>
    Neues Passwort <input type="password" name="newPassword" required><br>
    <button>Ändern</button>
  </form>
  `;

  /* Admin-Bereich */
  if(req.user.role === "admin" || req.user.role === "superadmin"){
    html += `<h2>Accounts</h2>`;

    accounts.forEach((a,i)=>{
      html += `<p>
        ${a.firstName} ${a.lastName} – ${a.email} – ${a.role} – ${a.approved ? "✅" : "⛔"}`;

      if(!a.approved){
        html += `
          <a href="/approve/${i}/admin">Admin</a> |
          <a href="/approve/${i}/customer">Kunde</a>
        `;
      }

      if(req.user.role === "superadmin"){
        html += `
        <form method="POST" action="/reset-password" style="display:inline">
          <input type="hidden" name="email" value="${a.email}">
          <button>Reset PW</button>
        </form>`;
      }

      html += `</p>`;
    });
  }

  res.send(html);
});

/* =========================
   APPROVE ACCOUNT
========================= */
router.get("/approve/:idx/:role", requireAuth, requireAdmin, (req,res)=>{
  const accounts = loadAccounts();
  const acc = accounts[req.params.idx];

  if(!acc) return res.send("❌ Account nicht gefunden.");

  acc.role = req.params.role;
  acc.approved = true;

  saveAccounts(accounts);
  res.redirect("/dashboard");
});

/* =========================
   CHANGE OWN PASSWORD
========================= */
router.post("/change-password", requireAuth, (req,res)=>{
  const accounts = loadAccounts();
  const acc = accounts.find(a=>a.email===req.user.email);

  if(!verifyPassword(req.body.oldPassword, acc.salt, acc.hash)){
    return res.send("❌ Altes Passwort falsch.");
  }

  const { salt, hash } = hashPassword(req.body.newPassword);
  acc.salt = salt;
  acc.hash = hash;

  saveAccounts(accounts);
  res.send("✅ Passwort geändert. <a href='/dashboard'>Zurück</a>");
});

/* =========================
   RESET PASSWORD (SUPERADMIN ONLY)
========================= */
router.post("/reset-password", requireAuth, (req,res)=>{
  if(req.user.role !== "superadmin"){
    return res.send("🚫 Nur Superadmin.");
  }

  const accounts = loadAccounts();
  const acc = accounts.find(a=>a.email===req.body.email);

  if(!acc) return res.send("❌ Account nicht gefunden.");

  const tempPassword = crypto.randomBytes(4).toString("hex");
  const { salt, hash } = hashPassword(tempPassword);

  acc.salt = salt;
  acc.hash = hash;
  saveAccounts(accounts);

  res.send(`✅ Neues Passwort für ${acc.email}: <b>${tempPassword}</b>
  <br><a href="/dashboard">Zurück</a>`);
});

export default router;


