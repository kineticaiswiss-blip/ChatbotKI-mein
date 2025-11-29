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
   HILFS-SCRIPT (PASSWORT AUGE)
========================= */
const pwScript = `
<script>
function togglePw(id){
  const el = document.getElementById(id);
  el.type = el.type === "password" ? "text" : "password";
}
</script>
`;

/* =========================
   REGISTER
========================= */
router.get("/register",(req,res)=>{
  res.send(`
<h1>Registrierung</h1>

<form method="POST">
Vorname <input name="firstName" required><br>
Nachname <input name="lastName" required><br>

Email <input name="email"><br>
Telefon <input name="phone"><br><br>

Passwort
<input type="password" id="pw1" name="password" required>
<button type="button" onclick="togglePw('pw1')">👁</button><br>

Passwort bestätigen
<input type="password" id="pw2" name="password2" required>
<button type="button" onclick="togglePw('pw2')">👁</button><br><br>

<button>Registrieren</button>
</form>

<p>⚠️ Email ODER Telefonnummer ist erforderlich</p>
${pwScript}
`);
});

router.post("/register",(req,res)=>{
  const { firstName, lastName, email, phone, password, password2 } = req.body;

  if (!email && !phone)
    return res.send("❌ Email oder Telefonnummer erforderlich.");

  if (password !== password2)
    return res.send("❌ Passwörter stimmen nicht überein.");

  const accounts = loadAccounts();

  if (email && accounts.some(a => a.email === email))
    return res.send("❌ Email existiert bereits.");

  if (phone && accounts.some(a => a.phone === phone))
    return res.send("❌ Telefonnummer existiert bereits.");

  const superAdminExists = accounts.some(a => a.role === "superadmin");
  const { salt, hash } = hashPassword(password);
  const token = crypto.randomBytes(32).toString("hex");

  accounts.push({
    firstName,
    lastName,
    email: email || null,
    phone: phone || null,
    salt,
    hash,
    role: superAdminExists ? "customer" : "superadmin",
    approved: !superAdminExists,
    deviceTokens: [token],
    assignedBots: []
  });

  saveAccounts(accounts);
  setCookie(res,"deviceToken",token,{ httpOnly:true });

  res.send(
    superAdminExists
      ? "✅ Registriert – wartet auf Freigabe."
      : "✅ Superadmin erstellt. <a href='/dashboard'>Dashboard</a>"
  );
});

/* =========================
   LOGIN
========================= */
router.get("/login",(req,res)=>{
  res.send(`
<h1>Login</h1>

<form method="POST">
Email oder Telefon <input name="identifier" required><br>

Passwort
<input type="password" id="pwLogin" name="password" required>
<button type="button" onclick="togglePw('pwLogin')">👁</button><br><br>

<button>Login</button>
</form>
${pwScript}
`);
});

router.post("/login",(req,res)=>{
  const { identifier, password } = req.body;
  const accounts = loadAccounts();

  const acc = accounts.find(
    a => a.email === identifier || a.phone === identifier
  );

  if (!acc || !verifyPassword(password, acc.salt, acc.hash))
    return res.send("❌ Login fehlgeschlagen.");

  if (!acc.approved)
    return res.send("⛔ Account noch nicht freigegeben.");

  const token = crypto.randomBytes(32).toString("hex");
  acc.deviceTokens.push(token);
  saveAccounts(accounts);

  setCookie(res,"deviceToken",token,{ httpOnly:true });
  res.redirect("/dashboard");
});

/* =========================
   DASHBOARD
========================= */
router.get("/dashboard", requireAuth, (req,res)=>{
  const accounts = loadAccounts();

  let html = `
<h1>Dashboard</h1>
<p>
${req.user.firstName} (${req.user.role}) |
<a href="/logout" style="color:red;font-weight:bold">Logout</a>
</p>

<h2>Passwort ändern</h2>
<form method="POST" action="/change-password">
Alt
<input type="password" id="oldPw" name="oldPassword" required>
<button type="button" onclick="togglePw('oldPw')">👁</button><br>

Neu
<input type="password" id="newPw1" name="newPassword" required>
<button type="button" onclick="togglePw('newPw1')">👁</button><br>

Neu bestätigen
<input type="password" id="newPw2" name="newPassword2" required>
<button type="button" onclick="togglePw('newPw2')">👁</button><br><br>

<button>Speichern</button>
</form>
${pwScript}
`;

  if (req.user.role !== "customer") {
    html += `<h2>Accounts</h2>`;
    accounts.forEach((a,i)=>{
      html += `
<p>
${a.firstName} ${a.lastName} – ${a.role} – ${a.approved ? "✅" : "⛔"}
${!a.approved ? `
<a href="/approve/${i}/admin">Admin</a> |
<a href="/approve/${i}/customer">Kunde</a>
` : ""}
</p>`;
    });
  }

  res.send(html);
});

/* =========================
   CHANGE PASSWORD ✅ FIXED
========================= */
router.post("/change-password", requireAuth, (req,res)=>{
  const { oldPassword, newPassword, newPassword2 } = req.body;

  if (newPassword !== newPassword2)
    return res.send("❌ Passwörter stimmen nicht überein.");

  const accounts = loadAccounts();
  const acc = accounts.find(a => a.email === req.user.email);

  if (!acc) return res.send("❌ Account nicht gefunden");

  if (!verifyPassword(oldPassword, acc.salt, acc.hash))
    return res.send("❌ Altes Passwort falsch");

  const { salt, hash } = hashPassword(newPassword);
  acc.salt = salt;
  acc.hash = hash;

  saveAccounts(accounts);
  res.send("✅ Passwort geändert. <a href='/dashboard'>Zurück</a>");
});

/* =========================
   LOGOUT
========================= */
router.get("/logout",(req,res)=>{
  res.setHeader(
    "Set-Cookie",
    "deviceToken=; Path=/; HttpOnly; Max-Age=0; SameSite=Lax"
  );
  res.redirect("/login");
});

export default router;
