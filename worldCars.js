// MAF-WORLD-CARS-V3 : voitures du World debloquees par joueur.
// La Porsche est pour tous. Les voitures exclusives (Lamborghini) appartiennent d'office au compte
// proprietaire ; les autres joueurs les recoivent en cadeau ou en gain de tournoi (offerte par le proprietaire).
// Le serveur decide : le client ne fait qu'afficher.
import { Router } from "express";
import { pool } from "./db.js";
import { requireSession } from "./auth.js";
import { isOwnerAccount } from "./accountRoles.js";

export const DEFAULT_CAR = "porsche-911-gt3-rs";
export const EXCLUSIVE_CARS = Object.freeze(["lamborghini-veneno-roadster"]);
export const worldCarsRouter = Router();

const CACHE_MS = 30000;
const cache = new Map(); // userId -> { t, owned:Set, owner:boolean }
let tableReady;

function ensureTable() {
  if (!tableReady) {
    tableReady = pool.query(
      "CREATE TABLE IF NOT EXISTS maf_world_car_unlocks (" +
      "user_id integer NOT NULL REFERENCES maf_users(id) ON DELETE CASCADE, " +
      "car_id text NOT NULL, source text NOT NULL DEFAULT 'owner_grant', " +
      "created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (user_id, car_id))"
    ).catch((error) => { tableReady = null; throw error; });
  }
  return tableReady;
}

export async function carsOwnedBy(userId) {
  const hit = cache.get(userId);
  if (hit && Date.now() - hit.t < CACHE_MS) return hit;
  const owned = new Set([DEFAULT_CAR]);
  const owner = await isOwnerAccount(userId, pool);
  if (owner) EXCLUSIVE_CARS.forEach((id) => owned.add(id));
  else {
    await ensureTable();
    const { rows } = await pool.query("SELECT car_id FROM maf_world_car_unlocks WHERE user_id = $1", [userId]);
    for (const r of rows) if (EXCLUSIVE_CARS.includes(r.car_id)) owned.add(r.car_id);
  }
  const entry = { t: Date.now(), owned, owner };
  cache.set(userId, entry);
  return entry;
}

// Voiture que ce joueur a reellement le droit d'utiliser (jamais celle qu'il pretend avoir).
export async function usableCar(userId, carId) {
  if (typeof carId !== "string" || carId === DEFAULT_CAR) return DEFAULT_CAR;
  try { return (await carsOwnedBy(userId)).owned.has(carId) ? carId : DEFAULT_CAR; }
  catch (error) { return DEFAULT_CAR; }
}

worldCarsRouter.get("/mine", requireSession, async (req, res) => {
  try {
    const { owned, owner } = await carsOwnedBy(req.userId);
    res.set("Cache-Control", "no-store").json({ owned: Array.from(owned), owner });
  } catch (error) {
    console.error("world cars mine:", error.message);
    res.status(503).json({ error: "Voitures indisponibles" });
  }
});

// Compte proprietaire uniquement : offrir ou retirer une voiture exclusive (cadeau, gain de tournoi).
worldCarsRouter.post("/grant", requireSession, async (req, res) => {
  try {
    if (!(await isOwnerAccount(req.userId, pool))) return res.status(403).json({ error: "Réservé au compte propriétaire." });
    const b = req.body || {};
    const clientId = typeof b.clientId === "string" ? b.clientId.trim() : "";
    if (!/^\d{5}$/.test(clientId)) return res.status(400).json({ error: "ID client à cinq chiffres requis." });
    if (!EXCLUSIVE_CARS.includes(b.carId)) return res.status(400).json({ error: "Voiture inconnue." });
    if (!["give", "revoke"].includes(b.action)) return res.status(400).json({ error: "Action inconnue." });
    const user = (await pool.query("SELECT id, pseudo FROM maf_users WHERE client_id::text = $1", [clientId])).rows[0];
    if (!user) return res.status(404).json({ error: "Aucun joueur avec cet ID client." });
    await ensureTable();
    if (b.action === "give") {
      await pool.query(
        "INSERT INTO maf_world_car_unlocks (user_id, car_id, source) VALUES ($1, $2, 'owner_grant') ON CONFLICT (user_id, car_id) DO NOTHING",
        [user.id, b.carId]);
    } else {
      await pool.query("DELETE FROM maf_world_car_unlocks WHERE user_id = $1 AND car_id = $2", [user.id, b.carId]);
    }
    cache.delete(user.id);
    res.json({ ok: true, pseudo: user.pseudo });
  } catch (error) {
    console.error("world cars grant:", error.message);
    res.status(503).json({ error: "Opération indisponible" });
  }
});
