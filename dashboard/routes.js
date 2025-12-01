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
   HILFS-SCRIPT (PW AUGE)
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
Nachname <input name="lastName" required><br><br>

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

<p>⚠️ Email ODER Telefonnummer erforderlich</p>
${pwScript}
`);
});
function dashboardLayout(req, content) {
  return `
<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>Dashboard</title>
<style>
body { font-family: sans-serif; background:${req.user.darkMode ? "#111" : "#fff"}; color:${req.user.darkMode ? "#eee" : "#000"}; }
a { margin-right: 10px; }
</style>
</head>
<body>

<nav>
  <a href="/dashboard/account">Account</a>
  <a href="/dashboard/security">Sicherheit</a>
  <a href="/dashboard/bots">Bots</a>
  <a href="/logout" style="color:red">Logout</a>
</nav>
<hr>

${content}

</body>
</html>
`;
}
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

  const isFirst = !accounts.some(a => a.role === "superadmin");
  const { salt, hash } = hashPassword(password);

  accounts.push({
    firstName,
    lastName,
    email: email || null,
    phone: phone || null,
    salt,
    hash,
    role: isFirst ? "superadmin" : "customer",
    approved: isFirst,
    deviceTokens: [],
    assignedBots: [],
    forcePasswordReset: false,
    resetToken: null
  });

  saveAccounts(accounts);

  res.send(
    isFirst
      ? "✅ Superadmin erstellt. <a href='/login'>Login</a>"
      : "✅ Registriert – wartet auf Freigabe."
  );
});

/* =========================
   LOGIN
========================= */
router.get("/login",(req,res)=>{
  res.send(`
<h1>Login</h1>
<form method="POST">
Email oder Telefon <input name="identifier" required><br><br>

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

  if (acc.forcePasswordReset)
    return res.send("🔑 Passwort wurde zurückgesetzt – bitte neu setzen.");

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
<a href="/logout" style="color:red">Logout</a>
</p>

<h2>Passwort ändern</h2>
<form method="POST" action="/change-password">
Alt <input type="password" id="opw" name="oldPassword" required>
<button type="button" onclick="togglePw('opw')">👁</button><br>

Neu <input type="password" id="npw1" name="newPassword" required>
<button type="button" onclick="togglePw('npw1')">👁</button><br>

Neu bestätigen <input type="password" id="npw2" name="newPassword2" required>
<button type="button" onclick="togglePw('npw2')">👁</button><br><br>

<button>Speichern</button>
</form>
${pwScript}
`;

  if (req.user.role !== "customer") {
    html += `<h2>Accounts</h2>`;
    accounts.forEach((a,i)=>{
      const canDelete =
        (req.user.role === "superadmin" || req.user.role === "admin") &&
        a.email !== req.user.email;

      const canReset =
        req.user.role === "superadmin" &&
        a.email !== req.user.email;

      html += `
<p>
${a.firstName} ${a.lastName} (${a.role}) ${a.approved ? "✅" : "⛔"}

${!a.approved ? `
<a href="/approve/${i}/admin">Admin</a> |
<a href="/approve/${i}/customer">Kunde</a>
` : ""}

${canReset ? `
<form method="POST" action="/force-reset" style="display:inline">
<input type="hidden" name="idx" value="${i}">
<button>🔑 Reset PW</button>
</form>
` : ""}

${canDelete ? `
<form method="POST" action="/delete-account" style="display:inline">
<input type="hidden" name="idx" value="${i}">
<button style="color:red">🗑 Löschen</button>
</form>
` : ""}
</p>
`;
    });
  }

  res.send(html);
});

/* =========================
   APPROVE
========================= */
router.get("/approve/:idx/:role", requireAuth, requireAdmin, (req,res)=>{
  const accounts = loadAccounts();
  const idx = Number(req.params.idx);
  const role = req.params.role;

  if (!accounts[idx]) return res.send("❌ Account nicht gefunden");
  if (!["admin","customer"].includes(role))
    return res.send("❌ Ungültige Rolle");

  accounts[idx].role = role;
  accounts[idx].approved = true;
  saveAccounts(accounts);

  res.redirect("/dashboard");
});

/* =========================
   DELETE ACCOUNT
========================= */
router.post("/delete-account", requireAuth, requireAdmin, (req,res)=>{
  const accounts = loadAccounts();
  const idx = Number(req.body.idx);

  if (!accounts[idx]) return res.send("❌ Account nicht gefunden");
  if (accounts[idx].email === req.user.email)
    return res.send("❌ Du kannst dich nicht selbst löschen");

  accounts.splice(idx,1);
  saveAccounts(accounts);

  res.redirect("/dashboard");
});

/* =========================
   FORCE PASSWORD RESET
========================= */
router.post("/force-reset", requireAuth, requireAdmin, (req,res)=>{
  if (req.user.role !== "superadmin")
    return res.send("🚫 Nur Superadmin");

  const accounts = loadAccounts();
  const idx = Number(req.body.idx);
  if (!accounts[idx]) return res.send("❌ Account nicht gefunden");

  const token = crypto.randomBytes(32).toString("hex");

  accounts[idx].forcePasswordReset = true;
  accounts[idx].resetToken = token;
  accounts[idx].approved = false;
  accounts[idx].deviceTokens = [];

  saveAccounts(accounts);

  res.send(`
✅ Passwort zurückgesetzt.<br>
<a href="/reset/${token}">Reset-Link</a>
`);
});

/* =========================
   RESET FLOW
========================= */
router.get("/reset/:token",(req,res)=>{
  res.send(`
<h1>Neues Passwort</h1>
<form method="POST">
<input type="password" name="pw1" required><br>
<input type="password" name="pw2" required><br>
<button>Speichern</button>
</form>
`);
});

router.post("/reset/:token",(req,res)=>{
  const { pw1, pw2 } = req.body;
  if (pw1 !== pw2) return res.send("❌ Passwörter stimmen nicht überein");

  const accounts = loadAccounts();
  const acc = accounts.find(a => a.resetToken === req.params.token);
  if (!acc) return res.send("❌ Ungültiger Token");

  const { salt, hash } = hashPassword(pw1);
  acc.salt = salt;
  acc.hash = hash;
  acc.forcePasswordReset = false;
  acc.resetToken = null;
  acc.approved = true;

  saveAccounts(accounts);
  res.send("✅ Passwort gesetzt. <a href='/login'>Login</a>");
});

/* =========================
   CHANGE PASSWORD
========================= */
router.post("/change-password", requireAuth, (req,res)=>{
  const { oldPassword, newPassword, newPassword2 } = req.body;

  if (newPassword !== newPassword2)
    return res.send("❌ Passwörter stimmen nicht überein");

  const token = parseCookies(req).deviceToken;
  const accounts = loadAccounts();
  const acc = accounts.find(a => a.deviceTokens.includes(token));

  if (!acc) return res.send("❌ Account nicht gefunden");
  if (!verifyPassword(oldPassword, acc.salt, acc.hash))
    return res.send("❌ Falsches Passwort");

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
