// Monde 3D (World) : presence des vrais joueurs.
// Chaque joueur connecte envoie sa position ; le serveur lui renvoie celle des autres,
// avec le skin ENREGISTRE SUR LEUR PROFIL (lu dans la base, jamais envoye par le client).
// Les positions restent en memoire. Les statuts et les vocaux temporaires sont en base.
import { randomUUID } from "node:crypto";
import { Router } from "express";
import { pool } from "./db.js";
import { requireSession } from "./auth.js";
import { sniffVoiceMime } from "./monopolyVoiceRules.js";
import { worldCarsRouter, usableCar } from "./worldCars.js"; // MAF-WORLD-CARS-V3

export const worldPresenceRouter = Router();
worldPresenceRouter.use("/cars", worldCarsRouter);

const TTL_MS = 7000;        // un joueur sans signe de vie depuis 7 s disparait
const MAX_RETURN = 25;      // joueurs renvoyes au maximum a chaque appel
const MAX_COORD = 2000;     // la ville fait environ 450 x 400 : tout ce qui depasse est refuse
const INFO_REFRESH_MS = 60000;
const STATUS_MAX_LENGTH = 180;
const VOICE_DISTANCE = 30;
const VOICE_MAX_MS = 30000;
const VOICE_WAV_RATE = 12000;
const VOICE_MAX_BYTES = 44 + VOICE_WAV_RATE * 2 * VOICE_MAX_MS / 1000;
const VOICE_TTL_MS = 90000;
const VOICE_LIMIT = 64;
const CHAT_TTL_MS = 120000;
const CHAT_LIMIT = 64;
const CHAT_MAX_LENGTH = 160;

const players = new Map();
const voiceClips = new Map();
const chatMessages = new Map();
// MAF-PARKED-CARS-V3 : derniere voiture garee de chaque compte, y compris hors ligne.
const parkedCars = new Map();
let parkedCarsReady;
let voiceTableReady;
let voiceUploads = 0;
let voiceCleanupBusy = false;
let statusTableReady;

function parkedPayload(car, player) {
  if (!car || typeof car!=='object' || !['coupe','pickup','van','buggy'].includes(car.type)) return null;
  const x=Number(car.x),z=Number(car.z),yaw=Number(car.yaw);
  if (![x,z,yaw].every(Number.isFinite) || Math.abs(x)>MAX_COORD ||
      Math.abs(z)>MAX_COORD || Math.abs(yaw)>1000) return null;
  if (Math.hypot(x-player.x,z-player.z)>(player.veh?3:8)) return null;
  return {type:car.type,x:Math.round(x*100)/100,z:Math.round(z*100)/100,
    yaw:Math.round(yaw*1000)/1000};
}
function ensureParkedCars() {
  if (!parkedCarsReady) {
    parkedCarsReady=(async()=>{
      await pool.query('create table if not exists maf_world_parked_cars ('+
        'user_id integer primary key references maf_users(id) on delete cascade,'+
        'car_type varchar(16) not null, x double precision not null,'+
        'z double precision not null, yaw double precision not null, updated_at timestamptz not null default now())');
      const {rows}=await pool.query('select user_id,car_type,x,z,yaw from maf_world_parked_cars');
      for (const r of rows) if (['coupe','pickup','van','buggy'].includes(r.car_type)) {
        parkedCars.set(r.user_id,{type:r.car_type,x:Number(r.x),z:Number(r.z),yaw:Number(r.yaw)});
      }
    })().catch(e=>{parkedCarsReady=null;throw e;});
  }
  return parkedCarsReady;
}
async function updateParkedCar(userId,car,driving) {
  await ensureParkedCars();
  if (driving) {
    if (parkedCars.has(userId)) {
      await pool.query('delete from maf_world_parked_cars where user_id=$1',[userId]);
      parkedCars.delete(userId);
    }
    return;
  }
  const old=parkedCars.get(userId);
  if (old && old.type===car.type && old.x===car.x && old.z===car.z && old.yaw===car.yaw) return;
  await pool.query('insert into maf_world_parked_cars(user_id,car_type,x,z,yaw) '+
    'values($1,$2,$3,$4,$5) on conflict(user_id) do update set '+
    'car_type=excluded.car_type,x=excluded.x,z=excluded.z,yaw=excluded.yaw,updated_at=now()',
    [userId,car.type,car.x,car.z,car.yaw]);
  parkedCars.set(userId,car);
}
function present(player, now) {
  return Boolean(player?.t && now - player.t <= TTL_MS);
}

