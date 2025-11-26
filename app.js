import express from "express";
import { initAllBots } from "./bots/manager.js";
import dashboardRoutes from "./dashboard/routes.js";

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Dashboard
app.use("/", dashboardRoutes);

// Bots starten
initAllBots(app);

// Server
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log("✅ Server läuft auf Port", PORT);
});
