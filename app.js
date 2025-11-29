import express from "express";
import fs from "fs";
import dashboardRoutes from "./dashboard/routes.js";
import { startTelegramBots } from "./channels/telegram/manager.js";

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ✅ Persistent storage
import fs from "fs";
import path from "path";

const DATA_DIR = path.resolve("data");

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// ✅ Routes
app.use("/", dashboardRoutes);

// ✅ Start Telegram Bots
startTelegramBots();

// ✅ Start Server
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`✅ Server läuft auf Port ${PORT}`);
});
