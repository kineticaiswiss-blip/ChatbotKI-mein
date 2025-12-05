import express from "express";
import dashboardRoutes from "./dashboard/routes.js";
import { startTelegramBots } from "./channels/telegram/oneBot.js";

const app = express();
const PORT = process.env.PORT || 10000;

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use("/", dashboardRoutes);

app.listen(PORT, async () => {
  console.log("✅ Server läuft auf Port", PORT);
  await startTelegramBots();   // ✅ EINMAL
});
