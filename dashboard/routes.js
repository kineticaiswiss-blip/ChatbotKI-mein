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
router.get("/register", (req, res) => {
  res.send(`
  <h1>Registrierung</h1>
  <form method="POST">
    Vorname <input name="firstName" required><br>
    Nachname <input name="lastName" required><br><br>

    Email <input name="email"><br>
    ODER Telefon <input name="phone"><br><br>

    Passwort <input type="password" name="password" required><br>
    Passwort bestätigen <input type="password" name="password2" required><br><br>

    <button>Registrieren</button>
  </form>
  <p>⚠️ Email ODER Telefonnummer ist erforderlich</p>
  `);
});

router.post("/register", (req, res) => {
  const { firstName, lastName, email, phone, password, password2 } = req.body;

  if (!email && !phone) {
    return res.send("❌ Email oder Telefonnummer erforderlich.");
  }

  if (password !== password2) {
    return res.send("❌ Passwörter stimmen nicht überein.");
  }

  const accounts = loadAccounts();

  if (email && accounts.some(a => a.email === email)) {
    return res.send("❌ Email existiert bereits.");
  }

  if (phone && accounts.some(a => a.phone === phone)) {
    return res.send("❌ Telefonnummer existiert bereits.");
  }

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
  setCookie(res, "deviceToken", token, { httpOnly: true });

  res.send(
    !superAdminExists
      ? "✅ Superadmin erstellt. <a href='/dashboard'>Dashboard</a>"
      : "✅ Registriert – wartet auf Freigabe."
  );
});

/* =========================
   LOGIN
========================= */
router.get("/login", (req, res) => {
  res.send(`
  <h1>Login</h1>
  <form method="POST">
    Email oder Telefon <input name="identifier" required><br>
    Passwort <input type="password" name="password" required><br><br>
    <button>Login</button>
  </form>
  `);
});

router.post("/login", (req, res) => {
  const { identifier, password } = req.body;
  const accounts = loadAccounts();

  const acc = accounts.find(
    a => a.email === identifier || a.phone === identifier
  );

  if (!acc || !verifyPassword(password, acc.salt, acc.hash)) {
    return res.send("❌ Login fehlgeschlagen.");
  }

  if (!acc.approved) {
    return res.send("⛔ Account noch nicht freigegeben.");
  }

  const token = crypto.randomBytes(32).toString("hex");
  acc.deviceTokens.push(token);
  saveAccounts(accounts);

  setCookie(res, "deviceToken", token, { httpOnly: true });
  res.redirect("/dashboard");
});

/* =========================
   DASHBOARD
========================= */
router.get("/dashboard", requireAuth, (req, res) => {
  const accounts = loadAccounts();

  let html = `
<!DOCTYPE html>
<html>
<body>
<h1>Dashboard</h1>
<p>${req.user.firstName} (${req.user.role})</p>

<script>
setInterval(() => location.reload(), 300000);
function togglePw(id){
  const el=document.getElementById(id);
  el.type = el.type==="password" ? "text" : "password";
}
</script>

<h2>Passwort ändern</h2>
<form method="POST" action="/change-password">
  Alt <input type="password" id="oldPw" name="oldPassword" required>
  <button type="button" onclick="togglePw('oldPw')">👁</button><br>
  Neu <input type="password" id="newPw" name="newPassword" required>
  <button type="button" onclick="togglePw('newPw')">👁</button><br><br>
  <button>Speichern</button>
</form>
`;

  if (req.user.role !== "customer") {
    html += `<h2>Accounts</h2>`;
    accounts.forEach((a, i) => {
      html += `
<p>
${a.firstName} ${a.lastName} – ${(a.email || a.phone)} – ${a.role} – ${a.approved ? "✅" : "⛔"}
${!a.approved ? `
<a href="/approve/${i}/admin">Admin</a> |
<a href="/approve/${i}/customer">Kunde</a>
` : ""}
${req.user.role === "superadmin" ? `
<form method="POST" action="/delete-account" style="display:inline">
  <input type="hidden" name="idx" value="${i}">
  <button>🗑</button>
</form>` : ""}
</p>`;
    });
  }

  html += `</body></html>`;
  res.send(html);
});

/* =========================
   APPROVE / DELETE
========================= */
router.get("/approve/:idx/:role", requireAuth, requireAdmin, (req, res) => {
  const accounts = loadAccounts();
  const acc = accounts[req.params.idx];
  if (!acc) return res.send("❌ Nicht gefunden");

  acc.role = req.params.role;
  acc.approved = true;
  saveAccounts(accounts);

  res.redirect("/dashboard");
});

router.post("/delete-account", requireAuth, (req, res) => {
  if (req.user.role !== "superadmin") {
    return res.send("🚫 Nur Superadmin");
  }

  const accounts = loadAccounts();
  accounts.splice(req.body.idx, 1);
  saveAccounts(accounts);

  res.redirect("/dashboard");
});

/* =========================
   CHANGE PASSWORD
========================= */
router.post("/change-password", requireAuth, (req, res) => {
  const { oldPassword, newPassword } = req.body;
  const accounts = loadAccounts();

  const accIndex = accounts.findIndex(a => a === req.user);
  if (accIndex === -1) return res.send("❌ Account nicht gefunden");

  const acc = accounts[accIndex];

  if (!verifyPassword(oldPassword, acc.salt, acc.hash)) {
    return res.send("❌ Altes Passwort falsch");
  }

  const { salt, hash } = hashPassword(newPassword);
  acc.salt = salt;
  acc.hash = hash;
  saveAccounts(accounts);

  res.send("✅ Passwort geändert. <a href='/dashboard'>Zurück</a>");
});

export default router;
