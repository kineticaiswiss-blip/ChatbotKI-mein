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
   HELFER (PW-AUGE)
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
   DASHBOARD LAYOUT
========================= */
function dashboardLayout(req, content) {
  const dark = req.user.darkMode;
  return `
<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>Dashboard</title>
<style>
body {
  font-family: sans-serif;
  background: ${dark ? "#111" : "#fff"};
  color: ${dark ? "#eee" : "#000"};
}
a { margin-right: 12px; }
button { margin: 4px; }
</style>
</head>
<body>

<nav>
  <a href="/dashboard/account">Account</a>
  <a href="/dashboard/security">Sicherheit</a>
  <a href="/dashboard/bots">Bots</a>
  ${req.user.role !== "customer" ? `<a href="/dashboard/admin">Admin</a>` : ""}
  <a href="/logout" style="color:red">Logout</a>
</nav>
<hr>

${content}

</body>
</html>`;
}

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

Bestätigen
<input type="password" id="pw2" name="password2" required>
<button type="button" onclick="togglePw('pw2')">👁</button><br><br>

<button>Registrieren</button>
</form>
${pwScript}
`);
});

router.post("/register",(req,res)=>{
  const { firstName,lastName,email,phone,password,password2 } = req.body;
  if (!email && !phone) return res.send("❌ Email oder Telefon nötig");
  if (password !== password2) return res.send("❌ Passwörter stimmen nicht");

  const accounts = loadAccounts();
  if (email && accounts.some(a=>a.email===email)) return res.send("❌ Email existiert");
  if (phone && accounts.some(a=>a.phone===phone)) return res.send("❌ Telefon existiert");

  const isFirst = !accounts.some(a=>a.role==="superadmin");
  const { salt, hash } = hashPassword(password);

  accounts.push({
    firstName,lastName,
    email: email||null,
    phone: phone||null,
    salt,hash,
    role: isFirst ? "superadmin" : "customer",
    approved: isFirst,
    deviceTokens: [],
    assignedBots: [],
    darkMode: false,
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
  const { identifier,password } = req.body;
  const accounts = loadAccounts();
  const acc = accounts.find(a=>a.email===identifier||a.phone===identifier);

  if (!acc || !verifyPassword(password,acc.salt,acc.hash))
    return res.send("❌ Login fehlgeschlagen");

  if (!acc.approved)
    return res.send("⛔ Account wartet auf Freigabe");

  if (acc.forcePasswordReset)
    return res.send("🔑 Passwort-Reset erforderlich");

  const token = crypto.randomBytes(32).toString("hex");
  acc.deviceTokens.push(token);
  saveAccounts(accounts);

  setCookie(res,"deviceToken",token,{httpOnly:true});
  res.redirect("/dashboard/account");
});

/* =========================
   DASHBOARD
========================= */
router.get("/dashboard",(req,res)=>res.redirect("/dashboard/account"));

router.get("/dashboard/account", requireAuth,(req,res)=>{
  res.send(dashboardLayout(req,`
<h2>Account</h2>
<p>${req.user.firstName} (${req.user.role})</p>

<form method="POST" action="/dashboard/toggle-darkmode">
  <button>Darkmode wechseln</button>
</form>
`));
});

router.post("/dashboard/toggle-darkmode", requireAuth,(req,res)=>{
  const accounts=loadAccounts();
  const acc=accounts.find(a=>a.email===req.user.email);
  acc.darkMode=!acc.darkMode;
  saveAccounts(accounts);
  res.redirect("/dashboard/account");
});

router.get("/dashboard/security", requireAuth,(req,res)=>{
  res.send(dashboardLayout(req,`
<h2>Passwort ändern</h2>
<form method="POST" action="/change-password">
Alt <input type="password" id="opw" name="oldPassword" required>
<button type="button" onclick="togglePw('opw')">👁</button><br>

Neu <input type="password" id="npw1" name="newPassword" required>
<button type="button" onclick="togglePw('npw1')">👁</button><br>

Bestätigen <input type="password" id="npw2" name="newPassword2" required>
<button type="button" onclick="togglePw('npw2')">👁</button><br><br>

<button>Speichern</button>
</form>
${pwScript}`));
});

router.get("/dashboard/bots", requireAuth,(req,res)=>{
  const bots=req.user.assignedBots||[];
  res.send(dashboardLayout(req,`
