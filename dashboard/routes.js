import express from "express";
const router = express.Router();

router.get("/", (req, res) => {
  res.send(`
    <h1>Dashboard</h1>
    <p>✅ Server läuft</p>
  `);
});

export default router;

