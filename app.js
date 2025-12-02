import express from "express";
import dashboardRoutes from "./dashboard/routes.js";
import { startTelegramBots } from "./channels/telegram/botRunner.js";

const app = express();
const PORT = process.env.PORT || 10000;

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use("/", dashboardRoutes);

app.listen(PORT, () => {
  console.log("✅ Server läuft auf Port", PORT);
  startTelegramBots();   // 👉 startet alle aktiven Bots aus bots.json
});
