import express from "express";
import cors from "cors";
import { pool } from "./db.js";

const app = express();
app.use(express.json());

// Adresses du site autorisees a appeler ce serveur (separees par des virgules).
// Sur Render : variable FRONT_ORIGINS. En local : http://localhost:5173
const origins = (process.env.FRONT_ORIGINS || "http://localhost:5173")
  .split(",")
  .map((item) => item.trim())
  .filter(Boolean);
app.use(cors({ origin: origins }));

app.get("/", (_req, res) => {
  res.json({ name: "maf-game-backend", ok: true });
});

// Test de vie + test de la connexion a la base de donnees
app.get("/health", async (_req, res) => {
  if (!pool) {
    return res.json({ ok: true, db: "non configuree (DATABASE_URL vide)" });
  }
  try {
    const result = await pool.query("select now() as now");
    res.json({ ok: true, db: "ok", now: result.rows[0].now });
  } catch (error) {
    res.status(500).json({ ok: false, db: "erreur", message: error.message });
  }
});

// Ici viendront les routes : /api/register, /api/login, ...

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Serveur pret sur le port ${port}`);
});