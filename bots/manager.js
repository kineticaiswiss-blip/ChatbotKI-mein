import fs from "fs";
import path from "path";
import { initOneBot } from "./oneBot.js";

const DATA_DIR = "./data";
const BOTS_FILE = path.join(DATA_DIR, "bots.json");
const BOTS_INFO_DIR = path.join(DATA_DIR, "bots_info");

export function initAllBots(app) {
  if (!fs.existsSync(BOTS_FILE)) {
    console.log("⚠️ Keine bots.json gefunden – keine Bots gestartet");
    return;
  }

  const bots = JSON.parse(fs.readFileSync(BOTS_FILE, "utf8"));

  if (!Array.isArray(bots) || bots.length === 0) {
    console.log("ℹ️ Keine Bots gespeichert");
    return;
  }

  bots.forEach(bot => {
    const infoPath = path.join(BOTS_INFO_DIR, bot.id + ".json");

    if (!fs.existsSync(infoPath)) {
      console.log(`⚠️ Info-Datei fehlt für Bot ${bot.id}`);
      return;
    }

    initOneBot(bot.id, app);
  });

  console.log(`✅ ${bots.length} Bots initialisiert`);
}
