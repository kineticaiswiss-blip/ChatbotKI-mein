import express from "express";
import dashboardRoutes from "./dashboard/routes.js";

const app = express();
const PORT = process.env.PORT || 10000;

app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// ✅ HIER PASSIERT DAS WICHTIGE
app.use("/", dashboardRoutes);

app.listen(PORT, () => {
  console.log("✅ Server läuft auf Port", PORT);
});