// IDs stables du catalogue VILLA_SEATS. Les places sont libérées à la
// prochaine présence sans siège, à la déconnexion ou à l'expiration du joueur.
// MAF-FOOD-FIX-V2 : id et zone verifies ensemble, motif de refus explicite.
const FOOD_SEAT_POINTS = [
  [-5, 14], [-5, 15.56], [-5, 17.93], [-5, 20.30],
  [7.94, 16.12], [7.94, 17.72], [7.94, 20.87], [7.94, 22.46]
].map(([x,z]) => ({ x: -86 + x * .75, z: -300 + z * .75 }));
function claimVillaSeat(userId, id, x, z, now) {
  if (!Number.isInteger(id)) return { seat: null, reason: 'invalid' };
  const inVilla = id >= 1 && id <= 32 && x >= 75 && x <= 110 && z >= 242 && z <= 258;
  const inLoft = id >= 33 && id <= 39 && x >= 115 && x <= 124 && z >= 250 && z <= 263;
  const food = id >= 40 && id <= 47 ? FOOD_SEAT_POINTS[id-40] : null;
  const inFastFood = food && Math.hypot(x - food.x, z - food.z) <= 2.5;
  if (!inVilla && !inLoft && !inFastFood) return { seat: null, reason: 'out_of_range' };
  for (const [otherId, other] of players) {
    if (otherId !== userId && other.seat === id && present(other, now))
      return { seat: null, reason: 'occupied' };
  }
  return { seat: id, reason: null };
}

function voiceClientId(value) {
  return typeof value === "string" && /^[a-zA-Z0-9_-]{16,64}$/.test(value) ? value : null;
}

function nearbyPlayers(userId, sender, now) {
  return Array.from(players).filter(([id, player]) => id !== userId && present(player, now) &&
    Math.hypot(player.x - sender.x, player.z - sender.z) <= VOICE_DISTANCE);
}

function voiceMime(audio) {
  if (audio.toString("latin1", 0, 4) !== "RIFF") return sniffVoiceMime(audio);
  // Le format de secours du client est du PCM mono signé, 12 kHz, 16 bits.
  if (audio.length < 46 || audio.length % 2 || audio.readUInt32LE(4) !== audio.length - 8 ||
      audio.toString("latin1", 8, 16) !== "WAVEfmt " || audio.readUInt32LE(16) !== 16 ||
      audio.readUInt16LE(20) !== 1 || audio.readUInt16LE(22) !== 1 ||
      audio.readUInt32LE(24) !== VOICE_WAV_RATE || audio.readUInt32LE(28) !== VOICE_WAV_RATE * 2 ||
      audio.readUInt16LE(32) !== 2 || audio.readUInt16LE(34) !== 16 ||
      audio.toString("latin1", 36, 40) !== "data" || audio.readUInt32LE(40) !== audio.length - 44) return null;
  return "audio/wav";
}

function ensureVoiceTable() {
  if (!voiceTableReady) {
    voiceTableReady = pool.query(
      "create table if not exists maf_world_voice_clips (" +
      "id uuid primary key, audio bytea not null, mime text not null, expires_at timestamptz not null)"
    ).catch(error => {
      voiceTableReady = null;
      throw error;
    });
  }
  return voiceTableReady;
}

async function pruneVoiceClips() {
  if (voiceCleanupBusy) return;
  voiceCleanupBusy = true;
  const now = Date.now();
  for (const [id, clip] of voiceClips) if (clip.expiresAt <= now) voiceClips.delete(id);
  try {
    await ensureVoiceTable();
    await pool.query("delete from maf_world_voice_clips where expires_at <= now()");
  } catch (error) {
    console.error("world voice cleanup :", error.message);
  } finally {
    voiceCleanupBusy = false;
  }
}

