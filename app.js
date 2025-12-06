import express from "express";
import dashboardRoutes from "./dashboard/routes.js";
import { startTelegramBots } from "./channels/telegram/oneBot.js";

const app = express();
const PORT = process.env.PORT || 10000;

/* =========================
   MIDDLEWARE
========================= */
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

/* =========================
   ROUTES
   (‼️ WICHTIG: root-mount, NICHT /dashboard)
========================= */
app.use("/", dashboardRoutes);

/* =========================
   SERVER START
========================= */
let botsStarted = false;

app.listen(PORT, async () => {
  console.log("✅ Server läuft auf Port", PORT);

  // ✅ Bots NUR EINMAL starten (Render-safe)
  if (!botsStarted) {
    botsStarted = true;
    try {
      await startTelegramBots();
      console.log("🤖 Telegram-Bots initial gestartet");
    } catch (err) {
      console.error("❌ Fehler beim Starten der Bots:", err);
    }
  }
});
