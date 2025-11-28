import express from "express";
import { startTelegramBots } from "./channels/telegram/manager.js";

const app = express();

startTelegramBots();

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`✅ Server läuft auf Port ${PORT}`);
});
