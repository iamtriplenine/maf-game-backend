// MAF-MISS-V1 (v2) : concours Miss (votes). Tables miss_* separees de celles du jeu (maf_*).
// Branchement minimal : candidates, votant, demande de vote (en attente de validation), commentaires, ping.
import { Router } from "express";
import { pool } from "./db.js";

export const missRouter = Router();

// ---------- tables creees au premier appel (comme les autres modules) ----------
let ready = null;
export function ensureTables() {
  if (!ready) ready = (async () => {
    await pool.query(`CREATE TABLE IF NOT EXISTS miss_candidates (
      id serial PRIMARY KEY, numero integer NOT NULL UNIQUE, nom text NOT NULL, description text,
      photo_url text, photo_url2 text, photo_url3 text,
      votes integer NOT NULL DEFAULT 0, created_at timestamptz NOT NULL DEFAULT now())`);
    await pool.query(`CREATE TABLE IF NOT EXISTS miss_voters (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), telephone text UNIQUE, email text UNIQUE,
      a_paye_premier_vote boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL DEFAULT now(),
      CHECK (telephone IS NOT NULL OR email IS NOT NULL))`);
    await pool.query(`CREATE TABLE IF NOT EXISTS miss_vote_requests (
      id serial PRIMARY KEY, voter_id uuid NOT NULL REFERENCES miss_voters(id) ON DELETE CASCADE,
      candidate_numero integer NOT NULL REFERENCES miss_candidates(numero),
      nombre_votes integer NOT NULL CHECK (nombre_votes BETWEEN 1 AND 1000),
      montant integer NOT NULL CHECK (montant > 0), transaction_id text NOT NULL UNIQUE,
      statut text NOT NULL DEFAULT 'en_attente' CHECK (statut IN ('en_attente','valide','refuse')),
      created_at timestamptz NOT NULL DEFAULT now())`);
    await pool.query(`CREATE TABLE IF NOT EXISTS miss_comments (
      id serial PRIMARY KEY, nom text NOT NULL, message text NOT NULL, created_at timestamptz NOT NULL DEFAULT now())`);
    await pool.query(`CREATE TABLE IF NOT EXISTS miss_photos (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), mime text NOT NULL, data bytea NOT NULL, created_at timestamptz NOT NULL DEFAULT now())`);
    await pool.query(`CREATE TABLE IF NOT EXISTS miss_vote_adjustments (
      id serial PRIMARY KEY, candidate_numero integer NOT NULL, candidate_nom text NOT NULL, avant integer NOT NULL, apres integer NOT NULL,
      raison text, created_at timestamptz NOT NULL DEFAULT now())`);
  })().catch((e) => { ready = null; throw e; });
  return ready;
}

export const fail = (res, code, message) => res.status(code).json({ success: false, message });
export const wrap = (fn) => async (req, res) => {
  try {
    if (!pool) return fail(res, 503, "Base de donnees non configuree.");
    await ensureTables();
    await fn(req, res);
  } catch (e) { console.error("miss :", e.message); fail(res, 500, "Erreur serveur."); }
};

// Limite douce par adresse (le serveur est derriere le proxy Render : req.ip est fiable).
const hits = new Map();
const limit = (name, max, windowMs = 60000) => (req, res, next) => {
  const key = name + "|" + req.ip, now = Date.now(), h = hits.get(key);
  if (!h || now - h.t > windowMs) { hits.set(key, { n: 1, t: now }); return next(); }
  if (++h.n > max) return fail(res, 429, "Trop de requetes, reessaie dans une minute.");
  next();
};
setInterval(() => { const now = Date.now(); for (const [k, h] of hits) if (now - h.t > 120000) hits.delete(k); }, 60000).unref();

export const baseUrl = (req) => req.protocol + "://" + req.get("host");
// Une photo est soit une adresse https, soit "photo:<id>" (stockee en base) transformee en adresse complete.
export const photoUrl = (v, req) => (typeof v === "string" && v.startsWith("photo:") ? baseUrl(req) + "/api/miss/photos/" + v.slice(6) : v);
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TXN = /^[A-Za-z]_[A-Za-z0-9]{3,6}-?[A-Za-z0-9]{6,}$/;   // meme format que le site
export const text = (v, max) => (typeof v === "string" ? v.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max) : "");
const phone = (v) => { if (typeof v !== "string") return null; const s = v.replace(/[\s.\-()]/g, ""); return /^\+?\d{8,15}$/.test(s) ? s : null; };
const email = (v) => { if (typeof v !== "string") return null; const s = v.trim().toLowerCase(); return s.length <= 120 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) ? s : null; };

// ---------- verification ----------
missRouter.get("/ping", wrap(async (_req, res) => {
  const tables = {};
  for (const n of ["candidates", "voters", "vote_requests", "comments"]) {
    tables[n] = Number((await pool.query(`SELECT count(*)::int AS n FROM miss_${n}`)).rows[0].n);
  }
  res.json({ ok: true, module: "miss", tables, admin_key_configuree: (process.env.MISS_ADMIN_KEY || "").length >= 16 });
}));

