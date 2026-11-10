// Monde 3D (World) : presence des vrais joueurs.
// Chaque joueur connecte envoie sa position ; le serveur lui renvoie celle des autres,
// avec le skin ENREGISTRE SUR LEUR PROFIL (lu dans la base, jamais envoye par le client).
// Tout est garde en memoire (aucune table) : au redemarrage du serveur, les joueurs se reaffichent en 1 s.
import { Router } from "express";
import { pool } from "./db.js";
import { requireSession } from "./auth.js";

export const worldPresenceRouter = Router();

const TTL_MS = 7000;        // un joueur sans signe de vie depuis 7 s disparait
const MAX_RETURN = 25;      // joueurs renvoyes au maximum a chaque appel
const MAX_COORD = 2000;     // la ville fait environ 450 x 400 : tout ce qui depasse est refuse
const INFO_REFRESH_MS = 60000;

const players = new Map();  // id du compte -> { x, z, yaw, mv, veh, t, name, skin, infoAt }

async function refreshIdentity(userId, p) {
  const now = Date.now();
  if (p.name && now - p.infoAt < INFO_REFRESH_MS) return;
  const result = await pool.query("select pseudo, skin_id from maf_users where id = $1", [userId]);
  const row = result.rows[0];
  if (!row) return;
  p.name = String(row.pseudo || "Joueur").slice(0, 20);
  p.skin = row.skin_id || "loki";
  p.infoAt = now;
}

function prune(now = Date.now()) {
  for (const [id, p] of players) if (now - p.t > TTL_MS * 4) players.delete(id);
}
setInterval(() => prune(), 15000).unref();

worldPresenceRouter.post("/presence", requireSession, async (req, res) => {
  const userId = req.userId;
  const now = Date.now();
  const b = req.body || {};
  let p = players.get(userId);
  if (!p) {
    p = { x: 0, z: 0, yaw: 0, mv: 0, veh: 0, t: 0, name: "", skin: "loki", infoAt: 0 };
    players.set(userId, p);
  }
  const x = Number(b.x), z = Number(b.z), yaw = Number(b.yaw);
  if (Number.isFinite(x) && Number.isFinite(z) && Math.abs(x) <= MAX_COORD && Math.abs(z) <= MAX_COORD) {
    p.x = x; p.z = z;
    p.yaw = Number.isFinite(yaw) ? yaw : p.yaw;
    p.mv = b.mv ? 1 : 0;
    p.veh = b.veh ? 1 : 0;
    p.t = now;
  }
  try {
    await refreshIdentity(userId, p);
  } catch (error) {
    console.error("world presence :", error.message);
  }
  const out = [];
  for (const [id, q] of players) {
    if (id === userId || !q.name || now - q.t > TTL_MS) continue;
    out.push({
      id, name: q.name, skin: q.skin,
      x: Math.round(q.x * 100) / 100, z: Math.round(q.z * 100) / 100,
      yaw: Math.round(q.yaw * 1000) / 1000, mv: q.mv, veh: q.veh,
    });
    if (out.length >= MAX_RETURN) break;
  }
  res.json({ players: out });
});

worldPresenceRouter.post("/leave", requireSession, (req, res) => {
  players.delete(req.userId);
  res.json({ ok: true });
});