async function finishVoiceClips(userId, ids, client = null) {
  const deleted = [];
  for (const id of ids) {
    const clip = voiceClips.get(id);
    const owner = clip?.listeners.get(userId);
    if (owner === undefined || (client && owner !== null && owner !== client)) continue;
    clip.listeners.delete(userId);
    if (clip.listeners.size) continue;
    voiceClips.delete(id);
    deleted.push(id);
  }
  if (!deleted.length) return;
  try {
    await pool.query("delete from maf_world_voice_clips where id = any($1::uuid[])", [deleted]);
  } catch (error) {
    console.error("world voice delete :", error.message);
  }
}

function voiceInbox(userId, now, client) {
  const inbox = [];
  for (const [id, clip] of voiceClips) {
    const owner = clip.listeners.get(userId);
    if (clip.expiresAt <= now || (owner !== null && (!client || owner !== client))) continue;
    inbox.push({ id, name: clip.name, ms: clip.ms, at: clip.at });
    if (inbox.length >= 8) break;
  }
  return inbox;
}

function chatInbox(userId, now) {
  return Array.from(chatMessages.values())
    .filter(message => now - message.at < CHAT_TTL_MS && message.recipients.has(userId))
    .slice(-16)
    .map(({ id, authorId, name, text, at }) => ({ id, name, text, at, mine: authorId === userId }));
}

if (pool) {
  void pruneVoiceClips();
  setInterval(pruneVoiceClips, 15000).unref();
}

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
  for (const [id, message] of chatMessages) if (now - message.at >= CHAT_TTL_MS) chatMessages.delete(id);
}
setInterval(() => prune(), 15000).unref();

worldPresenceRouter.post("/chat", requireSession, (req, res) => {
  const userId = req.userId;
  const sender = players.get(userId);
  const now = Date.now();
  if (!present(sender, now)) return res.status(409).json({ error: "Rejoins World pour écrire dans le chat." });
  const text = typeof req.body?.text === "string" ? req.body.text.trim() : "";
  if (!text || text.length > CHAT_MAX_LENGTH) {
    return res.status(400).json({ error: "Écris un message de 1 à 160 caractères." });
  }
  if (now - (sender.chatSentAt || 0) < 750) {
    return res.status(429).json({ error: "Attends un instant avant le prochain message." });
  }
  const recipients = new Set(nearbyPlayers(userId, sender, now).filter(([, player]) => player.chat).map(([id]) => id));
  const count = recipients.size;
  if (!count) return res.json({ count });
  recipients.add(userId);
  const id = randomUUID();
  chatMessages.set(id, { id, authorId: userId, name: sender.name || "Joueur", text, at: now, recipients });
  if (chatMessages.size > CHAT_LIMIT) chatMessages.delete(chatMessages.keys().next().value);
  sender.chatSentAt = now;
  res.json({ count });
});

worldPresenceRouter.post("/voice", requireSession, async (req, res) => {
  const sender = players.get(req.userId);
  const now = Date.now();
  if (!present(sender, now)) return res.status(409).json({ error: "Rejoins World avant d’envoyer un vocal." });
  const { audio: encoded, ms } = req.body || {};
  if (!Number.isInteger(ms) || ms < 300 || ms > VOICE_MAX_MS || typeof encoded !== "string" ||
      encoded.length > Math.ceil(VOICE_MAX_BYTES / 3) * 4 || encoded.length % 4 ||
      !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) {
    return res.status(400).json({ error: "Vocal invalide ou trop long." });
  }
  const audio = Buffer.from(encoded, "base64");
  const mime = voiceMime(audio);
  if (!mime || audio.length > VOICE_MAX_BYTES) {
    return res.status(400).json({ error: "Format audio non reconnu ou vocal trop lourd." });
  }

  const listeners = new Map(nearbyPlayers(req.userId, sender, now)
    .filter(([, player]) => player.voice).map(([id]) => [id, null]));
  if (!listeners.size) return res.json({ count: 0 });
  if (sender.voiceUploading || now - (sender.voiceSentAt || 0) < 1500 ||
      voiceClips.size + voiceUploads >= VOICE_LIMIT) {
    return res.status(429).json({ error: "Attends un instant avant un autre vocal." });
  }

  const id = randomUUID();
  const expiresAt = now + VOICE_TTL_MS;
  voiceUploads++;
  sender.voiceUploading = true;
  try {
    await ensureVoiceTable();
    await pool.query(
      "insert into maf_world_voice_clips (id, audio, mime, expires_at) values ($1, $2, $3, $4)",
      [id, audio, mime, new Date(expiresAt)]
    );
    for (const userId of listeners.keys()) {
      const player = players.get(userId);
      if (!present(player, Date.now()) || !player.voice) listeners.delete(userId);
    }
    if (listeners.size) {
      voiceClips.set(id, { expiresAt, listeners, name: sender.name || "Joueur", ms, at: now });
      sender.voiceSentAt = now;
    } else {
      await pool.query("delete from maf_world_voice_clips where id = $1", [id]);
    }
    res.json({ count: listeners.size, id, at: now });
  } catch (error) {
    console.error("world voice send :", error.message);
    res.status(500).json({ error: "Impossible d’envoyer le vocal." });
  } finally {
    sender.voiceUploading = false;
    voiceUploads--;
  }
});

