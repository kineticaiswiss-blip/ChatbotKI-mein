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
import { loadBots, saveBots, createBot } from "./bots.js";

const router = express.Router();

/* =========================
   GLOBAL STYLE + HELFER
========================= */
const baseStyle = (dark=false)=>`
<style>
*{box-sizing:border-box}
body{
  margin:0;
  font-family:system-ui,sans-serif;
  background:${dark?"#111":"#f4f4f4"};
  color:${dark?"#eee":"#111"}
}
.container{
  max-width:900px;
  margin:40px auto;
  background:${dark?"#1a1a1a":"#fff"};
  padding:32px;
  border-radius:12px
}
nav a{margin-right:16px;font-weight:600}
input,button{
  width:100%;
  padding:14px;
  margin-top:10px;
  font-size:16px
}
button{
  border:none;
  border-radius:6px;
  cursor:pointer
}
.primary{background:#4f46e5;color:white}
.danger{background:#b91c1c;color:white}
.card{
  border:1px solid #9994;
  padding:16px;
  border-radius:8px;
  margin-bottom:12px
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

function layout(req, content){
  return `
<!doctype html><html><head>
<meta charset="utf-8">
<title>Dashboard</title>
${baseStyle(req.user?.darkMode)}
</head>
<body>

<nav class="container">
  <a href="/dashboard/account">Account</a>
  <a href="/dashboard/security">Sicherheit</a>
  <a href="/dashboard/bots">Bots</a>
  ${req.user.role!=="customer"?`<a href="/dashboard/admin">Admin</a>`:""}
  <a href="/logout" style="color:#e11d48">Logout</a>
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
<!doctype html><html><head>${baseStyle()}</head><body>
<div class="container">
<h1>Registrierung</h1>
<form method="POST">
<input name="firstName" placeholder="Vorname" required>
<input name="lastName" placeholder="Nachname" required>
<input name="email" placeholder="Email">
<input name="phone" placeholder="Telefon">

<input type="password" id="pw1" name="password" placeholder="Passwort" required>
<button type="button" onclick="togglePw('pw1')">👁</button>

<input type="password" id="pw2" name="password2" placeholder="Bestätigen" required>
<button type="button" onclick="togglePw('pw2')">👁</button>

