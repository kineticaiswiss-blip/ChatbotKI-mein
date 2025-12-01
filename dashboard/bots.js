import fs from "fs";
const PATH = "/var/data/bots.json";

export function loadBots() {
  if (!fs.existsSync(PATH)) return [];
  return JSON.parse(fs.readFileSync(PATH,"utf8"));
}

export function saveBots(bots) {
  fs.writeFileSync(PATH, JSON.stringify(bots,null,2));
}

export function createBot(name, ownerEmail, platform="telegram") {
  return {
    id: "bot_" + Date.now(),
    name,
    ownerEmail,
    platform,
    tokenEncrypted: null,
    active: false,
    createdAt: new Date().toISOString()
  };
}
