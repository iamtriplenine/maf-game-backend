import express from "express";
import cors from "cors";
import { walletRouter } from "./wallet.js";
import { pool } from "./db.js";
import { authRouter } from "./auth.js";
import { chatRouter } from "./chat.js";
import { roomsRouter, maintainRooms } from "./rooms.js";
import { historyRouter } from "./history.js";

const app = express();
app.use(express.json({ limit: "3mb" }));

// Adresses du site autorisees a appeler ce serveur (separees par des virgules).
// Sur Render : variable FRONT_ORIGINS. En local : http://localhost:5173
const origins = (process.env.FRONT_ORIGINS || "http://localhost:5173")
  .split(",")
  .map((item) => item.trim())
  .filter(Boolean);
app.use(cors({ origin: (origin, done) => done(null, !origin || origins.includes(origin) || /\.app\.github\.dev$/.test(origin)) }));

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

app.use("/api", authRouter); // /api/register, /api/login, /api/me

app.use("/api", chatRouter); // /api/chat

app.use("/api/rooms", roomsRouter); // Salons et tir au but (etape 2)

app.use("/api", walletRouter);
app.use("/api/history", historyRouter);
app.use((error, _req, res, _next) => {
  if (error.type === "entity.too.large") return res.status(413).json({ error: "Capture trop volumineuse (2 Mo maximum)." });
  if (error.type === "entity.parse.failed") return res.status(400).json({ error: "JSON invalide." });
  console.error(error.message);
  res.status(500).json({ error: "Erreur serveur." });
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Serveur pret sur le port ${port}`);
});
// Also settle timeouts when both players have left the screen.
setInterval(() => { void maintainRooms().catch(error => console.error("room maintenance:", error.message)); }, 1000).unref();
void maintainRooms().catch(error => console.error("room maintenance:", error.message));
