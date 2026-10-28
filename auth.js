// Comptes MAF : pseudo + code a 10 chiffres (pas de mot de passe).
// Routes : POST /api/register, POST /api/login, GET /api/me
import { studioSkin } from './studioSkinCatalog.js';
import { isAllowedProfileBackground, publicProfileBackground } from './profileBackgroundCatalog.js';
import { ensureProfileBackgroundAccess, backgroundIsUnlocked } from './profileBackgroundAccess.js';
import crypto from "node:crypto";
import { promisify } from "node:util";
import { Router } from "express";
import { pool } from "./db.js";
import { ensureClientIds } from "./clientIds.js";

const scrypt = promisify(crypto.scrypt);

// Cle de signature des sessions. Sur Render, tu peux definir TOKEN_SECRET (phrase longue au hasard).
// Sans elle, on en derive une de DATABASE_URL (stable entre les redemarrages).
const SECRET =
  process.env.TOKEN_SECRET ||
  crypto.createHash("sha256").update("maf|" + (process.env.DATABASE_URL || "dev")).digest("hex");
const SESSION_DAYS = 90;

const PSEUDO_RE = /^[\p{L}\p{N}@._\-#$!*+]{3,20}$/u;
const CODE_RE = /^\d{10}$/;

// ---------- table creee automatiquement au premier appel ----------
let tableReady = null;
export function ensureTable() {
  if (!tableReady) {
    tableReady = pool
      .query(
        `create table if not exists maf_users (
           id serial primary key,
           pseudo text not null,
           pseudo_key text not null unique,
           code_salt text not null,
           code_hash text not null,
           phone text,
           balance integer not null default 0,
           created_at timestamptz not null default now()
         )`
      )
      .then(() => pool.query(
        "alter table maf_users add column if not exists skin_id text not null default 'loki'"
      ))
      .then(() => pool.query(
        "alter table maf_users add column if not exists profile_background_id text not null default 'classic'"
      ))
      .then(() => ensureClientIds(pool))
      .then(() => ensureProfileBackgroundAccess())
      .catch((error) => {
        tableReady = null;
        throw error;
      });
  }
  return tableReady;
}

// ---------- sessions signees (sans dependance) ----------
const b64 = (value) => Buffer.from(value).toString("base64url");
const sign = (data) => crypto.createHmac("sha256", SECRET).update(data).digest("base64url");

function makeToken(userId) {
  const payload = b64(JSON.stringify({ uid: userId, exp: Date.now() + SESSION_DAYS * 864e5 }));
  return `${payload}.${sign(payload)}`;
}

export function readToken(token) {
  if (typeof token !== "string") return null;
  const [payload, signature] = token.split(".");
  if (!payload || !signature) return null;
  const expected = Buffer.from(sign(payload));
  const given = Buffer.from(signature);
  if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString());
    return data.exp > Date.now() ? data : null;
  } catch {
    return null;
  }
}

// ---------- hash du code ----------
async function hashCode(code, salt) {
  return (await scrypt(code, salt, 32)).toString("hex");
}

// ---------- anti force brute : 8 echecs / 10 min par IP + pseudo ----------
const failures = new Map();
const WINDOW = 10 * 60 * 1000;
const MAX_FAILS = 8;
const attemptKey = (req, pseudoKey) =>
  `${String(req.headers["x-forwarded-for"] || req.socket.remoteAddress).split(",")[0].trim()}|${pseudoKey}`;
function isBlocked(key) {
  const entry = failures.get(key);
  if (!entry) return false;
  if (Date.now() - entry.first > WINDOW) {
    failures.delete(key);
    return false;
  }
  return entry.count >= MAX_FAILS;
}
function addFailure(key) {
  const entry = failures.get(key);
  if (!entry || Date.now() - entry.first > WINDOW) failures.set(key, { first: Date.now(), count: 1 });
  else entry.count += 1;
}

export const publicUser = (row) => ({
  id: row.id, client_id: row.client_id, pseudo: row.pseudo, balance: row.balance,
  skin_id: row.skin_id || "loki",
  profile_background_id: publicProfileBackground(row.profile_background_id),
  bonus_balance: row.bonus_balance || 0, phone: row.phone || null,
  phone_registered_at: row.phone_registered_at || null,
  phone_verification_deadline: row.phone_verification_deadline || null,
  phone_verified_at: row.phone_verified_at || null,
});
const fail = (res, status, error) => res.status(status).json({ error });

function checkInput(body) {
  const pseudo = typeof body?.pseudo === "string" ? body.pseudo.trim() : "";
  const code = typeof body?.code === "string" ? body.code : "";
  if (!PSEUDO_RE.test(pseudo)) {
    return { error: "Pseudo invalide : 3 a 20 caracteres (lettres, chiffres, @ . _ - # $ ! * +)." };
  }
  if (!CODE_RE.test(code)) return { error: "Le code doit contenir exactement 10 chiffres." };
  return { pseudo, pseudoKey: pseudo.toLowerCase(), code };
}

export const authRouter = Router();

authRouter.use((_req, res, next) => {
  if (!pool) return fail(res, 503, "Base de donnees non configuree.");
  ensureTable().then(
    () => next(),
    (error) => {
      console.error("Table maf_users :", error.message);
      fail(res, 500, "Erreur base de donnees.");
    }
  );
});

