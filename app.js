import express from "express";
import dashboardRoutes from "./dashboard/routes.js";
import { initAllBots } from "./channels/telegram/manager.js";

const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use("/", dashboardRoutes);

// Telegram-Bots starten
initAllBots();

const PORT = process.env.PORT || 10000;
app.listen(PORT, () =>
  console.log("✅ Server läuft auf Port", PORT)
);
