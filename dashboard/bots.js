// dashboard/bots.js
import fs from "fs";
import path from "path";

const DATA_DIR = "/var/data";            // gleich wie in auth.js
const BOTS_FILE = path.join(DATA_DIR, "bots.json");

// Datei sicherstellen
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}
if (!fs.existsSync(BOTS_FILE)) {
  fs.writeFileSync(BOTS_FILE, "[]", "utf8");
}

export function loadBots() {
  return JSON.parse(fs.readFileSync(BOTS_FILE, "utf8"));
}

export function saveBots(bots) {
  fs.writeFileSync(BOTS_FILE, JSON.stringify(bots, null, 2), "utf8");
}

export function createBot(name, ownerEmail) {
  return {
    id: name.toLowerCase().replace(/\s+/g, "-") + "-" + Date.now(),
    name,
    token: "",                 // wird im Dashboard eingetragen
    ownerEmail,
    allowedTelegramIds: [],    // hier tragen wir Telegram-IDs ein
    active: true
  };
}