// ---------- candidates ----------
missRouter.get("/candidates", wrap(async (req, res) => {
  const r = await pool.query("SELECT id, numero, nom, description, photo_url, photo_url2, photo_url3, votes FROM miss_candidates ORDER BY numero");
  res.json({ candidates: r.rows.map((c) => ({ ...c, photo_url: photoUrl(c.photo_url, req), photo_url2: photoUrl(c.photo_url2, req), photo_url3: photoUrl(c.photo_url3, req) })) });
}));

// Photos envoyees depuis le panneau admin (stockees en base) : lecture publique, mise en cache longue.
missRouter.get("/photos/:id", wrap(async (req, res) => {
  if (!UUID.test(req.params.id)) return fail(res, 404, "Photo introuvable.");
  const r = await pool.query("SELECT mime, data FROM miss_photos WHERE id=$1", [req.params.id]);
  if (!r.rows[0]) return fail(res, 404, "Photo introuvable.");
  res.set({ "Content-Type": r.rows[0].mime, "Cache-Control": "public, max-age=31536000, immutable", "X-Content-Type-Options": "nosniff", "Cross-Origin-Resource-Policy": "cross-origin" });
  res.send(r.rows[0].data);
}));

// ---------- votant (sans mot de passe : seul l'identifiant aleatoire est renvoye) ----------
missRouter.post("/voter/login", limit("login", 20), wrap(async (req, res) => {
  const tel = phone(req.body?.telephone), mail = email(req.body?.email);
  if (!tel && !mail) return fail(res, 400, "Numero de telephone ou e-mail invalide.");
  const find = async () => {
    let row = tel ? (await pool.query("SELECT id, a_paye_premier_vote FROM miss_voters WHERE telephone=$1", [tel])).rows[0] : null;
    if (!row && mail) row = (await pool.query("SELECT id, a_paye_premier_vote FROM miss_voters WHERE email=$1", [mail])).rows[0];
    return row;
  };
  let row = await find();
  if (!row) {
    await pool.query("INSERT INTO miss_voters(telephone, email) VALUES($1,$2) ON CONFLICT DO NOTHING", [tel, mail]);
    row = await find();
  }
  if (!row) return fail(res, 409, "Ces coordonnees correspondent a deux comptes differents.");
  res.json({ success: true, voter: row });
}));

missRouter.get("/voter/:id", wrap(async (req, res) => {
  if (!UUID.test(req.params.id)) return fail(res, 404, "Votant introuvable");
  const r = await pool.query("SELECT id, a_paye_premier_vote FROM miss_voters WHERE id=$1", [req.params.id]);
  if (!r.rows[0]) return fail(res, 404, "Votant introuvable");
  res.json({ success: true, voter: r.rows[0] });
}));

// ---------- demande de vote : enregistree "en_attente" (validation plus tard, cote proprietaire) ----------
missRouter.post("/voter/demande-vote", limit("vote", 10), wrap(async (req, res) => {
  const b = req.body || {};
  const voterId = String(b.voter_id || "");
  if (!UUID.test(voterId)) return fail(res, 404, "Votant introuvable");
  const nb = Number(b.nombre_votes), numero = Number(b.candidate_numero), montant = Number(b.montant);
  const raw = String(b.transaction_id || "").replace(/\s/g, "");
  if (!Number.isInteger(nb) || nb < 1 || nb > 1000 || !Number.isInteger(numero) || !Number.isInteger(montant)) return fail(res, 400, "Demande invalide.");
  if (!TXN.test(raw) || raw.length > 64) return fail(res, 400, "Reference de transaction invalide.");
  const tid = raw.toUpperCase().replace(/-/g, "");   // majuscules + sans tiret : une meme reference ne passe pas deux fois
  const v = (await pool.query("SELECT id, a_paye_premier_vote FROM miss_voters WHERE id=$1", [voterId])).rows[0];
  if (!v) return fail(res, 404, "Votant introuvable");
  if (!v.a_paye_premier_vote && nb !== 1) return fail(res, 400, "Le premier vote compte pour 1 vote (100 FCFA).");
  if (montant !== (v.a_paye_premier_vote ? nb * 25 : 100)) return fail(res, 400, "Montant incorrect.");
  if (!(await pool.query("SELECT 1 FROM miss_candidates WHERE numero=$1", [numero])).rowCount) return fail(res, 404, "Candidate introuvable.");
  try {
    await pool.query("INSERT INTO miss_vote_requests(voter_id, candidate_numero, nombre_votes, montant, transaction_id) VALUES($1,$2,$3,$4,$5)",
      [voterId, numero, nb, montant, tid]);
  } catch (e) {
    if (e.code === "23505") return fail(res, 409, "Cette reference de transaction a deja ete soumise.");
    throw e;
  }
  res.json({ success: true });
}));

// ---------- commentaires ----------
missRouter.get("/comments", wrap(async (_req, res) => {
  const r = await pool.query("SELECT nom, message, created_at FROM miss_comments ORDER BY id DESC LIMIT 100");
  res.json({ comments: r.rows });
}));

missRouter.post("/comments", limit("comment", 5), wrap(async (req, res) => {
  const nom = text(req.body?.nom, 40), message = text(req.body?.message, 300);
  if (!nom || !message) return fail(res, 400, "Nom et commentaire obligatoires.");
  await pool.query("INSERT INTO miss_comments(nom, message) VALUES($1,$2)", [nom, message]);
  res.json({ success: true });
}));
