import express from "express";
import dashboardRoutes from "./dashboard/routes.js";

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

app.use("/", dashboardRoutes);

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log("✅ Dashboard läuft auf Port", PORT));