worldPresenceRouter.post("/voice/:id/listen", requireSession, async (req, res) => {
  const { id } = req.params;
  const clip = voiceClips.get(id);
  const client = voiceClientId(req.body?.voiceClient);
  const previous = clip?.listeners.get(req.userId);
  if (!clip || clip.expiresAt <= Date.now() || (previous !== null && (!client || previous !== client))) {
    return res.status(404).end();
  }
  const owner = client || "legacy";
  // La même page peut réessayer après une erreur. La fin d'écoute retire l'accès.
  clip.listeners.set(req.userId, owner);
  try {
    const { rows: [row] } = await pool.query(
      "select audio, mime from maf_world_voice_clips where id = $1 and expires_at > now()", [id]
    );
    if (!row || clip.listeners.get(req.userId) !== owner || clip.expiresAt <= Date.now()) {
      return res.status(404).end();
    }
    res.set({ "Content-Type": row.mime, "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" });
    res.send(row.audio);
  } catch (error) {
    if (previous === null && clip.listeners.get(req.userId) === owner) clip.listeners.set(req.userId, null);
    console.error("world voice listen :", error.message);
    res.status(500).end();
  }
});

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

// MAF-FOOD-V1. Energie sauvegardee en PostgreSQL, independante des FPS et de la session.
// Au premier acces chaque compte demarre a 40; 100 points se vident en 24 h reelles.
let energyTableReady;
async function ensureEnergyTable() {
  if (!energyTableReady) energyTableReady = pool.query(
    `CREATE TABLE IF NOT EXISTS maf_world_energy (
       user_id integer PRIMARY KEY REFERENCES maf_users(id) ON DELETE CASCADE,
       energy double precision NOT NULL DEFAULT 40 CHECK (energy >= 0 AND energy <= 100),
       updated_at timestamptz NOT NULL DEFAULT now(),
       last_meal_at timestamptz)`
  ).catch(error => { energyTableReady = null; throw error; });
  await energyTableReady;
}
const ENERGY_PER_SECOND = 100 / 86400;
function energyNow(row) {
  return Math.max(0, Math.min(100, Number(row.energy) -
    Math.max(0, (Date.now() - new Date(row.updated_at).getTime()) / 1000) * ENERGY_PER_SECOND));
}
worldPresenceRouter.get('/energy', requireSession, async (req, res) => {
  try {
    await ensureEnergyTable();
    await pool.query('INSERT INTO maf_world_energy(user_id) VALUES ($1) ON CONFLICT DO NOTHING', [req.userId]);
    const row = (await pool.query('SELECT energy, updated_at FROM maf_world_energy WHERE user_id=$1', [req.userId])).rows[0];
    if (!row) return res.status(404).json({ error: 'Compte introuvable' });
    return res.set('Cache-Control', 'no-store').json({ energy: energyNow(row), max: 100 });
  } catch (error) { console.error('world energy:', error.message); return res.status(503).json({ error: 'Energie indisponible' }); }
});
worldPresenceRouter.post('/eat', requireSession, async (req, res) => {
  const p = players.get(req.userId);
  // Les caisses sont x=-3.26/-1.4/0.46, z=9.2 dans le GLB :
  // les clients se tiennent devant, vers z=11.4.
  const fx = -86 - 1.5 * .75, fz = -300 + 11.4 * .75;
  const lx = p && (p.x + 86) / .75, lz = p && (p.z + 300) / .75;
  if (!present(p, Date.now()) || p.veh ||
      lx <= -5.6 || lx >= 8.8 || lz <= 8.8 || lz >= 17 ||
      Math.hypot(p.x - fx, p.z - fz) > 4.4) {
    return res.status(403).json({ error: 'Approche-toi des caisses du fastfood pour manger.' });
  }
  try {
    await ensureEnergyTable();
    // UPSERT atomique : deux clics simultanes ne peuvent crediter deux repas.
    const sql = `INSERT INTO maf_world_energy(user_id, energy, updated_at, last_meal_at)
      VALUES ($1, 90, now(), now())
      ON CONFLICT (user_id) DO UPDATE SET
      energy = LEAST(100, GREATEST(0, maf_world_energy.energy -
        GREATEST(0, EXTRACT(EPOCH FROM (now() - maf_world_energy.updated_at))) * (100.0/86400)) + 50),
      updated_at = now(), last_meal_at = now()
      WHERE maf_world_energy.last_meal_at IS NULL OR
            maf_world_energy.last_meal_at < now() - interval '2 seconds'
      RETURNING energy`;
    const row = (await pool.query(sql, [req.userId])).rows[0];
    if (!row) return res.status(429).json({ error: 'Attends 2 secondes avant le repas suivant.' });
    return res.set('Cache-Control', 'no-store').json({ energy: Number(row.energy), max: 100, gained: 50 });
  } catch (error) { console.error('world eat:', error.message); return res.status(503).json({ error: 'Repas indisponible' }); }
});