<h2>Bots</h2>
<p>${bots.length?bots.join(", "):"Keine Bots zugewiesen"}</p>
`));
});

/* =========================
   ✅ ADMIN ÜBERSICHT (ANFRAGEN + ACCOUNTS)
========================= */
router.get(
  "/dashboard/admin",
  requireAuth,
  requireAdmin,
  (req,res)=>{
    const accounts=loadAccounts();
    const pending=accounts.filter(a=>!a.approved);
    const active=accounts.filter(a=>a.approved);

    let html=`<h2>🆕 Neuanfragen</h2>`;

    pending.forEach(a=>{
      const idx=accounts.indexOf(a);
      html+=`
      <div style="border:1px solid #aaa;padding:10px;margin-bottom:8px;">
        <b>${a.firstName} ${a.lastName}</b><br>
        ${a.email||""} ${a.phone||""}<br><br>
        <a href="/approve/${idx}/customer">✅ Kunde</a>
        ${req.user.role==="superadmin"
          ? ` | <a href="/approve/${idx}/admin">🛠 Admin</a>`
          : ""}
      </div>`;
    });

    html+=`<hr><h2>👤 Aktive Accounts</h2>`;

    active.forEach(a=>{
      const idx=accounts.indexOf(a);
      const isSelf=a.email===req.user.email;
      const canDelete=req.user.role==="superadmin"||a.role==="customer";

      html+=`
      <div style="border:1px solid #888;padding:10px;margin-bottom:8px;">
        <b>${a.firstName} ${a.lastName}</b> – ${a.role}<br><br>

        ${req.user.role==="superadmin" && !isSelf ? `
        <form method="POST" action="/force-reset" style="display:inline">
          <input type="hidden" name="idx" value="${idx}">
          <button>🔑 Reset PW</button>
        </form>`:""}

        ${canDelete && !isSelf ? `
        <form method="POST" action="/delete-account" style="display:inline">
          <input type="hidden" name="idx" value="${idx}">
          <button style="color:red">🗑 Löschen</button>
        </form>`:""}
      </div>`;
    });

    res.send(dashboardLayout(req,html));
  }
);

/* =========================
   ADMIN ACTIONS
========================= */
router.get("/approve/:idx/:role", requireAuth, requireAdmin,(req,res)=>{
  const accounts=loadAccounts();
  const idx=Number(req.params.idx);
  accounts[idx].role=req.params.role;
  accounts[idx].approved=true;
  saveAccounts(accounts);
  res.redirect("/dashboard/admin");
});

router.post("/delete-account", requireAuth, requireAdmin,(req,res)=>{
  const accounts=loadAccounts();
  accounts.splice(Number(req.body.idx),1);
  saveAccounts(accounts);
  res.redirect("/dashboard/admin");
});

router.post("/force-reset", requireAuth,(req,res)=>{
  if(req.user.role!=="superadmin")return res.send("🚫");
  const accounts=loadAccounts();
  const idx=Number(req.body.idx);
  const token=crypto.randomBytes(32).toString("hex");
  Object.assign(accounts[idx],{
    forcePasswordReset:true,
    resetToken:token,
    approved:false,
    deviceTokens:[]
  });
  saveAccounts(accounts);
  res.send(`Reset-Link: <a href="/reset/${token}">${token}</a>`);
});

/* =========================
   RESET / CHANGE / LOGOUT
========================= */
router.get("/reset/:t",(req,res)=>{
  res.send(`<form method="POST">
<input name="pw1" type="password"><br>
<input name="pw2" type="password"><br>
<button>Speichern</button>
</form>`);
});

router.post("/reset/:t",(req,res)=>{
  const accounts=loadAccounts();
  const acc=accounts.find(a=>a.resetToken===req.params.t);
  const {salt,hash}=hashPassword(req.body.pw1);
  Object.assign(acc,{salt,hash,forcePasswordReset:false,resetToken:null,approved:true});
  saveAccounts(accounts);
  res.redirect("/login");
});

router.post("/change-password", requireAuth,(req,res)=>{
  const token=parseCookies(req).deviceToken;
  const accounts=loadAccounts();
  const acc=accounts.find(a=>a.deviceTokens.includes(token));
  if(!verifyPassword(req.body.oldPassword,acc.salt,acc.hash))return res.send("❌");
  Object.assign(acc,hashPassword(req.body.newPassword));
  saveAccounts(accounts);
  res.redirect("/dashboard/security");
});

router.get("/logout",(req,res)=>{
  res.setHeader("Set-Cookie","deviceToken=; Path=/; Max-Age=0");
  res.redirect("/login");
});

export default router;
