// Monde 3D (World) : presence des vrais joueurs.
// Chaque joueur connecte envoie sa position ; le serveur lui renvoie celle des autres,
// avec le skin ENREGISTRE SUR LEUR PROFIL (lu dans la base, jamais envoye par le client).
// Les positions restent en memoire. Seul le statut courant de chaque joueur est conserve.
import { Router } from "express";
import { pool } from "./db.js";
import { requireSession } from "./auth.js";

export const worldPresenceRouter = Router();

const TTL_MS = 7000;        // un joueur sans signe de vie depuis 7 s disparait
const MAX_RETURN = 25;      // joueurs renvoyes au maximum a chaque appel
const MAX_COORD = 2000;     // la ville fait environ 450 x 400 : tout ce qui depasse est refuse
const INFO_REFRESH_MS = 60000;
const STATUS_MAX_LENGTH = 180;

const players = new Map();
let statusTableReady;

function ensureStatusTable() {
  if (!statusTableReady) {
    statusTableReady = pool.query(
      "create table if not exists maf_world_statuses (" +
      "user_id integer primary key references maf_users(id) on delete cascade, " +
      "status_text varchar(" + STATUS_MAX_LENGTH + ") not null, " +
      "status_version integer not null default 1)"
    ).catch(error => {
      statusTableReady = null;
      throw error;
    });
  }
  return statusTableReady;
}

function syncStatus(player, row) {
  // Une lecture commencee avant une ecriture ne doit pas remettre l'ancien statut.
  if (player && row.status_version > player.statusVersion) {
    player.status = row.status_text;
    player.statusVersion = row.status_version;
  }
}

async function refreshIdentity(userId, p) {
  const now = Date.now();
  if (p.name && now - p.infoAt < INFO_REFRESH_MS) return;
  let result;
  try {
    await ensureStatusTable();
    result = await pool.query(
      "select u.pseudo, u.skin_id, s.status_text, s.status_version from maf_users u " +
      "left join maf_world_statuses s on s.user_id = u.id where u.id = $1", [userId]
    );
  } catch (error) {
    console.error("world status read :", error.message);
    result = await pool.query("select pseudo, skin_id from maf_users where id = $1", [userId]);
  }
  const row = result.rows[0];
  if (!row) return;
  p.name = String(row.pseudo || "Joueur").slice(0, 20);
  p.skin = row.skin_id || "loki";
  syncStatus(p, row);
  p.infoAt = now;
}

function prune(now = Date.now()) {
  for (const [id, p] of players) if (now - p.t > TTL_MS * 4) players.delete(id);
}
setInterval(() => prune(), 15000).unref();

worldPresenceRouter.put("/status", requireSession, async (req, res) => {
  const text = req.body?.status;
  if (typeof text !== "string" || text.length > STATUS_MAX_LENGTH || text.includes("\0")) {
    return res.status(400).json({ error: "Écris un statut de 180 caractères maximum." });
  }
  try {
    await ensureStatusTable();
    const { rows: [row] } = await pool.query(
      "insert into maf_world_statuses (user_id, status_text) values ($1, $2) " +
      "on conflict (user_id) do update set status_text = excluded.status_text, " +
      "status_version = maf_world_statuses.status_version + 1 returning status_text, status_version",
      [req.userId, text.trim()]
    );
    syncStatus(players.get(req.userId), row);
    res.json({ status: row.status_text, statusVersion: row.status_version });
  } catch (error) {
    console.error("world status write :", error.message);
    res.status(500).json({ error: "Impossible d’enregistrer le statut. Réessaie." });
  }
});

worldPresenceRouter.post("/presence", requireSession, async (req, res) => {
  const userId = req.userId;
  const now = Date.now();
  const b = req.body || {};
  let p = players.get(userId);
  if (!p) {
    p = { x: 0, z: 0, yaw: 0, mv: 0, veh: 0, t: 0, name: "", skin: "loki", infoAt: 0, status: "", statusVersion: 0 };
    players.set(userId, p);
  }
  if (now - p.t > TTL_MS) p.infoAt = 0;   // il revient dans le monde : on relit son skin actuel
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
      id, name: q.name, skin: q.skin, status: q.status,
      x: Math.round(q.x * 100) / 100, z: Math.round(q.z * 100) / 100,
      yaw: Math.round(q.yaw * 1000) / 1000, mv: q.mv, veh: q.veh,
    });
    if (out.length >= MAX_RETURN) break;
  }
  res.json({ me: { name: p.name, skin: p.skin, status: p.status, statusVersion: p.statusVersion }, players: out });
});

worldPresenceRouter.post("/leave", requireSession, (req, res) => {
  players.delete(req.userId);
  res.json({ ok: true });
});