<button class="primary">Registrieren</button>
</form>
</div>
${pwScript}
</body></html>
`);
});

router.post("/register",(req,res)=>{
  const {firstName,lastName,email,phone,password,password2}=req.body;
  if(!email && !phone) return res.send("❌ Email oder Telefon nötig");
  if(password!==password2) return res.send("❌ Passwörter stimmen nicht");

  const accounts=loadAccounts();
  if(email && accounts.some(a=>a.email===email)) return res.send("❌ Email existiert");
  if(phone && accounts.some(a=>a.phone===phone)) return res.send("❌ Telefon existiert");

  const isFirst=!accounts.some(a=>a.role==="superadmin");
  const {salt,hash}=hashPassword(password);

  accounts.push({
    firstName,lastName,
    email:email||null,
    phone:phone||null,
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
    : "✅ Registrierung – wartet auf Freigabe");
});

/* =========================
   LOGIN
========================= */
router.get("/login",(req,res)=>{
res.send(`
<!doctype html><html><head>${baseStyle()}</head><body>
<div class="container">
<h1>Login</h1>
<form method="POST">
<input name="identifier" placeholder="Email oder Telefon" required>
<input type="password" id="pw" name="password" placeholder="Passwort" required>
<button type="button" onclick="togglePw('pw')">👁</button>
<button class="primary">Login</button>
</form>
</div>
${pwScript}
</body></html>
`);
});

router.post("/login",(req,res)=>{
  const {identifier,password}=req.body;
  const accounts=loadAccounts();
  const acc=accounts.find(a=>a.email===identifier||a.phone===identifier);

  if(!acc||!verifyPassword(password,acc.salt,acc.hash))
    return res.send("❌ Login fehlgeschlagen");
  if(!acc.approved) return res.send("⛔ Noch nicht freigegeben");
  if(acc.forcePasswordReset) return res.send("🔑 Passwort zurücksetzen");

  const token=crypto.randomBytes(32).toString("hex");
  acc.deviceTokens.push(token);
  saveAccounts(accounts);
  setCookie(res,"deviceToken",token,{httpOnly:true});
  res.redirect("/dashboard/account");
});

/* =========================
   DASHBOARD
========================= */
router.get("/dashboard",(req,res)=>res.redirect("/dashboard/account"));

router.get("/dashboard/account",requireAuth,(req,res)=>{
res.send(layout(req,`
<h2>Account</h2>
<p>${req.user.firstName} (${req.user.role})</p>
<form method="POST" action="/dashboard/toggle-darkmode">
<button>🌙 Darkmode wechseln</button>
</form>`));
});

router.post("/dashboard/toggle-darkmode",requireAuth,(req,res)=>{
  const accounts=loadAccounts();
  const acc=accounts.find(a=>a.email===req.user.email);
  acc.darkMode=!acc.darkMode;
  saveAccounts(accounts);
  res.redirect("/dashboard/account");
});

router.get("/dashboard/security",requireAuth,(req,res)=>{
res.send(layout(req,`
<h2>Sicherheit</h2>
<form method="POST" action="/change-password">
<input type="password" id="o" name="oldPassword" placeholder="Alt" required>
<button type="button" onclick="togglePw('o')">👁</button>
<input type="password" id="n1" name="newPassword" placeholder="Neu" required>
<button type="button" onclick="togglePw('n1')">👁</button>
<input type="password" id="n2" name="newPassword2" placeholder="Bestätigen" required>
<button type="button" onclick="togglePw('n2')">👁</button>
<button class="primary">Speichern</button>
</form>${pwScript}`));
});

router.post("/change-password",requireAuth,(req,res)=>{
  const {oldPassword,newPassword,newPassword2}=req.body;
  if(newPassword!==newPassword2) return res.send("❌");

  const token=parseCookies(req).deviceToken;
  const accounts=loadAccounts();
  const acc=accounts.find(a=>a.deviceTokens.includes(token));
  if(!verifyPassword(oldPassword,acc.salt,acc.hash)) return res.send("❌");

  Object.assign(acc,hashPassword(newPassword));
  saveAccounts(accounts);
  res.redirect("/dashboard/security");
});

/* =========================
   BOTS
========================= */
router.get("/dashboard/bots",requireAuth,(req,res)=>{
  const bots=loadBots();
  const visible=req.user.role==="customer"
    ? bots.filter(b=>b.ownerEmail===req.user.email)
    : bots;

  let html="<h2>Bots</h2>";
  visible.forEach(b=>{
    html+=`
    <div class="card">
      <b>${b.name}</b><br>
      ID: ${b.id}<br>
      Besitzer: ${b.ownerEmail}
    </div>`;
  });

  if(req.user.role!=="customer"){
    html+=`
    <h3>➕ Bot erstellen</h3>
    <form method="POST">
      <input name="name" placeholder="Bot Name" required>
      <input name="ownerEmail" placeholder="Kunden Email" required>
      <button class="primary">Erstellen</button>
    </form>`;
  }

  res.send(layout(req,html));
});

router.post("/dashboard/bots",requireAuth,requireAdmin,(req,res)=>{
  const {name,ownerEmail}=req.body;
  const accounts=loadAccounts();
  const owner=accounts.find(a=>a.email===ownerEmail && a.role==="customer");
  if(!owner) return res.send("❌ Ungültiger Kunde");

  const bots=loadBots();
  bots.push(createBot(name,ownerEmail));
  saveBots(bots);
  res.redirect("/dashboard/bots");
});

/* =========================
   ADMIN
========================= */
router.get("/dashboard/admin",requireAuth,requireAdmin,(req,res)=>{
  const accounts=loadAccounts();
  let html="<h2>Admin Übersicht</h2>";

  accounts.forEach((a,i)=>{
    const self=a.email===req.user.email;
    html+=`
    <div class="card">
      <b>${a.firstName} ${a.lastName}</b><br>
      Rolle: ${a.role}<br>
      Status: ${a.approved?"✅":"⛔"}<br>

      ${!a.approved?`
      <a href="/approve/${i}/customer">✅ Kunde</a>
      ${req.user.role==="superadmin"
        ?` | <a href="/approve/${i}/admin">🛠 Admin</a>`:""}
      `:""}

      ${req.user.role==="superadmin"&&!self?`
      <form method="POST" action="/force-reset">
        <input type="hidden" name="idx" value="${i}">
        <button class="danger">Reset PW</button>
      </form>`:""}
    </div>`;
  });

  res.send(layout(req,html));
});

router.get("/approve/:idx/:role",requireAuth,requireAdmin,(req,res)=>{
  const accounts=loadAccounts();
  const idx=Number(req.params.idx);
  const role=req.params.role;

  if(!accounts[idx]) return res.send("❌");
  if(!["customer","admin"].includes(role)) return res.send("❌");

  if(role==="admin" && req.user.role!=="superadmin")
    return res.send("🚫");

  accounts[idx].role=role;
  accounts[idx].approved=true;
  saveAccounts(accounts);
  res.redirect("/dashboard/admin");
});

router.post("/force-reset",requireAuth,(req,res)=>{
  if(req.user.role!=="superadmin") return res.send("🚫");
  const accounts=loadAccounts();
  const acc=accounts[req.body.idx];
  if(acc.email===req.user.email) return res.send("❌");

  const token=crypto.randomBytes(32).toString("hex");
  Object.assign(acc,{
    forcePasswordReset:true,
    resetToken:token,
    approved:false,
    deviceTokens:[]
  });
  saveAccounts(accounts);
  res.send(`Reset-Link: <a href="/reset/${token}">${token}</a>`);
});

/* =========================
   RESET + LOGOUT
========================= */
router.get("/reset/:t",(req,res)=>{
res.send(`<form method="POST">
<input name="pw1" type="password">
<input name="pw2" type="password">
<button>Speichern</button>
</form>`);
});

router.post("/reset/:t",(req,res)=>{
  const accounts=loadAccounts();
  const acc=accounts.find(a=>a.resetToken===req.params.t);
  Object.assign(acc,{
    ...hashPassword(req.body.pw1),
    forcePasswordReset:false,
    resetToken:null,
    approved:true
  });
  saveAccounts(accounts);
  res.redirect("/login");
});

router.get("/logout",(req,res)=>{
  res.setHeader("Set-Cookie","deviceToken=; Path=/; Max-Age=0");
  res.redirect("/login");
});

export default router;
