import express from "express";

console.log("✅ app.js gestartet");

const app = express();

app.get("/", (req, res) => {
  res.send("OK");
});

const PORT = process.env.PORT || 10000;

app.listen(PORT, () => {
  console.log("✅ Server läuft auf Port", PORT);
});
