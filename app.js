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
========================= */
app.use("/", dashboardRoutes);

/* =========================
   SERVER START
========================= */
app.listen(PORT, async () => {
  console.log("✅ Server läuft auf Port", PORT);

  try {
    await startTelegramBots();
  } catch (err) {
    console.error("❌ Fehler beim Starten der Telegram-Bots:", err);
  }
});
