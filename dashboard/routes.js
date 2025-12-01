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
   GLOBAL HELPER
========================= */
const baseStyle = (dark=false)=>`
<style>
* { box-sizing:border-box; }
body {
  margin:0;
  font-family: system-ui, sans-serif;
  background:${dark ? "#111" : "#f4f4f4"};
  color:${dark ? "#eee" : "#111"};
}
.container {
  max-width: 900px;
  margin: 40px auto;
  background:${dark ? "#1a1a1a" : "#fff"};
  padding: 32px;
  border-radius: 12px;
}
h1,h2 { margin-top:0; }
input,button {
  width:100%;
  padding:14px;
  margin-top:8px;
  font-size:16px;
}
button {
  cursor:pointer;
  border:none;
  border-radius:6px;
}
button.primary { background:#4f46e5; color:white; }
button.danger { background:#b91c1c;color:white; }
.eye { margin-left:8px; }
nav a {
  margin-right:16px;
  font-weight:600;
}
.card {
  border:1px solid #4444;
  padding:16px;
  border-radius:8px;
  margin-bottom:12px;
}
</style>
`;

const pwScript = `
<script>
function togglePw(id){
  const el=document.getElementById(id);
  el.type = el.type==="password" ? "text" : "password";
}
</script>
`;

function dashboardLayout(req, content){
  return `
<!doctype html>
<html><head>
<meta charset="utf-8">
<title>Dashboard</title>
${baseStyle(req.user.darkMode)}
</head>
<body>

<nav class="container">
  <a href="/dashboard/account">Account</a>
  <a href="/dashboard/security">Sicherheit</a>
  <a href="/dashboard/bots">Bots</a>
  ${req.user.role !== "customer" ? `<a href="/dashboard/admin">Admin</a>` : ""}
  <a href="/logout" style="color:#ef4444">Logout</a>
</nav>

<div class="container">
${content}
</div>

</body></html>`;
}

/* =========================
   REGISTER
========================= */
router.get("/register",(req,res)=>{
  res.send(`
<!doctype html><html><head>
${baseStyle()}
</head><body>

<div class="container">
<h1>Registrierung</h1>

<form method="POST">
<input name="firstName" placeholder="Vorname" required>
<input name="lastName" placeholder="Nachname" required>

<input name="email" placeholder="Email">
<input name="phone" placeholder="Telefon">

<label>Passwort</label>
<input type="password" id="pw1" name="password" required>
<button type="button" onclick="togglePw('pw1')">👁</button>

<label>Bestätigen</label>
<input type="password" id="pw2" name="password2" required>
<button type="button" onclick="togglePw('pw2')">👁</button>

<button class="primary">Registrieren</button>
</form>

<p style="margin-top:16px">Email ODER Telefonnummer erforderlich</p>
</div>

${pwScript}
</body></html>
`);
});

/* === POST REGISTER BLEIBT LOGISCH GLEICH === */
router.post("/register",(req,res)=>{
  const {firstName,lastName,email,phone,password,password2}=req.body;
  if(!email && !phone) return res.send("❌ Email oder Telefon nötig");
  if(password!==password2) return res.send("❌ Passwörter stimmen nicht");

  const accounts=loadAccounts();
  if(email && accounts.some(a=>a.email===email))return res.send("❌ Email existiert");
  if(phone && accounts.some(a=>a.phone===phone))return res.send("❌ Telefon existiert");

  const isFirst=!accounts.some(a=>a.role==="superadmin");
  const {salt,hash}=hashPassword(password);

  accounts.push({
    firstName,lastName,
    email:email||null, phone:phone||null,
    salt,hash,
    role:isFirst?"superadmin":"customer",
    approved:isFirst,
    deviceTokens:[],
    assignedBots:[],
    darkMode:false,
    forcePasswordReset:false,
    resetToken:null
  });

  saveAccounts(accounts);
  res.send(isFirst
    ? "✅ Superadmin erstellt. <a href='/login'>Login</a>"
    : "✅ Registrierung erfolgreich – wartet auf Freigabe.");
});

/* =========================
   LOGIN
========================= */
router.get("/login",(req,res)=>{
  res.send(`
<!doctype html><html><head>
${baseStyle()}
</head><body>

<div class="container">
<h1>Login</h1>
<form method="POST">
<input name="identifier" placeholder="Email oder Telefon" required>

<input type="password" id="pwLogin" name="password" required>
<button type="button" onclick="togglePw('pwLogin')">👁</button>

<button class="primary">Login</button>
</form>
</div>

${pwScript}
</body></html>
`);
});

/* === LOGIN POST UNVERÄNDERT === */
router.post("/login",(req,res)=>{
  const {identifier,password}=req.body;
  const accounts=loadAccounts();
  const acc=accounts.find(a=>a.email===identifier||a.phone===identifier);
  if(!acc||!verifyPassword(password,acc.salt,acc.hash))
    return res.send("❌ Login fehlgeschlagen");
  if(!acc.approved)return res.send("⛔ Nicht freigegeben");
  if(acc.forcePasswordReset)return res.send("🔑 Reset erforderlich");

  const token=crypto.randomBytes(32).toString("hex");
  acc.deviceTokens.push(token);
  saveAccounts(accounts);
  setCookie(res,"deviceToken",token,{httpOnly:true});
  res.redirect("/dashboard/account");
});

/* =========================
   DASHBOARD ROUTES (ALLES BLEIBT)
========================= */
router.get("/dashboard",(req,res)=>res.redirect("/dashboard/account"));

router.get("/dashboard/account",requireAuth,(req,res)=>{
  res.send(dashboardLayout(req,`
<h2>Account</h2>
<p>${req.user.firstName} (${req.user.role})</p>
<form method="POST" action="/dashboard/toggle-darkmode">
<button>Darkmode wechseln</button>
</form>
`));
});

router.post("/dashboard/toggle-darkmode",requireAuth,(req,res)=>{
  const acc=loadAccounts().find(a=>a.email===req.user.email);
  acc.darkMode=!acc.darkMode;
  saveAccounts(loadAccounts());
  res.redirect("/dashboard/account");
});

/* === restlicher Code (Admin, Reset, Bots, Logout) BLEIBT IDENTISCH === */

export default router;
