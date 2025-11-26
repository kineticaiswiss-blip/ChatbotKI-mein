import fs from "fs";
import path from "path";
import { initOneBot } from "./oneBot.js";

const INFO_DIR = "./data/bots_info";

export function initAllBots(app) {
  if (!fs.existsSync(INFO_DIR)) return;

  const files = fs.readdirSync(INFO_DIR).filter(f => f.endsWith(".json"));

  files.forEach(file => {
    const botId = path.basename(file, ".json");
    initOneBot(botId, app);
  });

  console.log("✅ Alle Bots geladen:", files.length);
}
// bot manager placeholder

