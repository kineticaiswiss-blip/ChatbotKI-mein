// core/storage.js
import fs from "fs";
import path from "path";

const DATA_DIR = "./data";

export function readJSON(relPath, fallback = []) {
  const file = path.join(DATA_DIR, relPath);
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

export function writeJSON(relPath, data) {
  const file = path.join(DATA_DIR, relPath);
  fs.writeFileSync(file, JSON.stringify(data, null, 2), "utf8");
}