authRouter.post("/register", async (req, res) => {
  const input = checkInput(req.body);
  if (input.error) return fail(res, 400, input.error);
  try {
    const salt = crypto.randomBytes(16).toString("hex");
    const hash = await hashCode(input.code, salt);
    const result = await pool.query(
      `insert into maf_users (pseudo, pseudo_key, code_salt, code_hash)
       values ($1, $2, $3, $4) returning *`,
      [input.pseudo, input.pseudoKey, salt, hash]
    );
    const user = publicUser(result.rows[0]);
    res.status(201).json({ token: makeToken(user.id), user });
  } catch (error) {
    if (error.code === "23505") return fail(res, 409, "Ce pseudo est deja pris, choisis-en un autre.");
    console.error("register :", error.message);
    fail(res, 500, "Erreur serveur, reessaie.");
  }
});

authRouter.post("/login", async (req, res) => {
  const input = checkInput(req.body);
  if (input.error) return fail(res, 400, input.error);
  const key = attemptKey(req, input.pseudoKey);
  if (isBlocked(key)) return fail(res, 429, "Trop d'essais. Reessaie dans quelques minutes.");
  try {
    const result = await pool.query("select * from maf_users where pseudo_key = $1", [input.pseudoKey]);
    const row = result.rows[0];
    // On calcule toujours un hash, pour ne pas reveler si le pseudo existe.
    const hash = await hashCode(input.code, row ? row.code_salt : "0".repeat(32));
    const ok =
      row &&
      crypto.timingSafeEqual(Buffer.from(hash, "hex"), Buffer.from(row.code_hash, "hex"));
    if (!ok) {
      addFailure(key);
      return fail(res, 401, "Pseudo ou code incorrect.");
    }
    failures.delete(key);
    const user = publicUser(row);
    res.json({ token: makeToken(user.id), user });
  } catch (error) {
    console.error("login :", error.message);
    fail(res, 500, "Erreur serveur, reessaie.");
  }
});

authRouter.get("/me", async (req, res) => {
  const auth = String(req.headers.authorization || "");
  const data = readToken(auth.startsWith("Bearer ") ? auth.slice(7) : "");
  if (!data) return fail(res, 401, "Session expiree.");
  try {
    const result = await pool.query("select * from maf_users where id = $1", [data.uid]);
    if (!result.rows[0]) return fail(res, 401, "Compte introuvable.");
    res.json({ user: publicUser(result.rows[0]) });
  } catch (error) {
    console.error("me :", error.message);
    fail(res, 500, "Erreur serveur, reessaie.");
  }
});

export function requireSession(req, res, next) {
  const auth = String(req.headers.authorization || "");
  const data = readToken(auth.startsWith("Bearer ") ? auth.slice(7) : "");
  if (!data || !Number.isSafeInteger(data.uid)) return res.status(401).json({ error: "Session expiree." });
  req.userId = data.uid;
  next();
}

// Fonds Studio 3D : Matrix accessible a tous, preference du compte.
authRouter.patch('/profile-background', requireSession, async (req, res) => {
  const backgroundId = req.body?.background_id;
  if (!isAllowedProfileBackground(backgroundId)) return fail(res, 400, 'Arriere-plan inconnu.');
  try {

    await ensureProfileBackgroundAccess();
    if (!await backgroundIsUnlocked(req.userId, backgroundId))
      return fail(res, 403, 'Ce decor doit etre debloque par un cadeau.');
    const result = await pool.query(
      'update maf_users set profile_background_id = $1 where id = $2 returning *',
      [backgroundId, req.userId]
    );
    if (!result.rows[0]) return fail(res, 401, 'Compte introuvable.');
    res.json({ user: publicUser(result.rows[0]) });
  } catch (error) {
    console.error('profile-background :', error.message);
    fail(res, 500, "Impossible d'enregistrer l'arriere-plan.");
  }
});

// Catalogue Studio 3D : les skins actuels restent publics. Les futurs exclusifs
// doivent appartenir au compte avant de pouvoir etre equipes.
const LEGACY_SKIN_IDS = { 'mutant-run':'mutant-swipe', 'mutant-attack':'mutant-swipe' };
authRouter.patch("/skin", requireSession, async (req, res) => {
  const requested = req.body?.skin_id;
  const skinId = LEGACY_SKIN_IDS[requested] || requested;
  const entry = typeof skinId==='string' ? studioSkin(skinId) : null;
  if (!entry) return fail(res, 400, 'Skin inconnu.');
  try {
    if(entry.access==='exclusive') {
      // Cette table est creee au lancement du module tournoi, et non par le client.
      const owned=await pool.query(`SELECT 1 FROM maf_studio_skin_unlocks
        WHERE user_id=$1 AND skin_id=$2 LIMIT 1`,[req.userId,skinId]);
      if(!owned.rowCount)return fail(res,403,'Ce skin est reserve aux gagnants et participants recompenses.');
    }
    const result = await pool.query(
      "update maf_users set skin_id = $1 where id = $2 returning *",
      [skinId, req.userId]
    );
    if (!result.rows[0]) return fail(res, 401, "Compte introuvable.");
    res.json({ user: publicUser(result.rows[0]) });
  } catch (error) {
    console.error("skin :", error.message);
    fail(res, 500, "Impossible d'enregistrer le skin.");
  }
});
