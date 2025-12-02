import express from "express";
import dashboardRoutes from "./dashboard/routes.js";
import { startTelegramBots } from "./channels/telegram/oneBot.js";

const app = express();
const PORT = process.env.PORT || 10000;

app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// Dashboard-Routen
app.use("/", dashboardRoutes);

// Server starten
app.listen(PORT, () => {
  console.log("✅ Server läuft auf Port", PORT);
});

// Telegram-Bots starten (einmalig, nicht in listen-Callback)
startTelegramBots().catch(err => {
  console.error("❌ Fehler beim Starten der Telegram-Bots:", err);
});