worldPresenceRouter.post("/presence", requireSession, async (req, res) => {
  const userId = req.userId;
  const now = Date.now();
  const b = req.body || {};
  const client = voiceClientId(b.voiceClient);
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
    const seatClaim = !p.veh && b.seat != null ? claimVillaSeat(userId, b.seat, x, z, now) : null;
    p.seat = seatClaim?.seat ?? null;
    p.seatError = seatClaim?.reason ?? null;
    if (p.seat) p.mv = 0; // pas d'ejection pour une vitesse residuelle transmise
    p.chat = Boolean(client);
    p.voice = p.chat || b.voice === true;
    p.t = now;
  }
  // La position du vehicule est toujours liee au compte authentifie.
  // Sauvegarde en base UNIQUEMENT apres stationnement, jamais a chaque image.
  const car=parkedPayload(b.car,p);
  if (car) {
    try { await updateParkedCar(userId,car,!!p.veh); }
    catch(error) { console.error('world parked cars:',error.message); }
  } else if (b.wantParked === true) {
    // Les visiteurs sans voiture doivent eux aussi retrouver les parkings en base.
    try { await ensureParkedCars(); }
    catch(error) { console.error('world parked cars load:',error.message); }
  }
  try {
    await refreshIdentity(userId, p);
  } catch (error) {
    console.error("world presence :", error.message);
  }
  if (Array.isArray(b.voiceDone) && b.voiceDone.length) {
    await finishVoiceClips(userId, b.voiceDone.slice(0, 16), client);
  }
  p.carId = await usableCar(userId, b.carId);   // seule une voiture reellement possedee est relayee aux autres
  const out = [];
  let onlineCount = 0;
  for (const [id, q] of players) {
    if (!present(q, now)) continue;
    onlineCount++;
    if (id === userId || !q.name || out.length >= MAX_RETURN) continue;
    out.push({
      id, name: q.name, skin: q.skin, status: q.status,
      x: Math.round(q.x * 100) / 100, z: Math.round(q.z * 100) / 100,
      yaw: Math.round(q.yaw * 1000) / 1000, mv: q.mv, veh: q.veh, seat: q.seat ?? null, carId: q.carId || "porsche-911-gt3-rs",
    });
  }
  res.json({
    me: { id: userId, name: p.name, skin: p.skin, status: p.status, statusVersion: p.statusVersion,
      seat: p.seat ?? null, seatError: p.seatError ?? null },
    players: out, onlineCount,
    parkedCars: b.wantParked === true ? Array.from(parkedCars,([id,c])=>({id,...c})).slice(0,500) : undefined,
    voices: p.voice ? voiceInbox(userId, now, client) : [],
    chat: client ? chatInbox(userId, now) : []
  });
});

worldPresenceRouter.post("/leave", requireSession, async (req, res) => {
  players.delete(req.userId);
  await finishVoiceClips(req.userId, voiceClips.keys());
  res.json({ ok: true });
});
